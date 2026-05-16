'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createBus } = require('../../src/bus');
const { attach } = require('../../src/tui/log');

function captureStdout(fn) {
  const chunks = [];
  const orig = process.stdout.write.bind(process.stdout);
  process.stdout.write = (chunk) => { chunks.push(String(chunk)); return true; };
  try {
    fn();
  } finally {
    process.stdout.write = orig;
  }
  return chunks.join('');
}

const CASES = [
  {
    event: { name: 'pipeline.start', idea_id: 'abc', raw_capture: 'topic' },
    expected: '[info] [pipeline] starting abc · topic',
  },
  {
    event: { name: 'pipeline.stage.start', stage: 'discovery', stage_index: 1, total_stages: 7 },
    expected: '[info] [discovery] stage 1/7 — discovery…',
  },
  {
    event: { name: 'pipeline.stage.heartbeat', stage: 'forum', seconds: 18 },
    expected: '[info] [pipeline] heartbeat · forum · 18s',
  },
  {
    event: {
      name: 'wg.end',
      territory_id: 't_001',
      aligned_count: 5,
      report_count: 5,
      observation_count: 12,
      claim_count: 3,
      terminated_by: 'mutual_concession',
    },
    expected: '[info] [t_001] wg.end · 5 aligned, 5 reports, 12 observations, 3 claims · mutual_concession',
  },
  {
    event: { name: 'coordinator.territories.emitted', count: 4, names: ['commercial', 'cognitive', 'regulatory', 'environmental'] },
    expected: '[info] [coordinator] done · 4 territories: commercial, cognitive, regulatory, environmental',
  },
  {
    event: { name: 'pipeline.complete', used_executor_calls: 68, used_total_tokens: 142000 },
    expected: '[info] [pipeline] complete · 68 calls · 142000 tokens',
  },
  {
    event: { name: 'pipeline.failed', stage: 'forum', error_message: 'boom' },
    expected: '[error] [pipeline] failed at forum: boom',
  },
  {
    event: { name: 'wg.researcher.turn', territory_id: 't_001', turn_index: 5, stop_reason: 'max_tokens', forced: true },
    expected: '[warn] [t_001] wg.researcher.turn 5 stop_reason=max_tokens forced=true',
  },
];

for (const { event, expected } of CASES) {
  test(`log formats ${event.name} correctly`, async () => {
    const bus = createBus();
    const cleanup = attach(bus);
    const out = captureStdout(() => bus.emit(event.name, event));
    await cleanup();
    assert.equal(out.trim(), expected);
  });
}

test('api.call.start is muted when verboseApi=false', async () => {
  const bus = createBus();
  const cleanup = attach(bus, { verboseApi: false });
  const out = captureStdout(() => bus.emit('api.call.start', { call_id: 1, model: 'claude-3' }));
  await cleanup();
  assert.equal(out, '');
});

test('api.call.start is rendered when verboseApi=true', async () => {
  const bus = createBus();
  const cleanup = attach(bus, { verboseApi: true });
  const out = captureStdout(() => bus.emit('api.call.start', { call_id: 1, model: 'claude-3' }));
  await cleanup();
  assert.ok(out.includes('call 1'));
  assert.ok(out.includes('claude-3'));
});

test('unknown events are silently ignored', async () => {
  const bus = createBus();
  const cleanup = attach(bus);
  const out = captureStdout(() => bus.emit('some.unknown.event', { foo: 'bar' }));
  await cleanup();
  assert.equal(out, '');
});
