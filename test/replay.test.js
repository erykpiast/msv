'use strict';

// Tests for tools/replay.js and tools/replay-scrubber.js. Covers the contract
// behind the dev replay workflow per spec §10.9 — pure scrubber logic is
// exercised directly; the React component is not mounted (we follow the
// same pattern as test/tui/dashboard.test.js, which tests the reducer only).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const fsSync = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createBus } = require('../src/bus');
const { attachRecorder } = require('../src/event_recorder');
const {
  parseArgs,
  parseLines,
  loadJsonl,
  tailFollow,
  resolveEventsPath,
  emitFromEnvelope,
} = require('../tools/replay');
const {
  classifyKey,
  seekByTime,
  seekByEvent,
  clampIndex,
  applySeekPure,
  handleToggle,
  renderBar,
  renderBars,
  computeDelay,
  DELTAS,
  FILLED,
  EMPTY,
} = require('../tools/replay-scrubber');

async function makeTmpDir() {
  return fs.mkdtemp(path.join(os.tmpdir(), 'msv-replay-'));
}

function mkEvents(spec) {
  // spec: [{ name, ts, ...payload }] → full envelopes
  return spec.map((e) => ({ idea_id: 'test', ...e }));
}

// ---------- CLI argument parsing -------------------------------------------

test('parseArgs picks up id + flags', () => {
  assert.deepEqual(parseArgs(['abc-123']), {
    id: 'abc-123', tui: 'dashboard', follow: false, help: false,
  });
  assert.deepEqual(parseArgs(['abc-123', '--follow']), {
    id: 'abc-123', tui: 'dashboard', follow: true, help: false,
  });
  assert.deepEqual(parseArgs(['--tui=log', 'abc']), {
    id: 'abc', tui: 'log', follow: false, help: false,
  });
  assert.equal(parseArgs(['--help']).help, true);
  assert.equal(parseArgs([]).id, null);
});

// ---------- File parsing ----------------------------------------------------

test('parseLines skips blanks and malformed lines', () => {
  const text = '{"name":"a","ts":1}\n\n{"name":"b","ts":2}\nnot-json\n';
  const out = parseLines(text);
  assert.equal(out.length, 2);
  assert.equal(out[0].name, 'a');
  assert.equal(out[1].name, 'b');
});

test('loadJsonl reads recorder-produced files', async () => {
  const tmp = await makeTmpDir();
  try {
    const fp = path.join(tmp, 'events.jsonl');
    const bus = createBus();
    bus.setIdea('idea-1');
    const cleanup = attachRecorder(bus, { idea: { id: 'idea-1' }, filePath: fp });
    bus.emit('pipeline.start', { raw_capture: 'hi' });
    bus.emit('wg.start', { territory_id: 't_001' });
    await cleanup();
    const events = await loadJsonl(fp);
    assert.equal(events.length, 2);
    assert.equal(events[0].name, 'pipeline.start');
    assert.equal(events[1].name, 'wg.start');
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

// ---------- Round-trip parity -----------------------------------------------

test('recorder → replay round-trip preserves names and payloads', async () => {
  const tmp = await makeTmpDir();
  try {
    const fp = path.join(tmp, 'events.jsonl');
    const bus1 = createBus();
    bus1.setIdea('idea-rt');
    const cleanup = attachRecorder(bus1, { idea: { id: 'idea-rt' }, filePath: fp });
    const originals = [
      ['pipeline.start', { raw_capture: 'topic', budget: { max: 100 } }],
      ['discovery.web_search.start', { query: 'rust async' }],
      ['wg.start', { territory_id: 't_001', territory_name: 'commercial' }],
      ['wg.researcher.web_fetch', { territory_id: 't_001', aligned_id: 'aq_001', url: 'https://ft.com/x' }],
      ['api.call.end', { call_id: 'c_1', outcome: 'ok', ms: 850, input_tokens: 1000, output_tokens: 200 }],
      ['pipeline.complete', { ok: true, used_executor_calls: 12, used_total_tokens: 50000, used_researcher_tool_calls: 3 }],
    ];
    for (const [name, payload] of originals) bus1.emit(name, payload);
    await cleanup();

    // Replay through a fresh bus and a recorder-like collector.
    const bus2 = createBus();
    bus2.setIdea('idea-rt');
    const received = [];
    bus2.onAny((env) => received.push(env));
    const events = await loadJsonl(fp);
    for (const env of events) emitFromEnvelope(bus2, env);

    assert.equal(received.length, originals.length);
    for (let i = 0; i < originals.length; i += 1) {
      const [name, payload] = originals[i];
      assert.equal(received[i].name, name);
      for (const key of Object.keys(payload)) {
        assert.deepEqual(received[i][key], payload[key]);
      }
    }
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

// ---------- resolveEventsPath ----------------------------------------------

// Helper for resolveEventsPath tests — both must isolate MSV_ROOT.
async function withTmpRoot(fn) {
  const tmpRoot = await makeTmpDir();
  const prev = process.env.MSV_ROOT;
  process.env.MSV_ROOT = tmpRoot;
  try {
    delete require.cache[require.resolve('../src/storage')];
    delete require.cache[require.resolve('../tools/replay')];
    const fresh = require('../tools/replay');
    await fn(tmpRoot, fresh);
  } finally {
    if (prev === undefined) delete process.env.MSV_ROOT;
    else process.env.MSV_ROOT = prev;
    delete require.cache[require.resolve('../src/storage')];
    delete require.cache[require.resolve('../tools/replay')];
    await fs.rm(tmpRoot, { recursive: true, force: true });
  }
}

test('resolveEventsPath returns null when missing', async () => {
  // Isolate MSV_ROOT so the test cannot collide with a real idea id on disk.
  await withTmpRoot(async (_root, { resolveEventsPath: resolve }) => {
    const result = await resolve('not-a-real-idea-id');
    assert.equal(result, null);
  });
});

test('resolveEventsPath finds an existing events.jsonl', async () => {
  await withTmpRoot(async (tmpRoot, { resolveEventsPath: resolve }) => {
    const id = 'idea-resolve-test';
    const dir = path.join(tmpRoot, 'ideas', id);
    await fs.mkdir(dir, { recursive: true });
    const fp = path.join(dir, 'events.jsonl');
    await fs.writeFile(fp, '{"name":"pipeline.start","ts":1}\n');
    const found = await resolve(id);
    assert.equal(found, fp);
  });
});

test('main() exits 1 with stderr mention of the id when events.jsonl is missing', async () => {
  await withTmpRoot(async (_root, { main }) => {
    const origWrite = process.stderr.write.bind(process.stderr);
    const captured = [];
    process.stderr.write = (chunk) => { captured.push(String(chunk)); return true; };
    const prevExit = process.exitCode;
    try {
      await main(['definitely-missing-id']);
      assert.equal(process.exitCode, 1);
      const stderr = captured.join('');
      assert.ok(stderr.includes('definitely-missing-id'), `stderr missing id: ${stderr}`);
      assert.ok(stderr.includes('events.jsonl'), `stderr missing events.jsonl: ${stderr}`);
    } finally {
      process.stderr.write = origWrite;
      process.exitCode = prevExit;
    }
  });
});

// ---------- tailFollow -----------------------------------------------------

test('tailFollow picks up appended lines', async () => {
  const tmp = await makeTmpDir();
  try {
    const fp = path.join(tmp, 'events.jsonl');
    await fs.writeFile(fp, '{"name":"pipeline.start","ts":1}\n{"name":"wg.start","ts":2}\n');
    const received = [];
    let exitFn = null;
    const followPromise = tailFollow(fp, (env) => received.push(env), {
      onExit: (cancel) => { exitFn = cancel; },
      isStopEvent: (env) => env.name === 'pipeline.complete',
    });
    // Append after a short delay to exercise the poll loop.
    setTimeout(async () => {
      await fs.appendFile(fp, '{"name":"wg.end","ts":3}\n{"name":"pipeline.complete","ts":4}\n');
    }, 50);
    // Cap the test with a forced exit if the stop predicate's idle wait
    // doesn't trigger (CI flake guard).
    const guard = setTimeout(() => { if (exitFn) exitFn(); }, 4000);
    await followPromise;
    clearTimeout(guard);
    assert.equal(received.length, 4);
    assert.deepEqual(
      received.map((e) => e.name),
      ['pipeline.start', 'wg.start', 'wg.end', 'pipeline.complete']
    );
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

// ---------- Scrubber: classifyKey ------------------------------------------

test('classifyKey maps every documented arrow modifier combination', () => {
  // Plain arrows → 1s seek
  assert.deepEqual(classifyKey('', { rightArrow: true }), { type: 'seek-time', delta: 1000 });
  assert.deepEqual(classifyKey('', { leftArrow: true }), { type: 'seek-time', delta: -1000 });
  // Shift+arrow → 10s seek
  assert.deepEqual(classifyKey('', { rightArrow: true, shift: true }), { type: 'seek-time', delta: 10000 });
  assert.deepEqual(classifyKey('', { leftArrow: true, shift: true }), { type: 'seek-time', delta: -10000 });
  // Meta/alt+arrow → 1 event seek
  assert.deepEqual(classifyKey('', { rightArrow: true, meta: true }), { type: 'seek-event', delta: 1 });
  assert.deepEqual(classifyKey('', { leftArrow: true, meta: true }), { type: 'seek-event', delta: -1 });
  // space → toggle
  assert.deepEqual(classifyKey(' ', {}), { type: 'toggle' });
  // q / Ctrl-C → quit
  assert.deepEqual(classifyKey('q', {}), { type: 'quit' });
  assert.deepEqual(classifyKey('c', { ctrl: true }), { type: 'quit' });
  // Unrelated keys → null
  assert.equal(classifyKey('x', {}), null);
  assert.equal(classifyKey('', { upArrow: true }), null);
});

test('classifyKey precedence: meta wins over shift', () => {
  // Both modifiers held simultaneously → meta semantics (1-event step).
  // Mirrors the spec's documented bindings table.
  assert.deepEqual(
    classifyKey('', { rightArrow: true, meta: true, shift: true }),
    { type: 'seek-event', delta: 1 }
  );
});

// ---------- Scrubber: seekByTime / seekByEvent / clamp ---------------------

test('seekByTime advances to first event with ts >= target', () => {
  const events = mkEvents([
    { name: 'a', ts: 0 },
    { name: 'b', ts: 500 },
    { name: 'c', ts: 1500 },
    { name: 'd', ts: 1500 },
    { name: 'e', ts: 3000 },
    { name: 'f', ts: 9500 },
  ]);
  assert.equal(seekByTime(events, 0, 1000), 2);
  // From index 2 (ts=1500), +1000 → first ts >= 2500 → index 4 (ts=3000).
  assert.equal(seekByTime(events, 2, 1000), 4);
  // From index 4 (ts=3000), -1500 → last ts <= 1500 → index 3 (ts=1500).
  assert.equal(seekByTime(events, 4, -1500), 3);
  // Clamp end / start.
  assert.equal(seekByTime(events, 5, 1000), 5);
  assert.equal(seekByTime(events, 0, -1000), 0);
});

test('seekByEvent clamps at boundaries', () => {
  const events = mkEvents(Array.from({ length: 10 }, (_, i) => ({ name: `e${i}`, ts: i })));
  assert.equal(seekByEvent(events, 5, -1), 4);
  assert.equal(seekByEvent(events, 5, 1), 6);
  assert.equal(seekByEvent(events, 5, 10), 9);
  assert.equal(seekByEvent(events, 5, -100), 0);
});

test('clampIndex handles empty + bounds', () => {
  assert.equal(clampIndex([], 5), 0);
  const evs = mkEvents([{ name: 'a', ts: 0 }, { name: 'b', ts: 1 }]);
  assert.equal(clampIndex(evs, -1), 0);
  assert.equal(clampIndex(evs, 5), 1);
  assert.equal(clampIndex(evs, 1), 1);
});

// ---------- Scrubber: renderBar / renderBars -------------------------------

test('renderBar produces filled+empty cells summing to width', () => {
  const w = 100;
  const bar40 = renderBar(w, 0.4);
  assert.equal(bar40.length, w);
  const filled = (bar40.match(new RegExp(FILLED, 'g')) || []).length;
  const empty = (bar40.match(new RegExp(EMPTY, 'g')) || []).length;
  assert.equal(filled, 40);
  assert.equal(empty, 60);
});

test('renderBar clamps ratio outside [0,1]', () => {
  assert.equal(renderBar(10, -0.5).split('').filter((c) => c === FILLED).length, 0);
  assert.equal(renderBar(10, 1.5).split('').filter((c) => c === EMPTY).length, 0);
});

test('renderBars produces time + event lines with consistent bar width', () => {
  const events = mkEvents([
    { name: 'a', ts: 0 },
    { name: 'b', ts: 1000 },
    { name: 'c', ts: 2000 },
    { name: 'd', ts: 3000 },
    { name: 'e', ts: 5000 },
  ]);
  const out = renderBars({ columns: 120, events, currentIndex: 2 });
  assert.ok(out.timeLine.includes(FILLED));
  assert.ok(out.eventLine.includes(FILLED));
  assert.equal(out.timeBarWidth, out.eventBarWidth);
  // Time ratio = 2000/5000 = 0.4; event ratio = 2/4 = 0.5.
  const timeFilled = (out.timeLine.match(new RegExp(FILLED, 'g')) || []).length;
  const eventFilled = (out.eventLine.match(new RegExp(FILLED, 'g')) || []).length;
  assert.equal(timeFilled, Math.floor(0.4 * out.timeBarWidth));
  assert.equal(eventFilled, Math.floor(0.5 * out.eventBarWidth));
});

test('renderBars recomputes width when terminal columns change', () => {
  const events = mkEvents([
    { name: 'a', ts: 0 },
    { name: 'b', ts: 1000 },
  ]);
  const narrow = renderBars({ columns: 80, events, currentIndex: 0 });
  const wide = renderBars({ columns: 160, events, currentIndex: 0 });
  assert.ok(wide.timeBarWidth > narrow.timeBarWidth);
});

test('renderBars line length never exceeds the terminal width at 100%', () => {
  // Regression: prior implementation reserved only ` (NN%)` (6 cols), so
  // at 100% the suffix ` (100%)` (7 cols) overflowed by one and wrapped.
  const events = mkEvents([
    { name: 'a', ts: 0 },
    { name: 'b', ts: 1000 },
    { name: 'c', ts: 2000 },
  ]);
  for (const columns of [80, 100, 120, 160]) {
    const out = renderBars({ columns, events, currentIndex: events.length - 1 });
    assert.ok(out.timeLine.length <= columns,
      `time line ${out.timeLine.length} > columns ${columns} at 100%: "${out.timeLine}"`);
    assert.ok(out.eventLine.length <= columns,
      `event line ${out.eventLine.length} > columns ${columns} at 100%: "${out.eventLine}"`);
    // And the suffix is the literal "(100%)".
    assert.ok(out.timeLine.endsWith('(100%)'), out.timeLine);
    assert.ok(out.eventLine.endsWith('(100%)'), out.eventLine);
  }
});

test('renderBars both bars are full at the last event', () => {
  // Endpoint pinning: at currentIndex = lastIndex, both ratios are 1.
  // Both bars must be entirely filled, no half-cells, no 99/100 drift.
  const events = mkEvents([
    { name: 'a', ts: 0 },
    { name: 'b', ts: 250 },
    { name: 'c', ts: 5000 },
  ]);
  const out = renderBars({ columns: 120, events, currentIndex: events.length - 1 });
  assert.equal(
    (out.timeLine.match(new RegExp(FILLED, 'g')) || []).length,
    out.timeBarWidth,
    'time bar must be entirely filled at the last event'
  );
  assert.equal(
    (out.eventLine.match(new RegExp(FILLED, 'g')) || []).length,
    out.eventBarWidth,
    'event bar must be entirely filled at the last event'
  );
});

test('renderBars both bars are empty at the first event', () => {
  const events = mkEvents([
    { name: 'a', ts: 100 },
    { name: 'b', ts: 200 },
    { name: 'c', ts: 300 },
  ]);
  const out = renderBars({ columns: 120, events, currentIndex: 0 });
  assert.equal((out.timeLine.match(new RegExp(FILLED, 'g')) || []).length, 0);
  assert.equal((out.eventLine.match(new RegExp(FILLED, 'g')) || []).length, 0);
  assert.ok(out.timeLine.endsWith('(  0%)'));
  assert.ok(out.eventLine.endsWith('(  0%)'));
});

test('renderBar forces full when rounded percentage is 100', () => {
  // ratio = 0.997 rounds to 100%; the bar must agree with the label and
  // render all FILLED cells, not 99/100.
  const bar = renderBar(100, 0.997);
  assert.equal((bar.match(new RegExp(FILLED, 'g')) || []).length, 100);
  assert.equal((bar.match(new RegExp(EMPTY, 'g')) || []).length, 0);
});

test('renderBar forces empty when rounded percentage is 0', () => {
  const bar = renderBar(100, 0.003);
  assert.equal((bar.match(new RegExp(FILLED, 'g')) || []).length, 0);
  assert.equal((bar.match(new RegExp(EMPTY, 'g')) || []).length, 100);
});

// ---------- Scrubber: computeDelay -----------------------------------------

test('computeDelay returns realtime gap relative to anchor wall clock', () => {
  const events = mkEvents([
    { name: 'a', ts: 1_000_000 },
    { name: 'b', ts: 1_000_100 },
    { name: 'c', ts: 1_000_250 },
  ]);
  // Anchor at index 0 at wall=t. now=t (zero elapsed) → next event needs 100ms.
  assert.equal(computeDelay(events, 0, 5000, 1, 5000), 100);
  // 50ms of wall has already elapsed → only 50 to wait.
  assert.equal(computeDelay(events, 0, 5000, 1, 5050), 50);
  // Wall has overshot the target → 0 (no negative delay).
  assert.equal(computeDelay(events, 0, 5000, 1, 5200), 0);
  // Anchored from index 1, next is index 2 (delta 150).
  assert.equal(computeDelay(events, 1, 6000, 2, 6000), 150);
  // Index past the array → 0.
  assert.equal(computeDelay(events, 0, 5000, 5, 5000), 0);
});

// ---------- DELTAS export sanity -------------------------------------------

test('DELTAS expose the documented seek magnitudes', () => {
  assert.equal(DELTAS.STEP_SEC, 1000);
  assert.equal(DELTAS.STEP_BIG_SEC, 10000);
  assert.equal(DELTAS.STEP_EVENT, 1);
});

// ---------- applySeekPure: seek + reset/refold contract -------------------

function mkSpies() {
  const calls = { reset: 0, emit: [] };
  return {
    calls,
    reset: () => { calls.reset += 1; },
    emitOne: (ev) => { calls.emit.push(ev); },
  };
}

test('applySeekPure: forward seek does not reset and emits delta events', () => {
  const events = mkEvents(Array.from({ length: 10 }, (_, i) => ({ name: `e${i}`, ts: i * 100 })));
  const spies = mkSpies();
  const next = applySeekPure(events, 2, 7, spies);
  assert.equal(next, 7);
  assert.equal(spies.calls.reset, 0, 'forward seek must not call reset');
  // Emitted events are exactly events[3..7] (5 events).
  assert.equal(spies.calls.emit.length, 5);
  assert.deepEqual(spies.calls.emit.map((e) => e.name), ['e3', 'e4', 'e5', 'e6', 'e7']);
});

test('applySeekPure: backward seek calls reset exactly once + refolds 0..target', () => {
  const events = mkEvents(Array.from({ length: 10 }, (_, i) => ({ name: `e${i}`, ts: i * 100 })));
  const spies = mkSpies();
  const next = applySeekPure(events, 8, 3, spies);
  assert.equal(next, 3);
  assert.equal(spies.calls.reset, 1, 'backward seek must call reset exactly once');
  // Re-emit events[0..3] inclusive (4 events).
  assert.equal(spies.calls.emit.length, 4);
  assert.deepEqual(spies.calls.emit.map((e) => e.name), ['e0', 'e1', 'e2', 'e3']);
});

test('applySeekPure: seek-to-current is a no-op (no reset, no emit)', () => {
  const events = mkEvents(Array.from({ length: 5 }, (_, i) => ({ name: `e${i}`, ts: i })));
  const spies = mkSpies();
  const next = applySeekPure(events, 3, 3, spies);
  assert.equal(next, 3);
  assert.equal(spies.calls.reset, 0);
  assert.equal(spies.calls.emit.length, 0);
});

test('applySeekPure: target clamps to valid range', () => {
  const events = mkEvents(Array.from({ length: 5 }, (_, i) => ({ name: `e${i}`, ts: i })));
  const spiesUp = mkSpies();
  assert.equal(applySeekPure(events, 1, 99, spiesUp), 4);
  assert.equal(spiesUp.calls.emit.length, 3); // events[2..4]
  const spiesDown = mkSpies();
  assert.equal(applySeekPure(events, 3, -99, spiesDown), 0);
  assert.equal(spiesDown.calls.reset, 1);
  assert.equal(spiesDown.calls.emit.length, 1); // events[0..0]
});

test('applySeekPure with allowBackward=false: backward seek is a no-op', () => {
  // Log mode: stdout text cannot be unprinted, so backward seeks clamp to prev.
  const events = mkEvents(Array.from({ length: 5 }, (_, i) => ({ name: `e${i}`, ts: i })));
  const spies = mkSpies();
  const next = applySeekPure(events, 3, 1, { ...spies, allowBackward: false });
  assert.equal(next, 3, 'backward seek must clamp to prev when disallowed');
  assert.equal(spies.calls.reset, 0, 'reset must not fire when backward is disallowed');
  assert.equal(spies.calls.emit.length, 0, 'no events must be re-emitted');
});

test('applySeekPure with allowBackward=false: forward seeks still work', () => {
  const events = mkEvents(Array.from({ length: 5 }, (_, i) => ({ name: `e${i}`, ts: i })));
  const spies = mkSpies();
  const next = applySeekPure(events, 1, 4, { ...spies, allowBackward: false });
  assert.equal(next, 4);
  assert.equal(spies.calls.emit.length, 3); // events[2..4]
});

// ---------- handleToggle: play/pause + end-of-stream guard ----------------

test('handleToggle: playing → paused', () => {
  assert.deepEqual(
    handleToggle({ playing: true, currentIndex: 5, lastIndex: 10 }),
    { playing: false }
  );
});

test('handleToggle: paused → playing when not at end', () => {
  assert.deepEqual(
    handleToggle({ playing: false, currentIndex: 5, lastIndex: 10 }),
    { playing: true }
  );
});

test('handleToggle: paused at end-of-stream stays paused (space is a no-op)', () => {
  // Spec §10.9: pressing space at events.length - 1 must not start the scheduler.
  assert.deepEqual(
    handleToggle({ playing: false, currentIndex: 10, lastIndex: 10 }),
    { playing: false }
  );
});

test('handleToggle: playing at end-of-stream still toggles to paused', () => {
  // Inverse direction is unaffected by the end-of-stream guard.
  assert.deepEqual(
    handleToggle({ playing: true, currentIndex: 10, lastIndex: 10 }),
    { playing: false }
  );
});

// ---------- Realtime scheduler order (via replayPassthrough timing) -------

test('replayPassthrough preserves event order under realtime scheduling', async () => {
  // Build a fixture with monotonic ts (the only invariant the recorder
  // produces) and replay through a debug TUI; assert the received names
  // come out in the same order. Real timers, but the gaps are tiny so the
  // test finishes in <20ms.
  const tmp = await makeTmpDir();
  try {
    const fp = path.join(tmp, 'events.jsonl');
    const lines = [
      { name: 'pipeline.start', ts: 100, raw_capture: 'topic' },
      { name: 'wg.start', ts: 105, territory_id: 't_001' },
      { name: 'wg.start', ts: 105, territory_id: 't_002' },
      { name: 'wg.end', ts: 110, territory_id: 't_001' },
      { name: 'pipeline.complete', ts: 115, ok: true },
    ];
    await fs.writeFile(fp, lines.map((l) => JSON.stringify(l)).join('\n') + '\n');

    const bus = createBus();
    bus.setIdea('test');
    const received = [];
    bus.onAny((env) => received.push(env.name));

    const events = await loadJsonl(fp);
    const start = events[0].ts;
    const playbackStart = Date.now();
    for (let i = 0; i < events.length; i += 1) {
      const target = events[i].ts - start;
      const elapsed = Date.now() - playbackStart;
      const delay = Math.max(0, target - elapsed);
      // eslint-disable-next-line no-await-in-loop
      if (delay > 0) await new Promise((r) => setTimeout(r, delay));
      // Use emitFromEnvelope so the test mirrors what replayPassthrough does.
      emitFromEnvelope(bus, events[i]);
    }

    assert.deepEqual(received, [
      'pipeline.start',
      'wg.start',
      'wg.start',
      'wg.end',
      'pipeline.complete',
    ]);
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});
