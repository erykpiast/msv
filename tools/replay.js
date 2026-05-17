#!/usr/bin/env node
'use strict';

// tools/replay.js — developer-only replay tool for ~/.msv/ideas/<id>/events.jsonl.
//
// Usage:
//   node tools/replay.js <id> [--tui=dashboard|log|debug] [--follow]
//
// Reads the events stream recorded by src/event_recorder.js and replays it
// through a fresh bus into one of the existing TUIs. The dashboard path
// composes its own ink root with a scrubber footer (tools/replay-scrubber.js)
// for interactive seeking; log/debug paths attach as in live runs and exit
// at EOF.
//
// This script intentionally lives outside the user-facing CLI: not in
// bin/msv, not in package.json's bin map, not in --help. It exists so
// dashboard iteration doesn't require a $3–8 real run per UI tweak.

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const React = require('react');
const { createBus } = require('../src/bus');
const { ideaDir, archivedIdeaDir } = require('../src/storage');
const { selectTui } = require('../src/tui');
const { setInk } = require('../src/tui/dashboard/inkExports');

const TAIL_POLL_MS = 200;
const FOLLOW_IDLE_QUIT_MS = 2000;

function parseArgs(argv) {
  const opts = { id: null, tui: 'dashboard', follow: false, help: false };
  for (const arg of argv) {
    if (arg === '--help' || arg === '-h') {
      opts.help = true;
    } else if (arg === '--follow') {
      opts.follow = true;
    } else if (arg.startsWith('--tui=')) {
      opts.tui = arg.slice('--tui='.length);
    } else if (!arg.startsWith('--') && !opts.id) {
      opts.id = arg;
    }
  }
  return opts;
}

function usage() {
  return [
    'Usage: node tools/replay.js <id> [--tui=dashboard|log|debug] [--follow]',
    '',
    'Replay a recorded msv run from ~/.msv/ideas/<id>/events.jsonl.',
    'Find <id> with: ls ~/.msv/ideas/',
    '',
    'Modes:',
    '  default           realtime playback of a completed run; arrow keys scrub.',
    '  --follow          tail-follow a live or completed file (no scrubber).',
    '',
    'TUIs:',
    '  --tui=dashboard   ink-based dashboard with scrubber (default).',
    '  --tui=log         line-oriented log mode with forward-only scrubber.',
    '  --tui=debug       raw JSON envelopes per line (no scrubber).',
    '',
    'Keybindings (dashboard + log modes):',
    '  ← / →             seek ±1 second of event-time (log mode: forward only)',
    '  Shift+← / →       seek ±10 seconds',
    '  Alt+← / →         seek ±1 event',
    '  space             pause / resume autoplay',
    '  q or Ctrl-C       quit',
    '',
    'Not part of the msv CLI. Developer-only.',
  ].join('\n');
}

// Resolve the events file: check ideas/ first, fall back to archive/.
async function resolveEventsPath(id) {
  const candidates = [
    path.join(ideaDir(id), 'events.jsonl'),
    path.join(archivedIdeaDir(id), 'events.jsonl'),
  ];
  for (const candidate of candidates) {
    try {
      await fsp.access(candidate, fs.constants.R_OK);
      return candidate;
    } catch (_err) {
      // try next
    }
  }
  return null;
}

function parseLines(text) {
  return text
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch (_err) {
        return null;
      }
    })
    .filter(Boolean);
}

async function loadJsonl(filePath) {
  const text = await fsp.readFile(filePath, 'utf8');
  return parseLines(text);
}

// Re-emit one captured envelope into the bus. Strips ts/name/idea_id; bus.emit
// re-injects those. The on-disk ts is used by the scrubber for scheduling
// and progress math, not for the envelope handed to listeners.
function emitFromEnvelope(bus, env) {
  const { name, ts, idea_id, ...payload } = env;
  bus.emit(name, payload);
}

// Tail a file: emit existing lines fast, then poll fs.stat for size growth
// and read new bytes. Resolves when the user signals exit OR the stop
// predicate fires.
function tailFollow(filePath, onLine, { onExit, isStopEvent }) {
  return new Promise((resolve, reject) => {
    let position = 0;
    let leftover = '';
    let lastChangeAt = Date.now();
    let stopSignalled = false;
    let timer = null;
    let cancelled = false;

    async function readChunk() {
      if (cancelled) return;
      let stat;
      try {
        stat = await fsp.stat(filePath);
      } catch (err) {
        return reject(err);
      }
      if (stat.size > position) {
        let handle = null;
        try {
          handle = await fsp.open(filePath, 'r');
          const length = stat.size - position;
          const buf = Buffer.alloc(length);
          await handle.read(buf, 0, length, position);
          position = stat.size;
          const chunk = leftover + buf.toString('utf8');
          const lines = chunk.split('\n');
          leftover = lines.pop() || '';
          for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed) continue;
            let env;
            try {
              env = JSON.parse(trimmed);
            } catch (_err) {
              continue;
            }
            onLine(env);
            if (isStopEvent && isStopEvent(env)) {
              stopSignalled = true;
              lastChangeAt = Date.now();
            }
          }
        } catch (err) {
          // Surface any open/read failure instead of silently freezing the
          // poll loop. The handle close in finally still runs.
          if (handle) await handle.close().catch(() => {});
          return reject(err);
        } finally {
          if (handle) await handle.close().catch(() => {});
        }
        lastChangeAt = Date.now();
      }
      if (stopSignalled && Date.now() - lastChangeAt >= FOLLOW_IDLE_QUIT_MS) {
        cancelled = true;
        resolve();
        return;
      }
      timer = setTimeout(readChunk, TAIL_POLL_MS);
    }

    if (onExit) {
      onExit(() => {
        cancelled = true;
        if (timer) clearTimeout(timer);
        resolve();
      });
    }

    readChunk();
  });
}

function waitForSigint() {
  return new Promise((resolve) => {
    let resolved = false;
    function onSigint() {
      if (resolved) return;
      resolved = true;
      process.off('SIGINT', onSigint);
      resolve();
    }
    process.on('SIGINT', onSigint);
  });
}

// Dashboard replay path: composes its own ink root with App + Scrubber.
async function replayDashboard({ filePath, ideaId, follow }) {
  const dashboardModule = require('../src/tui/dashboard');
  const { Scrubber } = require('./replay-scrubber');
  const ink = await import('ink');
  setInk(ink);

  const bus = createBus();
  bus.setIdea(ideaId);

  const wiring = dashboardModule.createDashboardWiring({ idea: { id: ideaId } });
  const off = bus.onAny(wiring.onEvent);

  function emitOne(env) {
    emitFromEnvelope(bus, env);
  }

  function appElement() {
    return React.createElement(dashboardModule.App, {
      initialState: wiring.getState(),
      registerSetState: wiring.makeRegister,
    });
  }

  if (follow) {
    const inst = ink.render(appElement());
    const sigintPromise = waitForSigint();
    let exitFollow = null;
    const followPromise = tailFollow(filePath, emitOne, {
      onExit: (cancel) => { exitFollow = cancel; },
      isStopEvent: (env) =>
        env.name === 'pipeline.complete' || env.name === 'pipeline.failed',
    });
    await Promise.race([
      sigintPromise.then(() => { if (exitFollow) exitFollow(); }),
      followPromise,
    ]);
    off();
    inst.unmount();
    await inst.waitUntilExit();
    return;
  }

  const events = await loadJsonl(filePath);
  if (events.length === 0) {
    process.stderr.write(`no events in ${filePath}\n`);
    process.exitCode = 1;
    off();
    return;
  }

  // Emit events[0] before mounting so the dashboard's initial render
  // reflects state at index 0; Scrubber's scheduler picks up from events[1].
  emitOne(events[0]);

  let inst = null;
  const onExit = () => { if (inst) inst.unmount(); };

  inst = ink.render(
    React.createElement(
      ink.Box,
      { flexDirection: 'column' },
      appElement(),
      React.createElement(Scrubber, {
        events,
        emitOne,
        reset: wiring.reset,
        onExit,
      })
    )
  );
  await inst.waitUntilExit();
  off();
}

// Log replay with scrubber. Mounts an ink tree where:
//  - <Static> renders each formatted log line as terminal scrollback;
//    once written, those rows don't re-render, so the user can scroll back.
//  - <Scrubber mode="log"> pins a footer with the bar + key hints. The
//    Scrubber's backward-seek path is disabled (mode='log') because stdout
//    text can't be un-printed; forward seeks + pause + step still work.
async function replayLog({ filePath, ideaId, follow }) {
  // Follow mode has no in-memory event array — the scrubber can't scrub a
  // tail. Fall through to the plain passthrough path.
  if (follow) {
    return replayPassthrough({ filePath, ideaId, tuiName: 'log', follow: true });
  }

  const { Scrubber } = require('./replay-scrubber');
  const { FORMATTERS } = require('../src/tui/log');
  const { sanitizeEnvelope } = require('../src/tui/sanitize');
  const ink = await import('ink');
  setInk(ink);

  const bus = createBus();
  bus.setIdea(ideaId);

  const events = await loadJsonl(filePath);
  if (events.length === 0) {
    process.stderr.write(`no events in ${filePath}\n`);
    process.exitCode = 1;
    return;
  }

  function emitOne(env) {
    emitFromEnvelope(bus, env);
  }

  // LogView subscribes to the bus itself. Lines accumulate in a ref so
  // bus events arriving during a render don't get lost; setItems triggers
  // <Static> to append the new rows. Mirroring live log TUI behaviour:
  // suppress api.* events (no --verbose-api flag at replay time yet).
  function LogView() {
    const { useState, useEffect, useRef } = React;
    const linesRef = useRef([]);
    const [items, setItems] = useState([]);

    useEffect(() => {
      function onEvent(env) {
        const safe = sanitizeEnvelope(env);
        if (!safe.name || safe.name.startsWith('api.')) return;
        const fmt = FORMATTERS[safe.name];
        if (!fmt) return;
        linesRef.current = [...linesRef.current, fmt(safe)];
        setItems(linesRef.current);
      }
      const unsub = bus.onAny(onEvent);
      // Emit events[0] now that we're subscribed; Scrubber's scheduler
      // takes over from events[1].
      emitOne(events[0]);
      return unsub;
    }, []);

    return React.createElement(
      ink.Static,
      { items },
      (text, idx) => React.createElement(ink.Text, { key: idx }, text)
    );
  }

  let inst = null;
  const onExit = () => { if (inst) inst.unmount(); };

  inst = ink.render(
    React.createElement(
      ink.Box,
      { flexDirection: 'column' },
      React.createElement(LogView),
      React.createElement(Scrubber, {
        events,
        emitOne,
        reset: () => {},
        onExit,
        mode: 'log',
      })
    )
  );
  await inst.waitUntilExit();
}

// Log/debug replay path: no scrubber, no ink composition. Reuses the
// existing TUI attach contract.
async function replayPassthrough({ filePath, ideaId, tuiName, follow }) {
  const tuiModule = selectTui({
    explicit: tuiName,
    isStdoutTty: !!process.stdout.isTTY,
    isStdinTty: !!process.stdin.isTTY,
  });
  const bus = createBus();
  bus.setIdea(ideaId);
  const tuiResult = await tuiModule.attach(bus, { idea: { id: ideaId } });
  const tuiCleanup = tuiResult.cleanup;

  try {
    if (follow) {
      let exitFollow = null;
      const sigintPromise = waitForSigint();
      const followPromise = tailFollow(filePath, (env) => emitFromEnvelope(bus, env), {
        onExit: (cancel) => { exitFollow = cancel; },
        isStopEvent: (env) =>
          env.name === 'pipeline.complete' || env.name === 'pipeline.failed',
      });
      await Promise.race([
        sigintPromise.then(() => { if (exitFollow) exitFollow(); }),
        followPromise,
      ]);
    } else {
      const events = await loadJsonl(filePath);
      if (events.length === 0) {
        process.stderr.write(`no events in ${filePath}\n`);
        process.exitCode = 1;
        return;
      }
      // Realtime: schedule each event at its original delta from events[0].ts.
      const start = events[0].ts;
      const playbackStart = Date.now();
      for (let i = 0; i < events.length; i += 1) {
        const target = events[i].ts - start;
        const elapsed = Date.now() - playbackStart;
        const delay = Math.max(0, target - elapsed);
        if (delay > 0) {
          // eslint-disable-next-line no-await-in-loop
          await new Promise((r) => setTimeout(r, delay));
        }
        emitFromEnvelope(bus, events[i]);
      }
    }
  } finally {
    await tuiCleanup();
  }
}

async function main(argv) {
  const opts = parseArgs(argv);
  if (opts.help || !opts.id) {
    process.stdout.write(`${usage()}\n`);
    if (!opts.id && !opts.help) {
      process.exitCode = 1;
    }
    return;
  }

  const filePath = await resolveEventsPath(opts.id);
  if (!filePath) {
    process.stderr.write(
      `events.jsonl not found for idea ${opts.id} (checked ideas/ and archive/)\n`
    );
    process.exitCode = 1;
    return;
  }

  const tui = opts.tui;
  if (tui === 'dashboard') {
    await replayDashboard({ filePath, ideaId: opts.id, follow: opts.follow });
  } else if (tui === 'log') {
    await replayLog({ filePath, ideaId: opts.id, follow: opts.follow });
  } else if (tui === 'debug' || tui === 'silent') {
    await replayPassthrough({ filePath, ideaId: opts.id, tuiName: tui, follow: opts.follow });
  } else {
    process.stderr.write(`unknown --tui=${tui}\n`);
    process.exitCode = 1;
  }
}

module.exports = {
  parseArgs,
  resolveEventsPath,
  loadJsonl,
  parseLines,
  tailFollow,
  emitFromEnvelope,
  replayLog,
  replayDashboard,
  replayPassthrough,
  main,
};

if (require.main === module) {
  main(process.argv.slice(2)).catch((err) => {
    process.stderr.write(`replay: ${err.stack || err.message || err}\n`);
    process.exitCode = 1;
  });
}
