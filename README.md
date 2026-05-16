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

### `msv run [--all | <id>]`

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
msv run --all
msv run 8db8e9bf-5cb7-4fda-a2a8-9796b0511f9d
```

On failure the idea is left in `investigating` state. To retry, hand-edit `~/.msv/ideas/<id>/index.json`: set `status` back to `"pending"`, clear `investigation.completed_at`, then re-run `msv run <id>`.

### `msv inspect <id>`

Boots a local Vite dev server with a React SPA showing the full transcript of an investigation. For v5 ideas, the inspector shows:

- Discovery: search queries, candidate personas
- Territories: coordinator output with assigned pairs
- Working groups: tabbed view per territory — Ideation, Adversarial marks, Alignment questions, Researcher reports (findings per aligned question), Observations, Pair debate
- Forum: surviving claims graph, contradiction edges, dead-end panel (v5)
- Synthesis: headline findings, question landscape (v5), dead-end summary (v5), report

The inspector detects `schema_version` and routes v4 and v5 ideas through separate component trees.

```bash
msv inspect 722b7e3c-e231-46c8-84cd-b2f272222323
msv inspect <id> --no-open    # don't open the browser; print URL only
msv inspect <id> --port 6000  # pin the port
```

The terminal stays attached until Ctrl-C. Data is read once at mount; re-run `msv inspect <id>` to refresh after a new `msv run`.

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

Concurrent invocations are not supported — no locking. Don't run two `msv run --all` instances in parallel.
