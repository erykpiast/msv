# Event vocabulary

This file documents the event vocabulary emitted on the bus from `src/bus.js`. Listeners consume these via `bus.on(name, fn)` or `bus.onAny(fn)`. Every event payload is wrapped in an envelope adding `ts` (ms, `Date.now()`), `idea_id` (set once per pipeline via `bus.setIdea(id)`), and `name` (the event name).

The pipeline emits the *core* payload; the envelope is merged in by `bus.emit` before listeners are notified. Names use `dotted.case`. Payloads are plain objects, JSON-serialisable, with a fixed set of keys per event. The full enum lives in `EVENTS` in `src/bus.js`.

For the design rationale and end-to-end picture (renderer modes, recorder, replay), see [`specs/feat-tui-event-decoupling.md`](../specs/feat-tui-event-decoupling.md).

## Top-level pipeline lifecycle

Emitted from `src/commands/run.js`. The `stage` field on each event is one of: `discovery`, `diversity`, `coordinator`, `working_groups`, `cross_pollination`, `forum`, `synthesis`.

| Event | Payload (core) | When emitted |
|---|---|---|
| `pipeline.start` | `{ idea_id, raw_capture, model, synthesizer_model, budget }` | First line of `runPipeline` |
| `pipeline.stage.start` | `{ stage, stage_index, total_stages }` | Top of each numbered stage in `runPipeline` |
| `pipeline.stage.progress` | `{ stage, message }` | Free-form sub-step note (fallback for things not granular enough to warrant a dedicated event) |
| `pipeline.stage.end` | `{ stage, summary }` (small object, e.g. `{ territories: 4 }` or `{ nodes: 12, dead_ends: 2 }`) | End of each stage; carries the structured counts that previously sat in `progress()` lines |
| `pipeline.stage.heartbeat` | `{ stage, seconds }` | Every 15s while a long stage is in flight (replaces `withHeartbeat`'s stdout writes) |
| `pipeline.complete` | `{ idea_id, ok, used_executor_calls, used_total_tokens, used_researcher_tool_calls }` | After `idea.status='ready'` is persisted |
| `pipeline.failed` | `{ idea_id, stage, error_message, error_stack }` | Catch block in `runOne` |

## Discovery (stage 1)

| Event | Payload (core) | When emitted |
|---|---|---|
| `discovery.web_search.start` | `{ query }` | A `server_tool_use` block of type `web_search` arrives in the stream |
| `discovery.web_search.result` | `{ query, count }` | A `web_search_tool_result` block arrives in the stream |
| `discovery.emit_personas` | `{ count, retry }` | `tool_use` for `emit_personas` block arrives (retry: `false` on first turn, `true` on forced second turn) |

## Coordinator (stage 3)

| Event | Payload (core) | When emitted |
|---|---|---|
| `coordinator.territories.emitted` | `{ count, names: string[] }` | After `runCoordinatorInitial` returns |

## Working group (stage 4)

Six sub-stages, fanned out across pairs. Every event carries a `territory_id` correlation key; the dashboard groups its per-WG cards by this id.

| Event | Payload (core) | When emitted |
|---|---|---|
| `wg.start` | `{ territory_id, territory_name, assigned_pair, distinctness_score }` | Top of `runWorkingGroup` |
| `wg.ideation.start` | `{ territory_id }` | Top of 5.4a |
| `wg.ideation.persona.done` | `{ territory_id, persona_id, candidate_count }` | After each persona's parallel ideation promise resolves |
| `wg.ideation.done` | `{ territory_id, total_candidates }` | End of 5.4a |
| `wg.adversarial.start` | `{ territory_id }` | Top of 5.4b |
| `wg.adversarial.done` | `{ territory_id, mark_count, partial }` | End of 5.4b |
| `wg.alignment.start` | `{ territory_id }` | Top of 5.4c |
| `wg.alignment.done` | `{ territory_id, move_count, aligned_count, by_origin: { aligned, minority_<persona_id> } }` | End of 5.4c |
| `wg.researcher.start` | `{ territory_id, aligned_id, question }` | Top of `researchOne` for each aligned question |
| `wg.researcher.turn` | `{ territory_id, aligned_id, turn_index, stop_reason, server_tool_calls, forced }` | After each researcher loop turn |
| `wg.researcher.web_search` | `{ territory_id, aligned_id, query }` | Per `server_tool_use` block of type `web_search` |
| `wg.researcher.web_fetch` | `{ territory_id, aligned_id, url }` | Per `server_tool_use` block of type `web_fetch` |
| `wg.researcher.done` | `{ territory_id, aligned_id, outcome, finding_count }` | After researcher emits report |
| `wg.observation.start` | `{ territory_id }` | Top of 5.4e |
| `wg.observation.done` | `{ territory_id, observation_count }` | End of 5.4e |
| `wg.debate.start` | `{ territory_id }` | Top of 5.4f |
| `wg.debate.done` | `{ territory_id, move_count, claim_count, terminated_by }` | End of 5.4f |
| `wg.move` | `{ territory_id, phase, move_id, persona_id, type, confidence? }` | Each accepted move in either sub-stage |
| `wg.nicknames.done` | `{ territory_id, sub_stage, count }` | Cosmetic post-processing after `wg.end`: after the per-WG nicknamer attaches kebab-case display labels to every move + observation. `sub_stage` identifies which batch was named (e.g. `alignment`, `debate`). Not a pipeline sub-stage — dashboards should not surface a substage indicator for it. Absent if the nicknamer produced nothing (empty batch or LLM failure). |
| `wg.nicknames.failed` | `{ territory_id, sub_stage, attempted, reason, detail }` | LLM failure path inside `attachNicknames`: emitted when the nicknamer returns zero labels for the batch. `attempted` is the count of items submitted; `reason`/`detail` come from the underlying `generateNicknames` error info. |
| `wg.end` | `{ territory_id, candidate_count, aligned_count, report_count, observation_count, claim_count, terminated_by }` | Emitted before the cosmetic nicknamer awaits, so the dashboard advances the WG card off the critical path |
| `wg.failed` | `{ territory_id, reason }` | When `runWorkingGroupsConcurrently` sees a `Promise.allSettled` rejection |

`wg.move.phase` is `alignment` or `debate`. `wg.move.type` is one of `Propose | Sharpen | Merge | Drop | Defer` for alignment, or `Claim | Support | Rebut | Question | Concede` for debate. `confidence` is only present on debate moves.

## Cross-pollination (stage 5)

| Event | Payload (core) | When emitted |
|---|---|---|
| `cross_pollination.reaction` | `{ persona_id, reactor_territory, target_territory, references_claim_id, type, confidence }` (`type` ∈ Rebut / Concede / Question) | After each accepted reaction |
| `cross_pollination.done` | `{ reaction_count }` | End of stage |

## Forum (stage 6)

| Event | Payload (core) | When emitted |
|---|---|---|
| `forum.contradiction.judged` | `{ a_node, b_node, contradicts }` | Each contradiction LLM call resolves |
| `forum.nicknames.done` | `{ count }` | Cosmetic post-processing inside `aggregateForum`: after the forum nicknamer attaches kebab-case display labels to every node. No `territory_id` (cross-territory batch). Absent if the nicknamer produced nothing. |
| `forum.nicknames.failed` | `{ attempted, reason, detail }` | LLM failure path inside `attachForumNicknames`: emitted when the nicknamer returns zero labels for the cross-territory batch. `attempted` is the count of nodes submitted; `reason`/`detail` come from the underlying `generateNicknames` error info. |
| `forum.done` | `{ node_count, contradiction_count, dead_end_count }` | End of stage |

## Synthesizer (stage 7)

| Event | Payload (core) | When emitted |
|---|---|---|
| `synthesizer.done` | `{ headline_count, tension_count, has_question_landscape, has_dead_end_summary, section_count }` | After tool emit parses |

## API queue (cross-cutting)

Emitted from `src/api_queue.js`. `call_id` is a monotonic counter, `outcome` is `ok` or `failed`. Token counts are present on `ok`; `attempt` and `error_message` are present on `failed`.

| Event | Payload (core) | When emitted |
|---|---|---|
| `api.call.start` | `{ call_id, model }` | Inside `enqueue` after slot acquired |
| `api.call.retry` | `{ call_id, attempt, reason, wait_ms }` | Inside `runWithRetries` retry branch |
| `api.call.end` | `{ call_id, outcome, ms, input_tokens?, output_tokens?, attempt?, error_message? }` | After `fn()` returns OR after the final retry throws |

`api.*` events are high-frequency (hundreds per run). The `dashboard` aggregates them into a queue-status header; the `log` mode mutes them by default (toggleable with `--verbose-api`); `debug` lets them through verbatim.

## Event-count expectations

For a typical v5 run (4 territories, 5 aligned questions each, 200–300k tokens):

| Event class | Count |
|---|---|
| `pipeline.*` lifecycle | ~16 |
| `discovery.*` | ~10 |
| `coordinator.*` | ~1 |
| `wg.*` (per territory ~40) | ~160 |
| `cross_pollination.*` | ~10 |
| `forum.*` | ~25 |
| `synthesizer.*` | ~1 |
| `api.call.*` | ~250–500 |

Total ~500–800 events per run. `events.jsonl` typically stays under 200KB per idea; the file is append-only and not rotated.

## Adding a new event

1. Register the name as a new key in the `EVENTS` enum in `src/bus.js`. Names use `dotted.case`; group by the same `pipeline.* | discovery.* | coordinator.* | wg.* | cross_pollination.* | forum.* | synthesizer.* | api.call.*` prefixes.
2. Emit it from the pipeline call site via `bus.emit(EVENTS.YOUR_EVENT, { …core payload })`. Do not include `ts`, `idea_id`, or `name` — `bus.emit` injects the envelope.
3. If it should appear in `log` mode, add a formatter clause in `src/tui/log.js`. Pick a sensible `[stage]` tag and `[level]` (info/warn/error). High-frequency events should be muted unless `--verbose-api` is on (mirror the `api.*` handling).
4. If it affects dashboard state, add a reducer case in `src/tui/dashboard/reducer.js`. The reducer is a pure `(state, event) => state` function; add table-driven tests in `test/tui/dashboard.test.js`.
5. Add a row to the appropriate table in this file.

The `debug` TUI and the event recorder need no changes — both are payload-agnostic.

## Appendix: SSE wire protocol (`/events/stream`)

The bus vocabulary above is also exposed over Server-Sent Events for the live `msv inspect` dashboard. The endpoint is implemented in `src/inspect/live/eventBroker.js` and registered as a Vite middleware in `src/inspect/server.js`.

- **Endpoint**: `GET /events/stream` (other methods return `405`).
- **Content-Type**: `text/event-stream` (with `Cache-Control: no-store`, `Connection: keep-alive`).
- **Named SSE event types**:
  - `event` — `data` is a single bus envelope JSON (the same object documented above, including the `ts`/`idea_id`/`name` envelope fields). Fires on every accepted event whose `idea_id` matches the broker's idea.
  - `view` — `data` is the full `InvestigationView` JSON. Fires on every rebuild.
- **On connect**: the broker replays its ring buffer of cached envelopes (up to 10,000) as `event` frames in batches of 100 via `setImmediate`, then sends the last cached `view` frame (if any). New live events are interleaved as they arrive.
- **Backpressure / limits**: at most 20 concurrent subscribers. Requests beyond the limit receive `503` and the connection is closed immediately. Writes that throw cause the subscriber to be dropped silently.
