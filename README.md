# msv

`msv` is a local Node.js CLI prototype for running multi-agent LLM investigations of personal ideas.

- Single-user, terminal-only workflow.
- Local JSON storage under `~/.msv/`.
- Anthropic models: `claude-sonnet-4-6` (all interpretive stages), `claude-haiku-4-5` (synthesizer), via `ANTHROPIC_API_KEY`.
- Typical run target cost: **~$3–8** and **3–6 minutes** per v5 investigation (web-research-grounded).

The pipeline is documented in detail in [`specs/question-machine.md`](specs/question-machine.md) (v5) and [`specs/prototype.md`](specs/prototype.md) (v4 archive).

## Setup

```bash
npm install
export ANTHROPIC_API_KEY=sk-ant-...
```

## Commands

### `msv add`

Reads idea text from stdin, writes a pending idea directory under `~/.msv/ideas/<id>/`, then prints `captured <id>`.

```bash
echo "Should I start a small urban farm?" | msv add
msv add < notes.txt
msv add        # type, then Ctrl-D
```

### `msv run [--all | <id> [--restart]]`

Runs the v5 question-generation pipeline:

1. Perspective discovery (web-search-grounded persona candidates)
2. Diversity-aware selection (deterministic)
3. Coordinator decomposes the topic into **territories** and pairs personas
4. **Working groups** (parallel, one per territory) — six sub-stages each:
   - Independent ideation: each persona generates candidate questions
   - Adversarial pre-check: other persona marks which questions need research
   - Alignment debate: personas debate to pick the best questions
   - Researcher delegation: joint AI researcher (web_search + web_fetch) investigates each aligned question
   - Independent observation: each persona writes observations from findings
   - Pair debate: evidence-grounded debate moves with observation/finding citations
5. Cross-pollination round (deterministic reactor pairing)
6. Forum aggregation with contradiction detection + dead-end tracking
7. Synthesizer produces the user-facing report, question landscape, and dead-end summary

```bash
msv run [--all | <id>] [--tui=dashboard|log|debug|silent] [--verbose-api]
msv run --all
msv run 8db8e9bf-5cb7-4fda-a2a8-9796b0511f9d
msv run 8db8e9bf-5cb7-4fda-a2a8-9796b0511f9d --restart
```

#### Resumption

The pipeline persists a checkpoint after each macro stage and after each sub-stage within stage 4. On failure or `Ctrl-C` the idea is left in `investigating` state with the checkpoint pointer intact. Re-run `msv run <id>` to auto-resume from the last completed sub-stage — completed stages are skipped, the affected working group picks up where it stopped, and remaining territories run from scratch.

The persisted `investigation.last_failure` carries a typed reason (`anthropic_unavailable`, `user_cancelled`, `internal_error`) and the stage/territory/sub-stage where the error occurred. It's cleared on a successful resume.

To abandon prior progress and start over, use `--restart`. The previous logs and an `index.json.before-restart` snapshot are archived under `~/.msv/ideas/<id>/.attempts/<timestamp>/` for forensics; the active state is reset to `pending`.

`Ctrl-C` is cooperative: the first press finishes the current sub-stage, saves the checkpoint, and exits with code 130; a second press force-quits and may lose in-flight work.

Ideas written by older code (no `progress` field on `investigation`) are treated as "no resume anchor" — `msv run <id>` will print a notice and re-run from stage 1. Use `--restart` to archive their logs first.

See [`specs/feat-investigation-resumption.md`](specs/feat-investigation-resumption.md) for the full design.

#### Terminal output modes

`msv run` emits its progress through a typed event bus (`src/bus.js`); exactly one renderer subscribes per invocation. Pick one with `--tui=<name>`:

- `dashboard` — ink-rendered live dashboard (stage list, per-territory grid, budget header, recent-events tail). Default when stdout is a TTY.
- `log` — flat `[level] [stage] message` lines, one per event. Default for non-TTY (CI, redirected stdout).
- `debug` — every event flushed as one-line JSON. Use for grep/jq/replay.
- `silent` — no listener; useful when piping events through a custom consumer.

Auto-selection picks `log` if `CI` or `NO_TUI` is set, or if `process.stdout.isTTY` is false; otherwise `dashboard`. `--verbose-api` un-mutes the high-frequency `api.call.*` events in `log` mode (they are always on in `debug`, always aggregated in `dashboard`).

**Known break in log format.** The legacy `→ <id> [N/7] …` / `→      …` prefixes are gone. Anything that greps `msv run` output for `→` will need to switch to the new `[info] [stage] …` shape. Machine consumers should use `--tui=debug` (JSON lines) or read `events.jsonl` directly.

### `msv inspect <id>`

Boots a local Vite dev server with a React SPA that visualises the investigation
as an interactive pipeline graph. Stages render as boxes; lightweight stages
(Discovery, Coordinator, Cross-Pollination) expand in place; Working Groups and
the Forum drill into sub-canvases. Clicking a leaf (a debate move, a finding, a
forum claim) opens a side panel with the full content. Deep links survive
reload via the URL hash.

What you see in the canvas, by stage:

- Discovery: search queries, candidate personas, selection scores.
- Coordinator: territories with assigned persona pairs.
- Working groups: six sub-stages (Ideation, Adversarial, Alignment,
  Researcher, Observations, Debate) per territory.
- Cross-Pollination: reactions to surviving claims.
- Forum: surviving-claims graph with contradiction edges, dead-end list (v5).
- Synthesis: headline findings, structured sections, tension points, key
  references, next-pass proposals, question landscape (v5), dead-end summary
  (v5), full Markdown report.

The inspector detects `schema_version`. v4 ideas render a one-line empty state;
v5 ideas land on the graph.

```bash
msv inspect 722b7e3c-e231-46c8-84cd-b2f272222323
msv inspect <id> --no-open    # don't open the browser; print URL only
msv inspect <id> --port 6000  # pin the port
```

While `msv run <id>` is in progress, `msv inspect <id>` reflects pipeline state
live — stage nodes animate, drawer content populates as it is produced, and a
**LIVE** badge appears in the header. No refresh needed. When no run is active,
the inspector shows the last-persisted snapshot.

Live updates flow through an HTTP relay from `msv run` to the inspector. By
default the relay posts to the inspector on its auto-selected port. If you pin
a custom port via `--port`, set `MSV_INSPECT_URL=http://127.0.0.1:<port>/events`
before running `msv run` so events reach the right inspector. Set
`MSV_NO_RELAY=1` to disable live updates entirely (the inspector falls back to
the last-persisted snapshot).

The terminal stays attached until Ctrl-C.

### `msv review`

Shows ready investigations one at a time with a steer card. Actions:

- `[r]` read full synthesis (paged via `less`)
- `[q]` view full question landscape with provenance (v5 only)
- `[e]` view dead-end questions (v5 only)
- `[d]` deeper — spawn a follow-up idea, archive the current one
- `[k]` kill / archive
- `[n]` add steer notes
- `[i]` inspect — boot the visual transcript for this idea

```bash
msv review
```

### `msv list [<filter>]`

Lists ideas by status. Optional filter: `pending`, `investigating`, `ready`, `archived`.

```bash
msv list
msv list ready
```

## Storage layout

Each idea is a directory under `~/.msv/`:

```
~/.msv/ideas/<uuid>/
├── index.json                              # full investigation transcript (atomic writes)
├── events.jsonl                            # append-only event log; consumed by tools/stage-stats.js
└── logs/
    ├── discovery.jsonl                     # raw API exchanges per stage
    ├── coordinator.jsonl
    ├── pair-<tid>-ideation.jsonl           # v5: per-territory sub-stage logs
    ├── pair-<tid>-adversarial.jsonl
    ├── pair-<tid>-alignment.jsonl
    ├── pair-<tid>-researcher-<aqId>.jsonl  # v5: per-aligned-question researcher log
    ├── pair-<tid>-observation.jsonl
    ├── pair-<tid>-debate.jsonl
    ├── cross-pollination.jsonl
    ├── forum-contradictions.jsonl
    ├── synthesizer.jsonl
    └── parse-errors.jsonl
```

Archived ideas move to `~/.msv/archive/<uuid>/`. Debug raw transcripts with:

```bash
cat ~/.msv/ideas/<id>/index.json | jq
jq -s . ~/.msv/ideas/<id>/logs/pair-t_001-debate.jsonl
```

## Tests

```bash
CI=true npm test
```

Tests cover the deterministic pieces (moves, diversity, forum aggregation rules, working-group alignment, storage). LLM-driven stages are exercised by running real investigations against the API.

## Cost and runtime

**v5 pipeline** (current default):

- Tokens: ~150k–250k per run (Sonnet 4.6 for all interpretive stages; Haiku 4.5 for synthesis)
- Cost: ~$3–8 at current pricing
- Wall time: ~3–6 minutes (parallel working groups dominate; each territory runs concurrently)
- Researcher tool calls: up to 60 total across all working groups (10 tool-call budget per aligned question × up to 5 questions per territory)

The higher cost versus v4 reflects the joint AI researcher sub-agent conducting real web research per aligned question, which is the core mechanism for producing evidence-grounded questions a single-agent pass would never surface.

Concurrent invocations are not supported — no inter-process locking. Don't run two `msv run` instances against the same idea in parallel; the lack of a lock file means a stale checkpoint write can regress progress.
