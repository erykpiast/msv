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

### `msv inspect <id>`

Boots a local Vite dev server with a React SPA showing the full transcript of an investigation: the search queries discovery ran, every candidate persona (selected and cut), the coordinator's decomposition, every debate move with confidence and `evidence_basis`, the forum graph with contradiction edges, and the synthesis.

```bash
msv inspect 722b7e3c-e231-46c8-84cd-b2f272222323
msv inspect <id> --no-open    # don't open the browser; print URL only
msv inspect <id> --port 6000  # pin the port
```

The terminal stays attached until Ctrl-C. Editing files under `src/inspect-app/` triggers Vite HMR — the browser updates instantly. Data is read once at mount; re-run `msv inspect <id>` to refresh after a new `msv run`.

Each invocation regenerates `inspect-view.json` next to `index.json` in the idea directory. The file is `.gitignore`d and safe to delete — it always rebuilds from `index.json` + `logs/*.jsonl`.

#### Where things live (`src/inspect-app/`)

- `App.tsx` — Mantine `<AppShell>` layout, mounts every section
- `components/{Header,Timeline,Discovery,Coordinator,Debate,Forum,Synthesis}/` — one folder per section
- `theme/personas.ts` — Okabe-Ito palette + deterministic id-to-colour hash. Import `personaColor(id)` everywhere.
- `hooks/useView.ts` — fetches `/inspect-view.json` once at mount via `use(promise)`
- Mantine handles layout primitives; Emotion's `css` prop for custom one-off styles. No Tailwind.

The CLI side (`src/inspect/`) is plain JavaScript: `loader/` reads `index.json` + `logs/*.jsonl`, `view/build.js` derives the `InvestigationView` shape, `server.js` boots Vite with a `/inspect-view.json` middleware that streams the rebuilt view to the browser.

### `msv review`

Shows ready investigations one at a time with a steer card. Actions:

- `[r]` read full synthesis (paged via `less`)
- `[d]` deeper — spawn a follow-up idea, archive the current one
- `[k]` kill / archive
- `[n]` add steer notes
- `[i]` inspect — boot the visual transcript for this idea

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
