# Inspect test fixtures

Each subdirectory mirrors the shape of `~/.msv/ideas/<uuid>/`:

- `ready/` — full investigation, all stages complete. Sourced from
  `~/.msv/archive/722b7e3c-e231-46c8-84cd-b2f272222323`.
- `investigating/` — same source as `ready/`, trimmed to stages 1–2 only
  (discovery + coordinator initial). Used to exercise the inspector's
  partial-transcript handling.
- `degraded-discovery/` — sourced from
  `~/.msv/ideas/f61fd8b6-59b0-4b90-97ec-7b41e36a7610`, where discovery
  returned zero candidate personas and the selector fell back to
  skeptic+builder only.

## Regenerating from a fresh run

```bash
MSV_ROOT=$(mktemp -d) msv add < topic.txt
MSV_ROOT=<that-dir> msv run --all
cp -r <that-dir>/ideas/<uuid>/{index.json,logs} test/fixtures/inspect/ready/
```

### Regenerating `investigating/` from `ready/`

The `investigating/` fixture is a hand-trimmed copy of `ready/` that simulates
a partial transcript (only the first two stages complete). Run from the repo
root:

```bash
cp -r test/fixtures/inspect/ready/{index.json,logs} test/fixtures/inspect/investigating/
jq '.status = "investigating"
    | .investigation.completed_at = null
    | .investigation.pair_debates = []
    | .investigation.cross_pollination = []
    | .investigation.forum = { constructed_at: null, nodes: [] }
    | .investigation.synthesis = null
    | .investigation.coordinator_decisions.spawn = null' \
  test/fixtures/inspect/ready/index.json \
  > test/fixtures/inspect/investigating/index.json
# Keep only the discovery + coordinator-initial logs.
find test/fixtures/inspect/investigating/logs -mindepth 1 \
  ! -name 'discovery.jsonl' \
  ! -name 'coordinator-initial.jsonl' \
  -delete
```

The exact field set the trim clears: `status`, `investigation.completed_at`,
`investigation.pair_debates`, `investigation.cross_pollination`,
`investigation.forum`, `investigation.synthesis`,
`investigation.coordinator_decisions.spawn`. Only `discovery.jsonl` and
`coordinator-initial.jsonl` survive under `logs/`.

### Regenerating `degraded-discovery/`

Find an idea whose `investigation.perspective_discovery.candidate_personas`
is `[]` and copy its `index.json` + `logs/` verbatim. The current fixture is
sourced from `~/.msv/ideas/f61fd8b6-59b0-4b90-97ec-7b41e36a7610`.
