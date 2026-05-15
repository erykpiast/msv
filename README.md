# msv

`msv` is a local Node.js CLI prototype for running multi-agent LLM investigations of personal ideas.

- Single-user, terminal-only workflow
- Local JSON storage under `~/.msv/`
- Anthropic model: `claude-sonnet-4-20250514`
- Typical run target cost: **~$1–3** and **1–3 minutes** per full investigation

## Commands

### `msv add`

Reads idea text from `stdin`, writes a pending idea JSON file in `~/.msv/ideas/`, then prints the generated id.

```bash
echo "Should I start a small urban farm?" | msv add
```

### `msv run [--all | <id>]`

Finds pending ideas and starts the 7-stage investigation pipeline scaffold. This repository currently includes the command plumbing, data model, and persistence scaffolding; prompts and full orchestration are intentionally left for iterative development against real runs.

```bash
msv run --all
msv run 8db8e9bf-5cb7-4fda-a2a8-9796b0511f9d
```

### `msv review`

Shows ready investigations one at a time with a steer card. Actions:

- `[r]` read synthesis
- `[d]` deeper (creates a linked follow-up idea)
- `[k]` kill/archive
- `[n]` add steer notes

```bash
msv review
```

## Storage layout

`msv` writes one JSON file per idea:

- `~/.msv/ideas/<uuid>.json` for active ideas
- `~/.msv/archive/<uuid>.json` for archived ideas

Writes are atomic (`tmp` + `rename`) to preserve partial state safely on failure.
