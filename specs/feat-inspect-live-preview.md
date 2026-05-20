# `msv inspect` — Live Preview from a Running Pipeline

**Status:** Implemented (commit 14810b4)
**Author:** Eryk Napierała · 2026-05-18
**Related:**
- [`specs/feat-tui-event-decoupling.md`](feat-tui-event-decoupling.md) — defines the event bus, recorder, and TUI module shape this spec extends.
- [`specs/feat-pipeline-inspector-graph.md`](feat-pipeline-inspector-graph.md) — defines the inspector SPA whose graph nodes this spec animates.
- [`specs/feat-investigation-resumption.md`](feat-investigation-resumption.md) — defines partial-investigation rendering that this spec's mid-stage view must keep coherent with.
- [`specs/architecture.md`](architecture.md) — pipeline this spec observes.

---

## 1. Overview

`msv run <id>` and `msv inspect <id>` are two separate processes today. `msv run` streams the pipeline through the event bus into a TUI and persists `events.jsonl` and `inspect-view.json` to disk. `msv inspect` is a Vite dev server that serves a one-shot snapshot of `inspect-view.json` to the React SPA. The SPA reads the snapshot once on mount via `fetch('/inspect-view.json')` and never refreshes. To watch a run as it happens, the user has to either watch the TUI or re-run `msv inspect` to rebuild the snapshot.

This spec adds **live preview**: while `msv run` is executing, `msv inspect` reflects pipeline progress without a refresh. Stage nodes animate when they are in flight, in-progress drawer content shows skeleton loaders, and completed content appears the moment it is finalized.

The mechanism is push-based, intentionally trivial:

1. A new event sink (`src/event_relay.js`) attached alongside the existing recorder/TUI in `runOne`. It POSTs every bus envelope to `http://127.0.0.1:5180/events` with a 200 ms timeout. Failures are silently dropped — pipeline never blocks on the relay. In-flight POSTs at pipeline exit are abandoned (fetch promises don't keep the event loop alive once sockets close); the recorder has already persisted the same envelopes to `events.jsonl`, so we accept the live-channel loss.
2. New middlewares in the inspect dev server: `POST /events` accepts envelopes into an in-memory ring buffer, `GET /events/stream` is a Server-Sent Events endpoint that replays the buffer to new subscribers and streams every subsequent event.
3. On a debounce, the inspect server re-runs the existing `buildLoaderInput` + `buildView` against the idea's disk state and broadcasts a `view` SSE message with the fresh `InvestigationView`.
4. The SPA opens an `EventSource` on mount, holds both the latest view and a per-stage progress overlay derived from raw events, and applies CSS animations / skeleton renderers when an in-progress status is set.

The design is **dev-tool grade**, not production: in-memory state, single subscriber assumed but multi-subscriber tolerated, no auth, localhost-only, no replay protocol, no reconnection retries on the pipeline side beyond "best-effort POST per event."

If `msv inspect` is not running when `msv run` is executing, every POST fails fast and is dropped. The pipeline is unaffected. When `msv inspect` later starts up, it loads the existing `events.jsonl` once at startup, replays it into the ring buffer (so the SPA renders the run's current state), and resumes accepting fresh POSTs. The SPA can therefore connect at any point and reach a coherent view of the run-in-flight.

---

## 2. Status

Draft.

---

## 3. Authors

Eryk Napierała · 2026-05-18.

---

## 4. Background / Problem Statement

### What's broken about the current workflow

`msv inspect <id>` is the visual analogue of the dashboard TUI: a graph-based React SPA over the same investigation data. It produces a richer view than the TUI — fanned-out working groups, forum contradiction graph, leaf-level drawer content. The problem is that the SPA reflects a snapshot frozen at the moment the `msv inspect` command was invoked. To see new state, the user runs the command again, which rebuilds `inspect-view.json` from disk and re-opens the browser.

Two failure modes follow:

**1. The TUI and the inspector show different worlds.** During a live run the dashboard TUI advances through stages while the inspect SPA, opened earlier in another terminal, still shows the pre-run state. The user has to consciously stop trusting the open inspect window — it is silently stale.

**2. The graph view of in-flight pipelines is useless.** The very thing the pipeline-inspector-graph spec sells — pipeline architecture visible at first paint, drill-into-sub-canvas, leaf content in a drawer — is most valuable *while watching* a run, because that's when the architecture is unfolding and the reader wants to know "where are we now?" Today, the only live view is the TUI's stage list. The graph form is restricted to post-mortem.

### Why not just auto-refresh?

The SPA could poll `/inspect-view.json` every N seconds and re-render. Three reasons that's not enough:

* **Rebuild cost.** `buildLoaderInput` reads `index.json` and every JSONL under `logs/`, then `buildView` derives a few dozen sub-views. The pipeline's `inspect-view.json` is only re-written manually by `msv inspect` startup today; making it a hot path means either the pipeline rebuilds the view continuously (every event), or polling lags significantly.
* **No transient progress.** A poll sees only "stage done / stage not yet started" because the view-builder consumes finalized stage records, not "stage in progress." The interesting feedback during a live run is *what is currently happening* — researcher mid-query, working group mid-sub-stage. Polling a finalized-state file shows none of that.
* **Animations.** Smooth animations on stage transitions require *events*, not periodic re-snapshots. CSS animations triggered by a status change happen once, not on every poll re-render.

A push-based event stream gives the SPA both: instant transient progress for animations, and finalized-view replacement when stages complete.

### Why pipeline → inspect-server push (not file-tail)

`events.jsonl` already lives on disk. The inspect server could `fs.watch` it and broadcast changes. The user's brief explicitly asks for a push consumer; the file-tail option is recorded in §16 as the rejected alternative. Reasons to prefer push:

* **Latency.** Localhost POST is ~1 ms. `fs.watch` on macOS is FSEvents-coalesced and can lag ~50–200 ms.
* **Simpler server logic.** Accepting POSTs is one middleware. Tailing a JSONL file requires offset tracking, partial-line buffering, and rotation handling (we don't rotate today, but if we ever do, the broker breaks).
* **One source of truth in flight.** The recorder still writes `events.jsonl` for replay and post-hoc inspect. The relay is purely a live mirror; it does not add a new persistence layer.

### Audiences

The two audiences identified in [`feat-pipeline-inspector-graph.md` §4](feat-pipeline-inspector-graph.md) — pipeline debugging and investigation reading — both benefit:

* **Pipeline debugging.** Watching a researcher loop in real time tells you whether the query reformulation logic is doing anything useful before the run completes ~3 minutes later. Today this lives in the TUI's recent-events tail; the graph view shows it spatially.
* **Investigation reading.** A reader watching a run unfold sees the architecture animate — discovery emits personas, coordinator fans out to working groups, working groups light up in parallel — which makes the pipeline's shape vastly more legible than a static post-mortem.

---

## 5. Goals

* **The inspect SPA reflects pipeline state during a run, without refresh.** Stage transitions, working-group sub-stage advancement, and leaf content additions appear in the open browser tab within ~200 ms of the bus event.
* **Animations on in-progress stages.** Every stage node in `TopLevelCanvas` and every sub-stage node in `WorkingGroupCanvas` has an `in_progress` visual state (pulsing border, spinner overlay). The state is driven by the event stream, not view rebuilds.
* **Skeleton loaders for in-progress drawer content.** When a leaf (a debate move, a researcher report, a synthesis section) is being produced, the drawer shows a skeleton placeholder. When the leaf finalizes, the placeholder swaps for the rendered content.
* **Pipeline tolerates absent inspect server.** `msv run <id>` is unaffected when `msv inspect` is not running. The relay sink POSTs with a short timeout, drops failures, and adds no measurable latency to bus emission.
* **Inspect server tolerates absent pipeline.** `msv inspect <id>` with no `msv run` active works exactly as today — initial snapshot from disk, no SSE activity, no errors.
* **Inspect can start mid-run.** Starting `msv inspect <id>` while `msv run <id>` is in flight produces a coherent view: the SPA renders the work completed so far (from disk replay) and animates the in-progress stage (from live SSE).
* **One idea per inspect server.** Mismatched events (different `idea_id`) are dropped at the POST endpoint. No multi-idea aggregation.
* **No protocol versioning, no auth, no TLS.** Localhost only. Loopback bind. Single-developer single-machine tool.
* **Reuse the event vocabulary defined in `feat-tui-event-decoupling.md`.** No new event names. The progress overlay derives its state from existing `pipeline.stage.start/end`, `wg.*.start/done`, `wg.researcher.*`, `api.*` envelopes.
* **Reuse `buildLoaderInput` + `buildView`.** No client-side mirror of the view builder. Snapshot regeneration happens server-side and is broadcast as JSON.
* **No new runtime dependencies.** The relay uses Node's built-in `http`/`undici`; the SPA uses the browser's built-in `EventSource`. Mantine and React Flow already support the animation primitives (`@keyframes`, conditional class names, `<Skeleton />`).
* **Single command, no new flag.** `msv inspect <id>` automatically becomes live-aware. No `--live` opt-in. (The relay is also unconditional on the pipeline side.)

---

## 6. Non-Goals

* **No production hardening.** No TLS, no auth, no rate limiting, no CORS allowlist beyond `127.0.0.1`, no input sanitization beyond JSON parsing. This is a dev tool.
* **No multi-idea inspect server.** One inspect process serves one idea; events for other ideas are dropped.
* **No reconnect/retry queue on the relay.** A failed POST is dropped, period. The recorder persists everything to disk; missed envelopes are recovered next time the inspect server reads `events.jsonl`.
* **No SSE reconnect logic beyond the browser default.** `EventSource` reconnects on its own; we don't customize backoff. If the inspect server dies, the SPA shows a stale view (last frame) until it's restarted.
* **No new event names.** The vocabulary established in [`feat-tui-event-decoupling.md` §8.1](feat-tui-event-decoupling.md) is sufficient. No `view.refreshed`, no `progress.update` envelopes on the bus.
* **No client-side reducer mirroring `buildView`.** The SPA does *not* reconstruct `InvestigationView` from events. The server rebuilds and pushes the view; the SPA composes that view with a small progress overlay.
* **No replay support in the live channel.** `tools/replay.js` is the development replay path; it operates on disk, not via the inspect server's SSE. Live preview is for actual live runs only.
* **No animation framework.** CSS `@keyframes` only. No Framer Motion, no Spring, no GSAP. Mantine's `Skeleton` for skeletons.
* **No "watch this leaf" workflows.** The drawer doesn't subscribe to a specific leaf; it re-renders when the view updates and gets the new content for free.
* **No streaming-token preview for in-flight LLM calls.** The Anthropic SDK streams tokens; the bus emits one envelope per call (`api.call.start`, `api.call.end`). Sub-call token streaming is out of scope for v1.
* **No history scrubber in the SPA.** The dashboard replay tool has one; the inspect SPA shows current state only.
* **No event compaction.** The ring buffer caps total events at 10 000 (enough for a single run); when exceeded, oldest events are dropped, and the next `view` rebuild from disk re-establishes ground truth.
* **No persistence of relay state.** The inspect server's ring buffer is in-memory only. Restarting the inspect server re-reads `events.jsonl`.
* **No bidirectional communication.** SSE only. The SPA cannot send commands back to the pipeline.
* **No cross-process locking.** Two `msv inspect <same-id>` processes on the same port would conflict at `EADDRINUSE`; the user gets the existing "try `--port`" error. Cross-port aliasing is not supported (the relay POSTs to one URL).
* **No graceful drainage of in-flight POSTs at pipeline shutdown.** When `runOne`'s `finally` runs, any pending POST that hasn't resolved within the timeout is abandoned with the connection. Recorder flush still completes; live preview misses the final ~1 event in the unlucky case.

---

## 7. Technical Dependencies

### Runtime (existing, unchanged)

* `node >= 20` — uses `node:http` (Vite ships this), `AbortController` (built-in), `node:stream`.
* `vite ^8` — already a dev dependency; the inspect server is a Vite dev server, and the new SSE / POST middlewares use Vite's `configureServer` hook.
* `@xyflow/react ^12` — already used by `InspectorGraph`. Animations live on the React Flow node CSS classes.
* `@mantine/core ^9` — provides `<Skeleton />` and `<Loader />` for in-progress content.

### Runtime (new)

None. The relay is a thin wrapper around `fetch` (Node 20 globals). The SPA uses the browser's `EventSource`. No new packages.

### Documentation referenced

* MDN — `Server-Sent Events`: <https://developer.mozilla.org/en-US/docs/Web/API/Server-sent_events>.
* MDN — `EventSource`: <https://developer.mozilla.org/en-US/docs/Web/API/EventSource>.
* Vite — `server.middlewares` plugin API: <https://vite.dev/guide/api-plugin.html#configureserver>.
* React Flow — node custom CSS classes for state: <https://reactflow.dev/learn/customization/custom-nodes#styling-custom-nodes>.

### Why SSE (not WebSocket)

SSE is one-way (server→client), text-only, auto-reconnecting in the browser, and works through a single HTTP/1.1 GET. WebSocket would let the SPA send messages back, which we don't need. SSE has no handshake, no framing protocol, and no library — `EventSource` is built into every modern browser. Vite has no built-in WebSocket plumbing for app code (its own HMR socket is reserved). Choosing SSE saves us a dependency (`ws` or `socket.io`) and one design loop on protocol.

---

## 8. Detailed Design

### 8.1 Components and data flow

```
┌────────────────────────┐         POST /events           ┌────────────────────────┐
│   msv run <id>         │ ───────────────────────────── ▶│  msv inspect <id>      │
│                        │  (best-effort, 200 ms timeout)│  Vite dev server +     │
│   bus.onAny ─►         │                                │  /events POST sink     │
│     ├─ event_recorder ─┼─► events.jsonl (disk)          │  /events/stream SSE    │
│     ├─ tui (dashboard) │                                │                        │
│     └─ event_relay  ───┘                                │   in-memory ring +     │
│                                                          │   debounced view      │
│                                                          │   rebuild from disk   │
│                                                          └──────────┬─────────────┘
│                                                                     │
│                                                              GET /events/stream
│                                                                     ▼
│                                                          ┌────────────────────────┐
│                                                          │   Inspect SPA          │
│                                                          │                        │
│                                                          │   EventSource          │
│                                                          │     ├─ 'view' msg ─►   │
│                                                          │     │   view state     │
│                                                          │     └─ 'progress' ─►   │
│                                                          │         progress       │
│                                                          │         overlay        │
│                                                          │                        │
│                                                          │   Renders animated     │
│                                                          │   graph + skeletons    │
│                                                          └────────────────────────┘
```

The pipeline doesn't know an inspect server exists. The inspect server doesn't know a pipeline exists. They share only the URL convention `http://127.0.0.1:<inspect-port>/events`.

### 8.2 File-by-file changes

```
src/
├── event_relay.js                       NEW — POST sink, parallel to event_recorder.js
├── commands/run.js                      MODIFIED — attach the relay alongside recorder
├── inspect/
│   ├── server.js                        MODIFIED — add POST /events + GET /events/stream
│   ├── types.d.ts                       MODIFIED — extend StageStatus with 'in_progress'
│   ├── live/                            NEW
│   │   ├── eventBroker.js               NEW — ring buffer + SSE subscriber set
│   │   ├── viewRebuilder.js             NEW — debounced buildView wrapper
│   │   └── seed.js                      NEW — initial events.jsonl replay on startup
├── inspect-app/
│   ├── hooks/
│   │   ├── useView.ts                   MODIFIED — useInitialView (no Suspense)
│   │   ├── useLiveProgress.ts           NEW — overlay reducer + types
│   │   └── useEventSource.ts            NEW — small wrapper around EventSource
│   ├── App.tsx                          MODIFIED — drop Suspense; own view+overlay state
│   ├── ViewContext.tsx                  MODIFIED — pair view with progress overlay
│   ├── inspector/
│   │   ├── nodes/StageNodeShell.tsx     MODIFIED — accept isLive prop, override data-status
│   │   ├── nodes/*.tsx                  MODIFIED — read overlay, pass isLive to shell
│   │   ├── canvases/WorkingGroupCanvas.tsx
│   │   │                                MODIFIED — animate in-progress sub-stages
│   │   └── leafRenderers.tsx            MODIFIED — show <Skeleton /> for pending leaves
│   ├── theme/
│   │   ├── animations.css               NEW — pulse / blink keyframes
│   │   └── tokens.ts                    MODIFIED — add 'in_progress' to stageStatus tokens
│   └── (StageStatusPip.tsx unchanged — already keys off StageStatus exhaustively)
└── ...
```

Tests under `src/inspect/live/__tests__/` and `src/inspect-app/inspector/__tests__/` per the project's existing colocation pattern.

### 8.3 Pipeline-side: `event_relay.js`

Mirror of `event_recorder.js`, but POSTs each envelope instead of appending to a file.

```js
// src/event_relay.js
'use strict';

const RELAY_URL = process.env.MSV_INSPECT_URL || 'http://127.0.0.1:5180/events';
const RELAY_TIMEOUT_MS = 200;

function attachRelay(bus) {
  if (process.env.MSV_NO_RELAY === '1') return () => {};

  const off = bus.onAny((env) => {
    // Fire-and-forget. Failure is the common case (no inspect running).
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), RELAY_TIMEOUT_MS);
    fetch(RELAY_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(env),
      signal: ctrl.signal,
    })
      .catch(() => {
        // Inspect server not up / closed / slow. Drop and move on.
      })
      .finally(() => clearTimeout(timer));
  });

  return () => {
    off();
    // Connections in flight are abandoned by GC. No drainage logic.
  };
}

module.exports = { attachRelay };
```

**Why fire-and-forget without queueing.** A queue with backpressure would couple pipeline progress to inspect-server health. For a dev tool, dropping is better than buffering: the user's mental model is "I started inspect, now I see things; I didn't, I don't." The recorder still writes everything to disk for forensics.

**Why no batching.** Events are emitted on the order of ~10/sec at peak (researcher loop). One HTTP request per event over localhost is negligible. Batching would add latency to the animation feedback that motivates the spec.

**Why `MSV_INSPECT_URL` env override.** Two scenarios: (a) user runs `msv inspect` on a non-default port (`--port 5191`), (b) future remote-inspect setups. Both work with one env var.

`runOne` (in `src/commands/run.js`) gains one more cleanup pair:

```js
let relayCleanup = () => {};
// ...
relayCleanup = attachRelay(bus);
// ...
finally {
  if (tuiCleanup) await tuiCleanup();
  if (relayCleanup) relayCleanup();
  if (recordCleanup) await recordCleanup();
  setBus(null);
}
```

The relay attaches between recorder and TUI by position; ordering doesn't matter functionally (bus dispatches synchronously).

### 8.4 Inspect-server side: event broker and view rebuilder

#### 8.4.1 The broker

Single in-memory ring buffer + subscriber set. Lives for the lifetime of the inspect server.

```js
// src/inspect/live/eventBroker.js
'use strict';

const MAX_EVENTS = 1000;

function createBroker({ ideaId }) {
  const ring = [];
  const subscribers = new Set();
  let lastViewJson = null; // serialized once, broadcast as-is

  function publishEvent(env) {
    if (env.idea_id !== ideaId) return false; // wrong idea, drop
    ring.push(env);
    if (ring.length > MAX_EVENTS) ring.splice(0, ring.length - MAX_EVENTS);
    broadcast('event', env);
    return true;
  }

  function publishView(view) {
    lastViewJson = JSON.stringify(view);
    broadcast('view', lastViewJson); // already-serialized payload
  }

  function broadcast(type, data) {
    const text = typeof data === 'string' ? data : JSON.stringify(data);
    const frame = `event: ${type}\ndata: ${text}\n\n`;
    for (const sub of subscribers) sub.write(frame);
    // Closed subscribers are removed by their res.on('close') handler;
    // writes to an already-closed socket are silently dropped by Node.
  }

  function subscribe(res) {
    subscribers.add(res);
    // Replay state to the new subscriber.
    if (lastViewJson) res.write(`event: view\ndata: ${lastViewJson}\n\n`);
    for (const env of ring) {
      res.write(`event: event\ndata: ${JSON.stringify(env)}\n\n`);
    }
    return () => subscribers.delete(res);
  }

  return { publishEvent, publishView, subscribe };
}

module.exports = { createBroker };
```

The broker is the protocol contract. Two SSE event types:
* `event` — a raw bus envelope (`{ name, ts, idea_id, ... }`). The SPA uses this to drive the progress overlay.
* `view` — a full `InvestigationView` JSON. The SPA replaces its view state.

A subscriber gets the latest `view` plus the full ring of `event`s on connect. After that, both flow live.

#### 8.4.2 The view rebuilder

Debounced wrapper around the existing `buildLoaderInput` + `buildView`. Rebuild on every event but coalesce calls into one rebuild per ~250 ms.

```js
// src/inspect/live/viewRebuilder.js
'use strict';

const path = require('node:path');
const { atomicWriteText } = require('../../storage');
const { buildLoaderInput } = require('../loader');
const { buildView } = require('../view/build');

const DEBOUNCE_MS = 250;

function createViewRebuilder({ ideaDir, broker }) {
  let pending = null;

  async function rebuildOnce() {
    try {
      const input = await buildLoaderInput(ideaDir);
      const view = buildView(input);
      broker.publishView(view);
      // Keep inspect-view.json in sync for fresh page loads (and post-mortem).
      await atomicWriteText(
        path.join(ideaDir, 'inspect-view.json'),
        `${JSON.stringify(view, null, 2)}\n`,
      );
    } catch (err) {
      process.stderr.write(`view rebuild failed: ${err.message}\n`);
    }
  }

  function requestRebuild() {
    if (pending) return;
    pending = setTimeout(() => {
      pending = null;
      rebuildOnce();
    }, DEBOUNCE_MS);
  }

  async function flushNow() {
    if (pending) { clearTimeout(pending); pending = null; }
    await rebuildOnce();
  }

  return { requestRebuild, flushNow };
}

module.exports = { createViewRebuilder };
```

Plain debounce: at most one rebuild per 250 ms. If a new event lands while `rebuildOnce` is running, the next debounce window picks it up via the next `requestRebuild` call from the broker — events arriving mid-rebuild wait one cycle (≤250 ms additional latency). For a dev tool this is invisible; we don't need the in-flight tracking that would tighten that window.

`flushNow` is the force-flush path used on `pipeline.complete` / `pipeline.failed` to guarantee the final view lands before the badge flips to idle (see §8.4.4).

#### 8.4.3 The startup seed

On inspect-server boot, replay `events.jsonl` once so the broker's ring buffer reflects the run-so-far. This is how `msv inspect` started mid-run still shows pipeline state.

```js
// src/inspect/live/seed.js
'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');

async function seedBrokerFromDisk({ ideaDir, broker, ideaId }) {
  let raw;
  try {
    raw = await fs.readFile(path.join(ideaDir, 'events.jsonl'), 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return 0;
    throw err;
  }
  let count = 0;
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    try {
      const env = JSON.parse(line);
      if (env.idea_id === ideaId && broker.publishEvent(env)) count += 1;
    } catch {
      // Tolerate partial last line; recorder fsync is line-buffered.
    }
  }
  return count;
}

module.exports = { seedBrokerFromDisk };
```

No file-watching after seed — the relay handles live events.

#### 8.4.4 The Vite plugin

Extends the existing `viewMiddlewarePlugin` in `src/inspect/server.js`. The plugin now mounts:
* `GET /inspect-view.json` — unchanged, the disk snapshot. Kept for first-paint and for tools/scripts that fetch it directly.
* `POST /events` — body-parse JSON, hand to `broker.publishEvent`. Returns 204 always (no body, no errors leak to pipeline).
* `GET /events/stream` — SSE: writes headers, calls `broker.subscribe(res)`, holds the connection open. Closes on `req.close`.

```js
function liveMiddleware({ ideaDir, ideaId }) {
  return {
    name: 'msv-inspect-live',
    async configureServer(server) {
      const { createBroker } = require('./live/eventBroker');
      const { createViewRebuilder } = require('./live/viewRebuilder');
      const { seedBrokerFromDisk } = require('./live/seed');

      const broker = createBroker({ ideaId });
      const rebuilder = createViewRebuilder({ ideaDir, broker });

      // ORDERING INVARIANT: seed completes BEFORE middlewares register.
      // Vite resumes configureServer at this await; the /events POST handler
      // doesn't exist yet, so no live POSTs can interleave with the seed read.
      // Future refactors must preserve this ordering — moving the middleware
      // registration above the seed silently breaks the invariant by allowing
      // POSTs to interleave with (and potentially be ordered against) seed reads.
      await seedBrokerFromDisk({ ideaDir, broker, ideaId });
      await rebuilder.flushNow(); // emit the initial view

      const originalPublish = broker.publishEvent;
      broker.publishEvent = function (env) {
        const ok = originalPublish(env);
        if (ok) {
          // Terminal pipeline events force-flush so the SPA sees the final
          // view before its overlay clears and the LIVE badge flips to idle.
          if (env.name === 'pipeline.complete' || env.name === 'pipeline.failed') {
            rebuilder.flushNow();
          } else {
            rebuilder.requestRebuild();
          }
        }
        return ok;
      };

      server.middlewares.use('/events', (req, res) => {
        if (req.method === 'POST') {
          let body = '';
          req.on('data', (chunk) => {
            body += chunk;
            if (body.length > 1_000_000) {
              res.statusCode = 413;
              res.end();
              req.destroy();
            }
          });
          req.on('end', () => {
            try {
              const env = JSON.parse(body);
              broker.publishEvent(env);
            } catch {
              // Drop malformed; localhost only, no caller to inform.
            }
            res.statusCode = 204;
            res.end();
          });
          return;
        }
        res.statusCode = 405;
        res.end();
      });

      server.middlewares.use('/events/stream', (req, res) => {
        if (req.method !== 'GET') {
          res.statusCode = 405;
          res.end();
          return;
        }
        res.statusCode = 200;
        res.setHeader('Content-Type', 'text/event-stream');
        res.setHeader('Cache-Control', 'no-store');
        res.setHeader('Connection', 'keep-alive');
        res.flushHeaders?.();
        const unsubscribe = broker.subscribe(res);
        // Use res.on('close') (Node http.ServerResponse close event), not
        // req.on('close') — res is the supported path for detecting that
        // the SSE client has disconnected from a long-poll response.
        res.on('close', unsubscribe);
      });
    },
  };
}
```

The `originalPublish` wrap is the integration point: each accepted event triggers a debounced rebuild, except `pipeline.complete` / `pipeline.failed` which force-flush so the final view lands before the SPA's overlay clears.

`startInspectServer` now passes `ideaId` (derived from the existing `id` arg in `runInspectCommand`) and adds `liveMiddleware` to the plugins array alongside `viewMiddlewarePlugin`.

#### 8.4.5 Edge case: the runtime inspect-view.json write

The original `viewMiddlewarePlugin` reads `inspect-view.json` from disk on each request. The view-rebuilder above also writes it atomically. The two writers — `runInspectCommand`'s initial build and the rebuilder's debounced builds — both go through `atomicWriteText` (already in `src/storage.js`), so the file never tears. The two writes happen concurrently in the ~250 ms after server startup; ordering is undefined but irrelevant in practice: both write a view derived from the same disk state, and the rebuilder's debounce ensures the file converges to the latest within one debounce window. Last writer wins; convergence within one debounce cycle.

### 8.5 SPA-side: live view + progress overlay

#### 8.5.1 EventSource hook

```ts
// src/inspect-app/hooks/useEventSource.ts
import { useEffect, useRef } from 'react';

export type SseHandlers = {
  onView: (view: unknown) => void;
  onEvent: (env: unknown) => void;
};

export function useEventSource(url: string, handlers: SseHandlers): void {
  const ref = useRef<SseHandlers>(handlers);
  ref.current = handlers;

  useEffect(() => {
    const es = new EventSource(url);
    es.addEventListener('view', (e) => {
      try { ref.current.onView(JSON.parse((e as MessageEvent).data)); } catch {}
    });
    es.addEventListener('event', (e) => {
      try { ref.current.onEvent(JSON.parse((e as MessageEvent).data)); } catch {}
    });
    es.onerror = () => {
      // EventSource auto-reconnects; nothing to do beyond accepting the gap.
    };
    return () => es.close();
  }, [url]);
}
```

#### 8.5.2 View state with live updates

`useView` today returns the result of a `use(fetch())` Promise inside a Suspense boundary. **We drop the Suspense path entirely**: it was a clean fit for a one-shot fetch but a poor fit for a state-backed hook that also needs to accept SSE replacements. Two parallel state sources (suspending Promise + `useState`) would require either a state-bridging gymnastic on first render (`useState(use(promise))` — supported but fragile across re-renders) or a one-time hand-off via `useEffect`. Both add complexity for no gain.

The replacement is a plain `useEffect`-driven hook that returns `view | null`; callers render a `<Loader />` while null.

```ts
// src/inspect-app/hooks/useView.ts
import { useEffect, useState } from 'react';
import type { InvestigationView } from '../../inspect/types';

export function useInitialView(): InvestigationView | null {
  const [view, setView] = useState<InvestigationView | null>(null);
  useEffect(() => {
    let cancelled = false;
    fetch('/inspect-view.json')
      .then((r) => {
        if (!r.ok) throw new Error(`load failed (${r.status})`);
        return r.json() as Promise<InvestigationView>;
      })
      .then((v) => { if (!cancelled) setView(v); })
      .catch((err) => { if (!cancelled) console.error('initial view load failed', err); });
    return () => { cancelled = true; };
  }, []);
  return view;
}
```

`App.tsx` drops the `<Suspense>` wrapper (the `<ErrorBoundary>` stays — it still catches render errors from `InspectorGraph`):

```tsx
// src/inspect-app/App.tsx
import { useEffect, useState } from 'react';
import { Center, Loader } from '@mantine/core';
import { ViewProvider } from './ViewContext';
import { useInitialView } from './hooks/useView';
import { useEventSource } from './hooks/useEventSource';
import { emptyProgress, reduceProgress, type ProgressOverlay } from './hooks/useLiveProgress';
import { ErrorBoundary } from './ErrorBoundary';
import { InspectorGraph } from './inspector/InspectorGraph';
import { V4EmptyState } from './inspector/V4EmptyState';
import type { InvestigationView } from '../inspect/types';

function Body() {
  const initial = useInitialView();
  const [view, setView] = useState<InvestigationView | null>(null);
  const [progress, setProgress] = useState<ProgressOverlay>(emptyProgress);

  // Seed once from the initial fetch; later, SSE 'view' messages take over.
  useEffect(() => {
    if (initial && !view) setView(initial);
  }, [initial, view]);

  useEventSource('/events/stream', {
    onView: (v) => setView(v as InvestigationView),
    onEvent: (e) => setProgress((p) => reduceProgress(p, e as BusEnvelope)),
  });

  if (!view) return <Center mih="100vh"><Loader /></Center>;
  if (view.schema_version === 'v4') return <V4EmptyState id={view.id} />;
  return (
    <ViewProvider view={view} progress={progress}>
      <InspectorGraph />
    </ViewProvider>
  );
}

export function App() {
  return <ErrorBoundary><Body /></ErrorBoundary>;
}
```

The seed `useEffect` only runs the first time `initial` resolves and `view` is still null; subsequent SSE `view` messages take precedence (the effect's `!view` guard prevents the initial fetch from clobbering a later, fresher SSE state if `useInitialView` somehow re-resolves).

First-paint race: if the inspect server pushes a `view` SSE message before the initial `/inspect-view.json` fetch resolves (possible — SSE subscribe is a separate request), the seed effect skips because `view` is no longer null. The user sees one render of `<Loader />`, then directly the SSE-pushed view. No visible flash.

#### 8.5.3 Progress overlay

The progress overlay is a small in-memory map keyed by `(stage_key | wg_id | wg_id+substage)` to one of `idle | in_progress | done`. It is reset on each fresh `view` (the view's `Stage.status` field is the truth for completed stages; the overlay only contributes the *in-progress* state).

```ts
// src/inspect-app/hooks/useLiveProgress.ts
// Matches the envelope shape produced by src/bus.js (name + ts + idea_id + payload).
export type BusEnvelope = {
  name: string;
  ts: number;
  idea_id: string | null;
  [key: string]: unknown;
};

export type ProgressOverlay = {
  inProgressStages: Set<string>;             // stage_key
  inProgressWg: Set<string>;                 // wg_id
  wgSubstage: Map<string, string>;           // wg_id → current substage
  researcherActivity: Map<string, string>;   // wg_id → 'web_search:foo'
};

export function emptyProgress(): ProgressOverlay {
  return {
    inProgressStages: new Set(),
    inProgressWg: new Set(),
    wgSubstage: new Map(),
    researcherActivity: new Map(),
  };
}

export function reduceProgress(prev: ProgressOverlay, env: BusEnvelope): ProgressOverlay {
  switch (env.name) {
    case 'pipeline.stage.start': return withStage(prev, env.stage, 'in');
    case 'pipeline.stage.end':   return withStage(prev, env.stage, 'out');
    case 'wg.start':             return withWg(prev, env.territory_id, 'in');
    case 'wg.end':               return withWg(prev, env.territory_id, 'out');
    case 'wg.ideation.start':
    case 'wg.adversarial.start':
    case 'wg.alignment.start':
    case 'wg.researcher.start':
    case 'wg.observation.start':
    case 'wg.debate.start':
      return withSubstage(prev, env.territory_id, env.name.split('.')[1]);
    case 'wg.researcher.web_search':
      return withResearcher(prev, env.territory_id, `search: ${env.query}`);
    case 'wg.researcher.web_fetch':
      return withResearcher(prev, env.territory_id, `fetch: ${env.url}`);
    // pipeline.complete / pipeline.failed: clear in-progress sets.
    case 'pipeline.complete':
    case 'pipeline.failed':
      return emptyProgress();
    default:
      return prev;
  }
}
```

The reducer is intentionally narrow: only events that toggle UI animation are handled. Everything else falls through.

#### 8.5.4 ViewContext: pair view with progress

```tsx
// src/inspect-app/ViewContext.tsx
import { createContext, useContext, type ReactNode } from 'react';
import type { InvestigationView } from '../inspect/types';
import type { ProgressOverlay } from './hooks/useLiveProgress';

type Ctx = { view: InvestigationView; progress: ProgressOverlay };
const ViewContext = createContext<Ctx | null>(null);

export function ViewProvider({
  view,
  progress,
  children,
}: { view: InvestigationView; progress: ProgressOverlay; children: ReactNode }) {
  return <ViewContext.Provider value={{ view, progress }}>{children}</ViewContext.Provider>;
}

export function useViewContext(): InvestigationView {
  const ctx = useContext(ViewContext);
  if (!ctx) throw new Error('useViewContext must be used inside <ViewProvider>');
  return ctx.view;
}

export function useProgressOverlay(): ProgressOverlay {
  const ctx = useContext(ViewContext);
  if (!ctx) throw new Error('useProgressOverlay must be used inside <ViewProvider>');
  return ctx.progress;
}
```

#### 8.5.5 Stage node animation

All seven stage-node renderers under `src/inspect-app/inspector/nodes/` (DiscoveryNode, CoordinatorNode, WorkingGroupNode, CrossPollinationNode, ForumStageNode, SynthesisNode, SubStageNode) wrap a common `StageNodeShell`. `StageNodeShell` is therefore the single integration point: it accepts an `isLive` boolean prop, applies `data-status='in_progress'` to its root when the prop is true (otherwise the existing `data.stage.status`), and forwards the boolean to its inner `StageStatusPip`. The seven wrappers each compute `isLive` from the overlay and pass it through; no other changes to the individual nodes.

`StageStatusPip` and the `StageStatus` type itself are extended to include `'in_progress'`:

* `src/inspect/types.d.ts` — `StageStatus = 'done' | 'partial' | 'skipped' | 'failed' | 'not_run' | 'in_progress'`.
* `src/inspect-app/theme/tokens.ts` — extend `stageStatusGlyph` (e.g. `'◍'` or reuse `'●'` with the blink animation overriding rendering) and `stageStatusColor` (blue-6) with the new key.

The view-builder never emits `'in_progress'` itself — that state is only ever produced client-side by the overlay. Extending the type is preferable to a parallel `isLive` boolean threaded through every node because the renderers, tokens, and pip already key off `StageStatus` exhaustively; adding a sibling channel would split the rendering path.

```tsx
// src/inspect-app/inspector/nodes/StageNodeShell.tsx (modified — sketch)
import { useProgressOverlay } from '../../ViewContext';

export function StageNodeShell({ title, status, summary, footer, /* ... */ isLive }: Props) {
  const effectiveStatus: StageStatus = isLive ? 'in_progress' : status;
  return (
    <Paper withBorder data-status={effectiveStatus} /* ... */>
      <StageStatusPip status={effectiveStatus} />
      {/* ... */}
    </Paper>
  );
}

// Each node wrapper, e.g. DiscoveryNode.tsx:
export function DiscoveryNode({ data }: { data: { stage: Stage } }) {
  const overlay = useProgressOverlay();
  const isLive = overlay.inProgressStages.has(data.stage.key);
  return <StageNodeShell title="Discovery" status={data.stage.status} isLive={isLive} /* ... */ />;
}
```

CSS in `theme/animations.css`, scoped to the Paper root via the new `data-status` value:

```css
[data-status='in_progress'] {
  border-color: var(--mantine-color-blue-5);
  animation: msv-pulse-border 1.6s ease-in-out infinite;
}

@keyframes msv-pulse-border {
  0%, 100% { box-shadow: 0 0 0 0 rgba(59, 130, 246, 0.0); }
  50%      { box-shadow: 0 0 0 4px rgba(59, 130, 246, 0.18); }
}

[aria-label='status: in_progress'] {
  animation: msv-blink 1.0s ease-in-out infinite;
}

@keyframes msv-blink {
  0%, 100% { opacity: 0.4; }
  50%      { opacity: 1.0; }
}
```

The aria-label selector for the pip is convenient because `StageStatusPip` already sets `aria-label={`status: ${status}`}`; no new className needed.

Working-group sub-stage nodes mirror the same pattern: `SubStageNode` reads `overlay.wgSubstage.get(wgId) === substage` and passes `isLive` to `StageNodeShell`.

#### 8.5.6 Skeleton drawer content

`leafRenderers.tsx` renders each leaf kind. When the leaf is missing from the view but the progress overlay says the producing stage is in flight, render a skeleton placeholder.

```tsx
// src/inspect-app/inspector/leafRenderers.tsx (sketch — debate move)
function DebateMoveLeaf({ ref }: { ref: LeafRef & { kind: 'move' } }) {
  const view = useViewContext();
  const move = view.debates[ref.subQuestionId]?.moves.find(m => m.move_id === ref.moveId);
  if (move) return <MoveCard move={move} />;
  // Move not yet in view; render skeleton if the WG is in flight.
  const overlay = useProgressOverlay();
  if (overlay.inProgressWg.has(ref.subQuestionId)) {
    return <Skeleton height={120} radius="sm" />;
  }
  return <Text c="dimmed">Move not available.</Text>;
}
```

#### 8.5.7 Header live indicator

A small "● LIVE" badge in the existing `Header` component shows when the SPA has an active SSE connection. Driven by EventSource lifecycle listeners (`readyState` is not React-reactive): `useEventSource` is extended to accept `onOpen` and `onError` callbacks that flip a state variable in the parent.

```ts
// extension of useEventSource
type SseHandlers = {
  onView: (view: unknown) => void;
  onEvent: (env: unknown) => void;
  onOpen?: () => void;
  onError?: () => void;
};

// inside useEffect:
es.onopen = () => ref.current.onOpen?.();
es.onerror = () => ref.current.onError?.();
```

`App.tsx` tracks `sseStatus: 'connecting' | 'live' | 'error'`, initialized to `'connecting'`. `onOpen` sets `'live'`, `onError` sets `'error'`. The Header reads the status from context and renders accordingly. If the pipeline is idle (no events for >5 s and no in-progress stages), the badge text changes to "● idle" while connection state stays `'live'`. This is the only place the SPA distinguishes connected from disconnected.

### 8.6 Concurrency and ordering

The bus dispatches synchronously to listeners (`safeDispatch` in `bus.js`). The relay runs its `fetch` synchronously up to the await — i.e. before `await fetch`, the listener has returned. So the bus doesn't block on the relay. Out of the listener stack, the POST is in flight; the next event from the pipeline (which may arrive ~ms later) initiates a second POST. POSTs *may* arrive out of order at the inspect server, but:

* The broker assigns no sequence number; events keep their `ts` from the bus envelope.
* The SPA's progress overlay applies events idempotently — `inProgressStages.add('discovery')` is the same effect regardless of arrival order, and the matching `delete` always comes from `pipeline.stage.end`.
* The view rebuild is driven by disk state, which is monotonic (recorder + appendLog are append-only). Out-of-order POSTs don't affect the view contents; they only affect transient overlay flicker, which is bounded by the 250 ms debounce.

Out-of-order is therefore tolerable. If it turns out to cause visible glitches, a v2 enhancement adds a monotonic `seq` to bus envelopes — not in scope here.

### 8.7 Idea-id matching

Every bus envelope carries `idea_id` (`bus.setIdea(id)` in `commands/run.js`). The inspect server records its `ideaId` when started by `runInspectCommand` and rejects POSTs whose `idea_id` doesn't match (silently 204'd, dropped at the broker layer). This makes `msv run A` and `msv inspect B` running concurrently safe — `A`'s events go to localhost:5180 and get dropped by `B`'s server.

It does *not* make `msv run A` and `msv inspect A` reach each other unambiguously when the user has accidentally started two inspect servers on different ports; the relay uses one URL only. Documented limitation.

### 8.8 Failure modes

| Failure | Pipeline behavior | Inspect behavior | User experience |
|---|---|---|---|
| Inspect not running | All POSTs fail fast (200 ms timeout). Recorder still writes events.jsonl. | N/A | Nothing changes for the user; TUI still works. |
| Inspect starts mid-run | First POST after startup succeeds. | Server seeds from events.jsonl on boot, then accepts new POSTs. | SPA shows past + live state coherently. |
| Inspect dies mid-run | POSTs fail again; recorder still writes. | N/A | Restarting inspect re-seeds from disk; no data loss. |
| SPA tab loses focus | N/A | SSE stays open in background tabs. | On tab return, SPA already has current state. |
| SSE connection drops | N/A | Browser auto-reconnects via `EventSource`. | Brief gap; on reconnect, server replays ring + current view. |
| Ring buffer overflow (>10 000 events) | N/A | Oldest events dropped; view rebuild from disk still authoritative. | Progress overlay loses some early-run state; rarely noticeable since old in-progress flags were already cleared. |
| Two inspect servers on different ports | Relay only knows one URL. | One is "live"; the other shows stale snapshot. | User uses one terminal's inspect window. |
| Malformed POST body | N/A | Server drops with 204. | None — no caller to surface error to. |
| Pipeline crashes mid-stage | Relay attempts final POSTs before process exit; some lost. | Server keeps last `view` from disk; in-progress overlay sticks unless `pipeline.failed` was received. | After failure, user restarts inspect or refreshes; disk view is final source. |

### 8.9 What does *not* change

* The TUI dashboard, log, and debug renderers are unchanged. The relay is a sibling consumer, not a replacement.
* `events.jsonl` shape is unchanged. The relay reads the same envelopes the recorder writes.
* `inspect-view.json` shape is unchanged. The view rebuilder writes the same JSON the one-shot `runInspectCommand` writes.
* The `tools/replay.js` tool is unchanged. It does not interact with the inspect server.
* The CLI surface is unchanged: `msv run <id>` and `msv inspect <id>` with the same flags.

---

## 9. User Experience

### Happy path

1. Terminal A: `msv inspect <id>` — Vite starts on 5180, browser opens at `localhost:5180/?id=<id>`. SPA loads, shows current state (idle if no run is in progress). The "● LIVE" badge lights up in the header.
2. Terminal B: `msv run <id>` — pipeline starts, TUI dashboard renders, relay POSTs each event to localhost:5180.
3. Browser: the SPA's pipeline graph animates. `Discovery` stage node begins pulsing. After a few seconds, it stops pulsing and shows its summary text. `Coordinator` begins pulsing. Working groups fan out — each WG node pulses while its sub-stages light up internally. The forum stage activates once cross-pollination starts. Synthesis renders last. The "● LIVE" badge fades to "● idle" after `pipeline.complete`.
4. User clicks a Working Group node mid-run. The sub-canvas opens. The current sub-stage pulses. Leaf content (moves, researcher reports) populates as the WG progresses.
5. User clicks an in-progress leaf. The drawer opens and shows a `<Skeleton />` placeholder. When the relevant event arrives and the view rebuilds, the skeleton is replaced with the actual content.

### Late-attach

1. Terminal B running `msv run <id>` for 90 seconds.
2. Terminal A: `msv inspect <id>` — Vite starts; server reads `events.jsonl`, populates ring buffer with ~150 events, runs `buildView` once. Browser opens, SPA shows: stages 1–3 done, stage 4 (working groups) in progress with three of four WGs animated.
3. From this point forward, behavior identical to the happy path.

### No inspect running

1. Terminal B: `msv run <id>` — pipeline runs as today. Relay POSTs all fail silently. TUI renders normally. `events.jsonl` and `inspect-view.json` write as today. No user-visible difference.

### Inspect-then-run-then-inspect-again

1. User starts inspect, then run, then closes inspect mid-run.
2. Reopens inspect — server reads events.jsonl (now containing what's happened so far), seeds ring buffer, rebuilds view. SPA shows current state and resumes animating.

### Failure visibility

If the pipeline fails (`pipeline.failed` event), the `LastFailureBanner` component already renders failure state from the view. With live preview, the banner appears the moment the failure event lands — not on the next refresh.

---

## 10. Testing Strategy

### Test framework

* Pipeline-side tests use `node --test` (the project's existing pattern in `test/`).
* SPA-side tests use Vitest with React Testing Library (`vitest --config src/inspect-app/vitest.config.ts run`).
* SSE end-to-end tests use Vitest with a synthetic Vite middleware harness — no real browser.

All vitest invocations follow the global rule from `~/.claude/CLAUDE.md`: `CI=true` prefix.

### Unit tests — `src/event_relay.js`

* **Relay POSTs the envelope to the configured URL.** Mock `fetch`, attach relay, emit one event, assert one POST with the right URL, headers, and serialized body. *Purpose: locks the wire format the inspect server depends on.*
* **Relay aborts on timeout.** Mock `fetch` to never resolve. Emit one event. Assert that within ~250 ms the AbortController fires and the relay does not block subsequent events. *Purpose: prevents the relay from accidentally backpressuring the bus if inspect hangs.*
* **Relay swallows network errors.** Mock `fetch` to reject. Emit ten events. Assert no thrown errors and ten POST attempts. *Purpose: ensures the pipeline is unaffected by relay failures.*
* **`MSV_INSPECT_URL` overrides default.** Set env, assert POST URL. *Purpose: lets the user run inspect on a non-default port without code change.*
* **`MSV_NO_RELAY=1` disables.** Set env, attach relay, emit. Assert zero POSTs. *Purpose: escape hatch for test environments / regression triaging.*

### Unit tests — `src/inspect/live/eventBroker.js`

* **`publishEvent` rejects mismatched `idea_id`.** Create broker for idea A, publish env with idea B. Assert returns false, ring stays empty, subscribers not notified. *Purpose: idea isolation contract.*
* **`publishEvent` enqueues and broadcasts.** Subscribe a fake writable; publish an event; assert the fake received an `event:` frame. *Purpose: subscriber receives in-flight events.*
* **`subscribe` replays ring + last view.** Publish 3 events and 1 view; subscribe; assert the subscriber received the view first, then 3 events. *Purpose: late subscribers see consistent state.*
* **Ring overflow trims oldest.** Publish 10 001 events; assert ring length == 10 000 and the oldest is the second-emitted. *Purpose: bounded memory.*
* **Broken subscriber is dropped.** Subscribe a writer whose `.write()` throws; publish an event; assert the writer was removed from the set. *Purpose: SSE clients that disconnect uncleanly don't break the broker.*

### Unit tests — `src/inspect/live/viewRebuilder.js`

* **Debounces multiple `requestRebuild` calls.** Mock `buildLoaderInput`/`buildView`. Call requestRebuild 5 times in 50 ms. Wait 300 ms. Assert exactly one buildView call. *Purpose: prevents read-storm against disk during a busy run.*
* **`flushNow` bypasses debounce.** Schedule a `requestRebuild`, then call `flushNow` before the debounce fires. Assert exactly one buildView call (the flushed one). *Purpose: terminal pipeline events publish the final view immediately, not after a 250 ms delay.*
* **Publishes view to broker.** Mock broker; trigger flush; assert `publishView` called with the buildView output. *Purpose: contract with broker.*
* **Writes inspect-view.json atomically.** Mock atomicWriteText; assert called with the same JSON. *Purpose: keep disk snapshot fresh for page reloads.*

### Unit tests — `src/inspect/live/seed.js`

* **Seeds events with matching idea_id.** Write a temp events.jsonl with mixed idea_ids; seed; assert only matching are in the broker's ring. *Purpose: cross-idea contamination guard.*
* **Returns 0 when file missing.** Point at non-existent path; assert no throw, returns 0. *Purpose: clean state for first-ever inspect of an idea.*
* **Tolerates malformed last line.** Append a partial JSON line; assert no throw and prior events still loaded. *Purpose: recorder writes are line-buffered; the last line may be partial at the moment we read.*

### Integration tests — Vite middleware end-to-end

Use Vite's `createServer` programmatically in a test, hit it with `http` requests, assert SSE frames arrive over a real socket. No browser.

* **POST then GET stream receives the event.** Start server with broker; POST one event; open EventSource (via `EventSource` polyfill or a manual GET parsing `event:`/`data:` lines); assert the event arrives. *Purpose: full HTTP wire test of the broker contract.*
* **GET stream first, then POST.** Inverse order. *Purpose: subscribe-before-publish is the common case.*
* **POST with wrong idea_id is dropped.** *Purpose: SSE subscribers don't see foreign events.*
* **Two subscribers receive the same event.** *Purpose: multi-tab inspect doesn't deduplicate.*

### Unit tests — SPA `reduceProgress`

* **`pipeline.stage.start` adds the stage.** Empty overlay → stage start event → overlay has the stage. *Purpose: drives the pulse animation on stage nodes.*
* **`pipeline.stage.end` removes it.** *Purpose: animation stops when stage finishes.*
* **`wg.researcher.web_search` records query for WG.** *Purpose: drives researcher activity hint in WG sub-canvas.*
* **`pipeline.complete` clears all overlays.** *Purpose: post-run there should be no animation residue.*
* **Unknown event names are passthrough.** *Purpose: pre-empts breakage if new bus events are added without updating the reducer.*

### Component tests — SPA animations

Use jsdom + RTL.

* **Stage node renders `data-status='in_progress'` when overlay contains the stage.** Render with mock progress; assert attribute. *Purpose: CSS-driven animation hinge.*
* **Skeleton renders when leaf is missing and WG is in progress.** Pass a view without the move, an overlay with the WG. *Purpose: validates the placeholder fallback in `leafRenderers.tsx`.*
* **Drawer leaf renders MoveCard when present (regardless of overlay).** *Purpose: completed leaves don't accidentally get skeletons.*
* **"● LIVE" badge appears when EventSource is open.** *Purpose: connection-state surface.*

### Smoke test

`src/inspect-app/vitest.smoke.test.ts` already verifies the SPA mounts. Extend it: render under a mock SSE adapter, push one `view` and one `event`, assert the SPA renders the new view and animates. *Purpose: catches regressions in the wiring between EventSource, ViewContext, and consumers.*

### Manual verification

A short manual test in `specs/feat-inspect-live-preview.md` runbook section (deferred to PR description, not the spec):

1. `msv run <id>` and `msv inspect <id>` in two terminals; assert animations.
2. Kill inspect mid-run; restart; assert state recovery.
3. Start inspect without a run; assert no errors in console.
4. Start run without inspect; assert pipeline completes normally.

### What is *not* tested

* Browser-specific SSE behavior (reconnect timing, header handling). Single-browser manual smoke only.
* High event throughput (>10k/sec). The bus emits hundreds per run; load testing is unnecessary.
* Adversarial inputs (malformed JSON, oversized bodies). Body size cap (1 MB) is asserted; deeper fuzzing is out of scope for a localhost dev tool.

---

## 11. Performance Considerations

### Pipeline overhead

The relay's per-event work is one `JSON.stringify`, one `fetch()`, one `AbortController`+`setTimeout` pair. Localhost HTTP/1.1 keep-alive (default in Node fetch) reuses sockets across events. Per-event budget: <2 ms wall, <0.5 ms CPU on a typical run. At ~10 events/sec, the relay adds <5% CPU overhead in the bus listener path. Negligible.

If `msv inspect` is not running, every POST hits ECONNREFUSED in <1 ms, the AbortController never fires, and the failure path is one rejected promise. Overhead is sub-millisecond.

### View rebuild cost

`buildLoaderInput` reads `index.json` plus a handful of JSONL files under `logs/`. For a complete run, that's ~5–50 KB total. `buildView` does a few dozen `Object.entries` traversals. End-to-end rebuild measured on a typical run: 5–20 ms.

The 250 ms debounce caps rebuild rate to ~4/sec. At peak event rate (~10/sec), the debounce coalesces 2–3 events per rebuild. View JSON serialization is ~20–80 KB; broadcasting it over SSE to one subscriber is sub-millisecond on localhost.

Total inspect-server overhead during a run: <10% of a single core, well within the budget of a dev tool.

### SPA re-render cost

Each `view` SSE message triggers `setView`, which re-renders the entire `InspectorGraph` subtree. React Flow's diffing handles ~50 nodes well. The progress overlay is a separate state and triggers smaller updates (only the changed stage nodes). With ~4 view replacements/sec and ~10 overlay updates/sec, the browser stays smooth on a modest machine.

### Bandwidth

Localhost only. 80 KB/view * 4 view/sec = 320 KB/sec peak. Trivial.

### Memory

Inspect-server ring buffer: 10 000 events * ~200 B avg = 2 MB. Bounded.

### What's *not* optimized

* No view diffing — we send the full view every rebuild. A future v2 could send a JSON Patch (`[{ op: 'add', path: '/debates/...', ... }]`); the SPA would apply it. Out of scope.
* No SSE compression. The Vite dev server doesn't gzip by default; we don't bother turning it on for localhost.

---

## 12. Security Considerations

### Threat model

The threat model is *none*. This is a localhost dev tool, single user, single machine. No external network exposure, no untrusted clients, no persistent data shared between users.

### Mitigations (such as they are)

* **Loopback bind.** The Vite dev server already binds to `127.0.0.1` (existing `host: '127.0.0.1'` in `src/inspect/server.js`). The new middlewares inherit this. No external network surface.
* **Body size cap.** POST `/events` rejects bodies >1 MB. Prevents accidental memory blow-up from a buggy producer.
* **Idea-id filter.** Bounds blast radius if the user has multiple `msv inspect` servers running.
* **No deserialization of bus envelopes beyond `JSON.parse`.** No `eval`, no `vm`. The envelope shape is a plain object; the view rebuilder reads from disk, not from the envelope, so a malicious envelope cannot poison the rebuilt view.

### What this does *not* protect against

* Any process on the host can POST to `localhost:5180/events`. There is no shared-secret auth. Acceptable: the same model as Vite HMR itself.
* A malicious local process can DoS the inspect server by flooding POSTs. Acceptable: it can already DoS the dev server in many other ways. We're not in a hostile environment.

If this code is ever lifted out of dev-tool territory (e.g., remote inspect over SSH-port-forwarded sockets), the auth/transport story has to be redone. §16 notes this as an explicit "do not extend without a redesign" rule.

---

## 13. Documentation

### Updates required

* `README.md` — short paragraph in the "Inspect" section noting that `msv inspect <id>` now reflects live runs without refresh. One sentence pointing at this spec.
* `docs/` — no existing developer docs to update. The architecture spec ([`specs/architecture.md`](architecture.md)) gets a one-line addition under "Inspect" mentioning the live channel.
* `specs/feat-pipeline-inspector-graph.md` §6 ("Non-Goals") — the "No replay / animation" line stays accurate for the *static* graph; cross-reference this spec as the live-animation addition.

### What is *not* documented

* No public API docs — the POST and SSE endpoints are private. They're not exposed to users; they exist for the SPA's own consumption.
* No man page changes (`msv inspect --help` is unchanged).
* No diagram updates beyond §8.1.

---

## 14. Implementation Phases

### Phase 1 — Plumbing

* `src/event_relay.js` + tests.
* `src/inspect/live/eventBroker.js` + tests.
* `src/inspect/live/viewRebuilder.js` + tests.
* `src/inspect/live/seed.js` + tests.
* Wire `attachRelay` into `runOne` in `src/commands/run.js`.
* Wire `liveMiddleware` into `startInspectServer`.
* Integration test: end-to-end POST → SSE.

Outcome: pipeline pushes events; inspect server broadcasts views. No SPA changes yet — the SPA still reads `inspect-view.json` once at startup.

### Phase 2 — Live SPA state

* `src/inspect-app/hooks/useEventSource.ts`.
* Replace Suspense-based `useView` with `useInitialView` (plain `useEffect`); drop `<Suspense>` in `App.tsx`.
* `App.tsx` owns `view` and `progress` state and subscribes via `useEventSource`.
* `useLiveProgress.ts` + reducer + tests.
* `ViewContext.tsx` pair view with progress.
* Smoke test: SPA replaces view on `view` message.

Outcome: SPA reflects live view updates with no animations yet.

### Phase 3 — Animations

* Extend `StageStatus` in `src/inspect/types.d.ts` with `'in_progress'`; add tokens for it.
* `theme/animations.css` with pulse / blink keyframes (selected via `[data-status='in_progress']` and the pip's existing `aria-label`).
* `StageNodeShell` accepts an `isLive` prop and overrides `data-status` when set.
* Each of the seven node wrappers reads the overlay and threads `isLive` into the shell.
* `SubStageNode` mirrors the pattern for working-group sub-stages.
* Component tests for animation classes.

Outcome: in-progress stages visibly animate.

### Phase 4 — Skeleton loaders

* Update `leafRenderers.tsx` to render `<Skeleton />` for leaves not yet in the view when the producing stage is in flight.
* Component tests for skeleton fallback.
* Header "● LIVE" / "● idle" badge.

Outcome: drawer content shows loading state for in-progress leaves; user sees connection state.

### Phase 5 — Polish

* Stress-test by running a full investigation with inspect open from start.
* Trim debounce / animation timings if anything feels sluggish.
* Single-browser manual smoke for SSE reconnection (the developer's primary browser).
* Update README / docs.

Phases are independent for review purposes (Phase 1 ships green even without 2–5). The full feature is the sum.

---

## 15. Open Questions

1. **Should the SPA show a one-time toast when a `pipeline.complete` lands while the user has the tab open?** Useful for long runs where the user has switched tabs. Lean: defer — `document.title` change might suffice, and that's cheaper.
2. **Should the relay also POST a `pipeline.attached` envelope on startup so the inspect server records when the relay first connected?** Useful for debugging missed events; cheap. Decision: no, the recorder timestamps are sufficient.
3. **Does the view rebuilder need a max-rebuild-time circuit breaker?** If `buildView` ever regressed to >1 s, the debounce would queue infinitely. Lean: add a "skip if last rebuild took >2 s and a new request came in" guard in Phase 5 if the issue ever surfaces; not part of v1.
4. **Should the broker persist its ring across inspect-server restarts (e.g., to a `~/.msv/ideas/<id>/live-buffer.jsonl`)?** Currently it reseeds from `events.jsonl` which is good enough. Decision: no — duplicate persistence is exactly the kind of state divergence we're avoiding.

---

## 16. Alternatives Considered

### Alt-A: File-tail instead of HTTP push

Inspect server `fs.watch` on `events.jsonl`. Pipeline unchanged. Pros: pipeline never knows about a server, no port coupling, naturally handles late-attach (same code path as seed). Cons: FSEvents lag (50–200 ms on macOS), partial-line handling, no clean cross-machine story. Rejected per the user's brief; recorded here as the simpler fallback if the push approach develops issues.

### Alt-B: WebSocket instead of SSE

Bidirectional channel from SPA back to inspect server. Pros: future "pause", "scrub", "trigger replay" actions could be issued from the SPA. Cons: no built-in browser library, needs `ws` dependency or hand-rolled framing, more code. Rejected: we have no near-term need for SPA→server messaging.

### Alt-C: Pipeline runs its own HTTP server

`msv run` exposes `/events/stream` directly; inspect SPA connects to the run process. Pros: no relay needed. Cons: pipeline process learns network code, port conflicts when `--all` runs multiple ideas, inspect SPA needs to discover which pipeline owns which idea. Rejected: violates the "pipeline is I/O-free" goal from `feat-tui-event-decoupling.md`.

### Alt-D: Server-side `InvestigationView` diffing

Inspect server holds the previous view, computes a JSON Patch on each rebuild, broadcasts only the patch. Pros: bandwidth savings, theoretically smoother SPA re-renders. Cons: implementation complexity, debug story (patches are harder to inspect than full snapshots), bandwidth is not a real concern on localhost. Rejected for v1; revisitable if SPA re-render cost surfaces as a problem.

### Alt-E: Push raw events, derive view client-side

The SPA mirrors `buildView` logic and reduces events into `InvestigationView` directly. Pros: zero server-side rebuild cost; SPA can replay history natively. Cons: duplicates ~600 LOC of view-building logic in TypeScript, two implementations to keep in sync, far higher chance of subtle divergence. Rejected: the view builder is the single source of truth and should stay so.

### Alt-F: Re-use the dashboard reducer client-side

The dashboard TUI's reducer (`src/tui/dashboard/reducer.js`) already maps events to a UI state shape. The SPA could import and use that reducer. Pros: zero new reducer code. Cons: the dashboard's state shape is TUI-specific (stage status as strings, recent-events tail, etc.) and not isomorphic to `InvestigationView`. Mapping would be as much work as writing the small progress-overlay reducer this spec proposes. Considered, partially adopted: this spec's `reduceProgress` is intentionally narrow and event-driven in the same spirit, but it is a *separate* reducer because its consumer is different.

---

## 17. References

### Existing project files referenced

* `src/bus.js` — event bus and envelope shape.
* `src/event_recorder.js` — model for the parallel `event_relay.js` design.
* `src/commands/run.js` — pipeline orchestration and `runOne` integration point.
* `src/inspect/server.js` — Vite dev server and middleware mounting.
* `src/inspect/loader/index.js` + `src/inspect/view/build.js` — `buildLoaderInput` + `buildView` reused by the rebuilder.
* `src/inspect-app/App.tsx`, `src/inspect-app/ViewContext.tsx`, `src/inspect-app/hooks/useView.ts` — SPA hydration touchpoints.
* `src/inspect-app/inspector/InspectorGraph.tsx` and `src/inspect-app/inspector/nodes/` — graph nodes that receive `data-status`.
* `src/inspect-app/inspector/leafRenderers.tsx` — drawer leaves that gain skeleton fallbacks.
* `src/tui/dashboard/reducer.js` — reference implementation for an event-driven UI reducer.
* `tools/replay.js` — sibling tool that consumes `events.jsonl` for development; unchanged by this spec.

### External documentation

* MDN — Server-Sent Events: <https://developer.mozilla.org/en-US/docs/Web/API/Server-sent_events>.
* MDN — EventSource: <https://developer.mozilla.org/en-US/docs/Web/API/EventSource>.
* Vite — `configureServer` API: <https://vite.dev/guide/api-plugin.html#configureserver>.
* Vite — `server.middlewares` (Connect): <https://github.com/senchalabs/connect>.
* React Flow — custom node classes: <https://reactflow.dev/learn/customization/custom-nodes#styling-custom-nodes>.
* Mantine — `Skeleton`: <https://mantine.dev/core/skeleton/>.
* Node — AbortController: <https://nodejs.org/api/globals.html#class-abortcontroller>.

### Related specs in this repo

* [`specs/architecture.md`](architecture.md) — overall pipeline architecture.
* [`specs/feat-tui-event-decoupling.md`](feat-tui-event-decoupling.md) — the bus, recorder, and TUI module model this spec extends.
* [`specs/feat-pipeline-inspector-graph.md`](feat-pipeline-inspector-graph.md) — the static SPA graph this spec animates.
* [`specs/feat-investigation-resumption.md`](feat-investigation-resumption.md) — partial-investigation rendering invariants the live view must preserve.
* [`specs/question-machine.md`](question-machine.md) — v5 pipeline stages whose progress events drive the animation overlay.
