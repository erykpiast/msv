# msv

`msv` is a local Node.js CLI prototype for running multi-agent LLM investigations of personal ideas.

- Single-user, terminal-only workflow.
- Local JSON storage under `~/.msv/`.
- Anthropic model: `claude-sonnet-4-6` (set via `ANTHROPIC_API_KEY`).
- Typical run target cost: **~$1–3** and **1–3 minutes** per full investigation.

The pipeline is documented in detail in [`specs/prototype.md`](specs/prototype.md).

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

### `msv run [--all | <id>]`

Runs the 7-stage investigation pipeline:

1. Perspective discovery (web-search-grounded persona candidates)
2. Diversity-aware selection (deterministic)
3. Coordinator decomposes the topic into sub-questions and pairs personas
4. Working groups — parallel pair debates with calcification enforcement
5. Cross-pollination round (deterministic reactor pairing)
6. Forum aggregation with contradiction detection
7. Synthesizer produces the user-facing opinionated report

```bash
msv run --all
msv run 8db8e9bf-5cb7-4fda-a2a8-9796b0511f9d
```

On failure the idea is left in `investigating` state. To retry, hand-edit `~/.msv/ideas/<id>/index.json`: set `status` back to `"pending"`, clear `investigation.completed_at`, then re-run `msv run <id>`.

### `msv review`

Shows ready investigations one at a time with a steer card. Actions:

- `[r]` read full synthesis (paged via `less`)
- `[d]` deeper — spawn a follow-up idea, archive the current one
- `[k]` kill / archive
- `[n]` add steer notes

```bash
msv review
```

## Storage layout

Each idea is a directory under `~/.msv/`:

```
~/.msv/ideas/<uuid>/
├── index.json                       # full investigation transcript (atomic writes)
└── logs/
    ├── discovery.jsonl              # raw API exchanges per stage
    ├── coordinator-initial.jsonl
    ├── coordinator-spawn.jsonl
    ├── pair-<sq_id>.jsonl
    ├── cross-pollination.jsonl
    ├── forum-contradictions.jsonl
    ├── synthesizer.jsonl
    └── parse-errors.jsonl
```

Archived ideas move to `~/.msv/archive/<uuid>/`. Debug raw transcripts with:

```bash
cat ~/.msv/ideas/<id>/index.json | jq
jq -s . ~/.msv/ideas/<id>/logs/pair-sq_002.jsonl
```

## Tests

```bash
CI=true npm test
```

Tests cover the deterministic pieces (moves, diversity, forum aggregation rules, storage). LLM-driven stages are exercised by running real investigations against the API.

## Cost and runtime

Per the spec: roughly 70k–100k tokens per run, $1–3 at current pricing. Wall time is dominated by parallel pair debates (30–60 seconds) plus ~5 seconds per other stage. Expect 1–3 minutes per run.

Concurrent invocations are not supported — no locking. Don't run two `msv run --all` instances in parallel.
