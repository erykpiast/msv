# Task Breakdown: Research Process Visualisation (`msv inspect`)

Generated: 2026-05-16
Source: `specs/feat-research-process-visualisation.md`

## Overview

Implement `msv inspect <id>` — a CLI command that boots a Vite dev server hosting a React 19 SPA over the full transcript of an investigation. The CLI side is plain JavaScript; the SPA is TypeScript-only. Two implementation phases:

- **Phase 1**: end-to-end skeleton — every section renders, Forum graph displays contradictions, synthesis is readable.
- **Phase 2**: deep agent-interaction inspection (Forum tabs, NodeDrawer, persona matrix, cross-pollination edges, hash routing) + web-search result capture.

Phase 3 (claim provenance) is explicitly out of scope.

## Foundational facts (referenced by every task)

- Repo root: `/Users/eryk.napierala/Projects/msv`
- CLI source: plain JS under `src/`
- SPA source: TS under `src/inspect-app/` only
- Node `>= 20`
- Existing CLI deps: `@anthropic-ai/sdk@0.54.0`, `uuid@11.1.1`
- Idea storage: `~/.msv/ideas/<uuid>/index.json` + `logs/*.jsonl` (or `~/.msv/archive/<uuid>/...` once archived)
- Reference runs to test against:
  - `~/.msv/archive/722b7e3c-e231-46c8-84cd-b2f272222323/` — full `ready` run, 6 sub-questions, ~70 moves, 12 forum nodes, ~503k tokens. **Budget overshoot — use to verify red budget bar.**
  - `~/.msv/ideas/f61fd8b6-59b0-4b90-97ec-7b41e36a7610/` — degraded discovery (`candidate_personas: []`), 5 sub-questions all skeptic-vs-builder, 50 moves, 10 forum nodes.
- Persona colour palette (Okabe-Ito, colourblind-safe, WCAG AA against `#FFFFFF`):
  `['#E69F00', '#56B4E9', '#009E73', '#F0E442', '#0072B2', '#D55E00', '#CC79A7', '#000000']`

---

## Phase 1 — Foundation + skeleton SPA

### Task 1.1: Project config — dependencies, Vite, TypeScript, HTML entry

**Description**: Install runtime + dev dependencies; add `vite.config.ts`, `index.html`, `tsconfig.inspect-app.json`, `.gitignore` patterns.
**Size**: Small
**Priority**: High
**Dependencies**: None
**Can run parallel with**: 1.2

**Technical Requirements**:

Install via npm. Versions latest (let registry resolve majors):

| Package | Range | Notes |
|---|---|---|
| `vite` | `^8` | Programmatic API, used at command time only |
| `@vitejs/plugin-react` | `^6` | JSX/TSX transform |
| `react`, `react-dom` | `^19` | UI runtime |
| `typescript` | `^5.6` | Type checker; SPA only |
| `@emotion/react` | `^11` | `css` prop for app styling |
| `@mantine/core`, `@mantine/hooks` | `^9` | Layout primitives; ships CSS modules (no Emotion conflict) |
| `@xyflow/react` | `^12` | Forum graph |
| `recharts` | `^3` | Confidence sparklines |
| `react-markdown` | `^10` | Synthesis report |
| `rehype-sanitize` | `^6` | Default-on sanitiser |

CLI runtime deps (`@anthropic-ai/sdk`, `uuid`) remain unchanged. Mantine v9 uses CSS modules — its CSS must be imported in `main.tsx` with `import '@mantine/core/styles.css'`.

**Files to create**:

`vite.config.ts`:
```ts
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  root: '.',
  plugins: [react()],
  resolve: { alias: { '@app': '/src/inspect-app' } },
  // server.fs.allow and the /inspect-view.json middleware are set
  // programmatically by src/inspect/server.js per invocation.
});
```

`tsconfig.inspect-app.json`:
```json
{
  "compilerOptions": {
    "target": "ES2022",
    "lib": ["ES2022", "DOM", "DOM.Iterable"],
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "jsx": "react-jsx",
    "strict": true,
    "noUnusedLocals": true,
    "noUnusedParameters": true,
    "noFallthroughCasesInSwitch": true,
    "skipLibCheck": true,
    "isolatedModules": true,
    "esModuleInterop": true,
    "allowSyntheticDefaultImports": true,
    "resolveJsonModule": true,
    "noEmit": true,
    "types": ["vite/client"]
  },
  "include": ["src/inspect-app/**/*"]
}
```

`index.html` (Vite entry at repo root):
```html
<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>msv inspect</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/inspect-app/main.tsx"></script>
  </body>
</html>
```

`.gitignore` additions:
```
node_modules/.vite/
inspect-view.json
```

**Acceptance Criteria**:
- [ ] `npm install` completes without errors
- [ ] `package.json` `engines.node` remains `>=20`
- [ ] `vite.config.ts`, `index.html`, `tsconfig.inspect-app.json` at repo root
- [ ] `.gitignore` includes `node_modules/.vite/` and `inspect-view.json`
- [ ] `npx tsc --noEmit -p tsconfig.inspect-app.json` succeeds (with zero source files yet — the include glob matches nothing)

---

### Task 1.2: `storage.atomicWriteText` helper + test

**Description**: Add a string-writing sibling to `storage.atomicWriteJson` for non-JSON atomic writes; test temp-file cleanup on error.
**Size**: Small
**Priority**: High
**Dependencies**: None
**Can run parallel with**: 1.1

**Technical Requirements**:

`storage.atomicWriteJson` is JSON-only (it calls `JSON.stringify` and adds a trailing newline). The inspector needs to write arbitrary strings (`inspect-view.json` is JSON, but later may serialise other formats). Add `atomicWriteText(path, text)` next to it.

**Implementation** — extend `src/storage.js`:

```js
async function atomicWriteText(filePath, text) {
  const dir = path.dirname(filePath);
  const tmpPath = path.join(
    dir,
    `.${path.basename(filePath)}.${process.pid}.${Date.now()}.tmp`
  );
  await fs.writeFile(tmpPath, text, 'utf8');
  await fs.rename(tmpPath, filePath);
}
```

Export it from `module.exports`. Refactor `atomicWriteJson` to delegate to `atomicWriteText` if convenient (optional — both being separate is fine).

**Test** — add to `test/storage.test.js` (or create `test/inspect/storage.test.js` if the file's convention is one suite per concern):

```js
test('atomicWriteText writes and renames atomically', async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'msv-aw-'));
  const target = path.join(tmp, 'out.html');
  await atomicWriteText(target, '<!doctype html>\n');
  assert.equal(await fs.readFile(target, 'utf8'), '<!doctype html>\n');
});

test('atomicWriteText leaves prior content intact on rename failure', async () => {
  // Pre-create the file, then mock fs.rename to throw.
  // Assert the original content is unchanged and the .tmp file is gone.
});
```

**Acceptance Criteria**:
- [ ] `storage.atomicWriteText(path, string)` exported from `src/storage.js`
- [ ] Uses tmp + rename pattern identical to `atomicWriteJson`
- [ ] At least one passing test for round-trip
- [ ] At least one test asserting prior content intact + tmp cleaned up on error
- [ ] `CI=true npm test` passes

---

### Task 1.3: Loader — readers (`readIndex.js`, `readLogs.js`)

**Description**: Build the file-reading layer that turns an idea directory into raw structured data ready for enrichment.
**Size**: Small
**Priority**: High
**Dependencies**: None
**Can run parallel with**: 1.1, 1.2

**Technical Requirements**:

Two pure async functions, both under `src/inspect/loader/`.

`readIndex.js`:
- Export `async function readIndex(ideaDir): Promise<object>` that reads `index.json`, parses, returns the object.
- Throws on JSON parse failure with file path included.

`readLogs.js`:
- Export `async function readLogs(ideaDir): Promise<Record<string, object[]>>` that scans `logs/*.jsonl` and returns a map: `{ 'discovery': [parsed lines], 'pair-sq_001': [...], 'forum-contradictions': [...], ... }`.
- Tolerates missing log files (returns no key for missing logs; does not throw).
- One parsed object per line; ignores empty lines.
- Filename → key: strip the `.jsonl` extension. So `pair-sq_001.jsonl` becomes the key `pair-sq_001`.

`src/inspect/loader/index.js`:
- Export `async function buildLoaderInput(ideaDir): Promise<LoaderInput>` that calls both readers in parallel via `Promise.all`, returns `{ index, logs }`.

**Files to create**: `src/inspect/loader/readIndex.js`, `src/inspect/loader/readLogs.js`, `src/inspect/loader/index.js`.

**Reference shape — the keys present in real runs**:
```
discovery, coordinator-initial, coordinator-spawn, pair-sq_001, pair-sq_002, ..., cross-pollination, forum-contradictions, synthesizer, parse-errors
```
(see `/Users/eryk.napierala/.msv/archive/722b7e3c-…/logs/` for examples)

**Acceptance Criteria**:
- [ ] `readIndex(dir)` returns the parsed `index.json` object
- [ ] `readLogs(dir)` returns a flat map keyed by filename stem
- [ ] Missing `logs/` directory returns `{}` rather than throwing
- [ ] `buildLoaderInput(dir)` runs the two reads in parallel
- [ ] JSON parse errors include the file path in the message

---

### Task 1.4: Loader — per-stage enrichments

**Description**: Bridge raw `index.json` stage data with the matching `logs/*.jsonl` data into a normalised `loaderInput.enrichments` object.
**Size**: Medium
**Priority**: High
**Dependencies**: 1.3
**Can run parallel with**: 1.5

**Technical Requirements**:

One enrichment file per stage under `src/inspect/loader/enrichments/`. Each exports a single function. All functions are pure (no IO).

Per the spec §8.4:

- `discovery.js` → `{ timings, web_search_results }`. Phase 1: `web_search_results = []`. Timings = `{ started_at, completed_at }` derived from first/last log lines.
- `coordinator.js` → `{ timings, spawn_reason }`. `spawn_reason` reads the `declined` record's `reason` field from `coordinator-spawn.jsonl` when `index.investigation.coordinator_decisions.spawn.sub_questions === []`.
- `debates.js` → per-sub-question enrichment: for each `pair_debates[]` entry, find the matching `pair-sq_<id>.jsonl` log; for each move in `moves[]`, attach `{ attempt, synthesized, usage }` extracted from the matching log entry where `payload.persona_id === move.by_persona_id` and `payload.sequence === <derived from move_id>`. Move log entries record `attempt`, `usage`, and `raw_input`; `synthesized: true` is on `kind: synthesized_move` records.
- `crossPollination.js` → for each `cross_pollination[]` entry, per-reaction `timings` from `cross-pollination.jsonl`.
- `forum.js` → `contradiction_verdicts: { key: { contradicts, reason, usage } }`. Keys are the same sorted `claim_id_a|claim_id_b` convention `src/forum.js#contradictionKey` uses. Reuse that import: `require('../../forum').contradictionKey`. Read every `response` record in `forum-contradictions.jsonl` and map by `payload.key`.
- `synthesis.js` → `{ timings }` from `synthesizer.jsonl`.
- `parseErrors.js` → return `parse_errors: [{ stage, persona_id, errors, raw }]` extracted from `parse-errors.jsonl` entries (records have `kind: rejected_move` or `kind: rejected_reaction`).

Each enrichment must tolerate missing log files — return its structured fallback (empty timings, empty verdicts) and log to stderr.

**Files to create**: 7 files in `src/inspect/loader/enrichments/`.

Update `src/inspect/loader/index.js` to call all enrichments and attach results under `loaderInput.enrichments.{discovery, coordinator, debates, crossPollination, forum, synthesis, parseErrors}`.

**Acceptance Criteria**:
- [ ] Each of the 7 enrichment files exports a pure function
- [ ] All enrichments tolerate missing log files without throwing
- [ ] `forum.js` enrichment uses `contradictionKey` from `src/forum.js` (single source of truth)
- [ ] `loaderInput.enrichments` shape matches the spec §8.4
- [ ] Verified against the `722b7e3c-…` fixture: forum has 5 contradiction verdicts; debates have attempt counts on every move

---

### Task 1.5: View builder + derivations

**Description**: Pure function from `loaderInput` to the `InvestigationView` consumed by the React app.
**Size**: Medium
**Priority**: High
**Dependencies**: 1.3 (for the input shape)
**Can run parallel with**: 1.4 (derivations don't depend on enrichments — `view/build.js` orchestrates both)

**Technical Requirements**:

`src/inspect/view/build.js` — exports `buildView(loaderInput): InvestigationView`. Composes the shape defined in spec §8.5:

```text
InvestigationView {
  id, raw_capture, status, parent_id,
  captured_at, last_action_at,

  budget: { used_executor_calls, max_executor_calls,
            used_total_tokens, max_total_tokens, runtime_ms },

  stages: [
    { key, label, status: 'done' | 'partial' | 'skipped' | 'failed' | 'not_run',
      started_at, completed_at, duration_ms,
      summary: '...', detail_ref: 'discovery' | 'coordinator' | ... }
  ],

  discovery: {
    search_queries: [string],
    web_search_results: [{ query, results: [{ title, url, page_age }] }],
    candidate_personas: [Persona],
    selected_persona_ids: [string],
    fixed_personas: [string],
    selection_distinctness: { p_id: number }   // derived
  },

  coordinator: {
    initial: { decided_at, sub_questions: [SubQ] },
    spawn: { decided_at, sub_questions: [SubQ], reason, declined: bool }
  },

  debates: {
    [sq_id]: {
      sub_question: SubQ, pair: [Persona, Persona],
      moves: [Move], surviving_claims: [Claim],
      terminated_by: string,
      confidence_trajectory: [{ move_id, persona_id, confidence, type }],
      synthesized_move_count: number
    }
  },

  cross_pollination: [{
    claim_id, reactions: [Reaction],
    target_node_id: string
  }],

  forum: {
    nodes: [Node],
    contradiction_edges: [{ from_node_id, to_node_id, reason }]
  },

  synthesis: {
    report: string, headline_findings: [string], open_tensions: [string]
  },

  parse_errors: [{ stage, persona_id, errors, raw }]
}
```

`src/inspect/view/derive/` — one file per derived field:

- `confidenceTrajectory.js` → `deriveConfidenceTrajectory(debate): Array<{move_id, persona_id, confidence, type}>` — chronological order; one entry per move.
- `contradictionEdges.js` → `deriveContradictionEdges(forumNodes, contradictionVerdicts): Array<{from_node_id, to_node_id, reason}>` — deduplicated by undirected pair. Each node may have `contradiction_with_node_id` pointing to another; collect every such pair, normalise (sorted ids), dedupe.
- `personaInteractions.js` → `derivePersonaInteractions(debates): Record<personaId, Record<personaId, {Rebut, Concede, Question, Support}>>` — matrix from `pair_debates[].moves[].references_move_id` chains. For each non-Claim move M authored by A that references move R authored by B, increment `matrix[A][B][M.type]`.
- `stageDurations.js` → `deriveStageDurations(loaderInput): Array<{key, label, status, started_at, completed_at, duration_ms}>` — one entry per pipeline stage. `duration_ms = null` when either timestamp is null. Status `not_run` when both timestamps are null. Status `partial` when started but not completed.

The view builder calls each derivation and assembles the InvestigationView. Plain functions, no classes.

**Files to create**: `src/inspect/view/build.js`, 4 files under `src/inspect/view/derive/`.

**Acceptance Criteria**:
- [ ] `buildView(loaderInput)` returns the InvestigationView shape per spec §8.5
- [ ] All derivation functions are pure (no IO, no globals)
- [ ] `contradiction_edges` deduplicates: same A↔B pair appears once regardless of direction
- [ ] `personaInteractions` correctly classifies moves by type
- [ ] `stages[].duration_ms === null` when `completed_at` is missing
- [ ] Verified against the `722b7e3c-…` fixture: 7 stages, 12 forum nodes, 5 contradiction edges

---

### Task 1.6: JSDoc types — `src/inspect/types.d.ts`

**Description**: Shared type definitions used by both the JS loader/view-builder (via JSDoc imports) and the TS SPA (via direct type imports). Single source of truth for `InvestigationView` and its sub-types.
**Size**: Small
**Priority**: Medium
**Dependencies**: 1.5
**Can run parallel with**: 1.7, 1.8

**Technical Requirements**:

Write a `.d.ts` file declaring the full shape from §8.5. Both `view/build.js` (via `@typedef` JSDoc) and `src/inspect-app/` (via `import type`) consume it.

```ts
// src/inspect/types.d.ts

export type Persona = {
  id: string;
  name: string;
  tradition?: string;
  stance?: string;
  description: string;
};

export type SubQ = {
  id: string;
  question: string;
  rationale: string;
  assigned_pair: [string, string];
  pair_distinctness_score: number;
};

export type Move = {
  move_id: string;
  by_persona_id: string;
  type: 'Claim' | 'Support' | 'Rebut' | 'Question' | 'Concede';
  content: string;
  evidence_basis: string;
  confidence: number;
  references_move_id: string | null;
  timestamp: string;
  synthesized?: boolean;
  attempt?: number;
  usage?: { input: number; output: number; total: number };
};

export type Claim = {
  claim_id: string;
  originating_move_id: string;
  content: string;
  confidence_after_debate: number;
  concession_status: 'none' | 'partial' | 'full';
};

export type Reaction = {
  by_persona_id: string;
  type: 'Rebut' | 'Question' | 'Concede';
  content: string;
  evidence_basis: string;
  confidence: number;
};

export type ForumNode = {
  node_id: string;
  claim_id: string;
  working_group_id: string;
  content: string;
  aggregate_confidence: number;
  contradiction_with_node_id: string | null;
  has_open_question: boolean;
  reactions?: Reaction[];
  survival_rank: number;
};

export type Stage = {
  key: 'discovery' | 'selection' | 'coordinator' | 'debates' | 'cross_pollination'
       | 'forum' | 'synthesis' | 'spawn';
  label: string;
  status: 'done' | 'partial' | 'skipped' | 'failed' | 'not_run';
  started_at: string | null;
  completed_at: string | null;
  duration_ms: number | null;
  summary: string;
  detail_ref: string;
};

export type InvestigationView = {
  id: string;
  raw_capture: string;
  status: 'pending' | 'investigating' | 'ready' | 'archived';
  parent_id: string | null;
  captured_at: string;
  last_action_at: string;
  budget: {
    used_executor_calls: number;
    max_executor_calls: number;
    used_total_tokens: number;
    max_total_tokens: number;
    runtime_ms: number | null;
  };
  stages: Stage[];
  discovery: {
    search_queries: string[];
    web_search_results: Array<{ query: string; results: Array<{ title: string; url: string; page_age: string | null }> }>;
    candidate_personas: Persona[];
    selected_persona_ids: string[];
    fixed_personas: string[];
    selection_distinctness: Record<string, number>;
  };
  coordinator: {
    initial: { decided_at: string; sub_questions: SubQ[] };
    spawn: { decided_at: string; sub_questions: SubQ[]; reason: string; declined: boolean };
  };
  debates: Record<string, {
    sub_question: SubQ;
    pair: [Persona, Persona];
    moves: Move[];
    surviving_claims: Claim[];
    terminated_by: string;
    confidence_trajectory: Array<{ move_id: string; persona_id: string; confidence: number; type: Move['type'] }>;
    synthesized_move_count: number;
  }>;
  cross_pollination: Array<{
    claim_id: string;
    reactions: Reaction[];
    target_node_id: string;
  }>;
  forum: {
    nodes: ForumNode[];
    contradiction_edges: Array<{ from_node_id: string; to_node_id: string; reason: string }>;
  };
  synthesis: {
    report: string;
    headline_findings: string[];
    open_tensions: string[];
  } | null;
  parse_errors: Array<{ stage: string; persona_id: string | null; errors: string[]; raw: unknown }>;
};
```

In `view/build.js`, reference these via JSDoc:
```js
/** @typedef {import('../types').InvestigationView} InvestigationView */
```

**Acceptance Criteria**:
- [ ] `src/inspect/types.d.ts` exports every type the spec §8.5 names
- [ ] `view/build.js` references them via JSDoc `@typedef`
- [ ] `tsc --noEmit -p tsconfig.inspect-app.json` resolves the types from `inspect-app/` code

---

### Task 1.7: Platform browser-open helper

**Description**: One-file platform branch for `open` / `xdg-open` / `start`.
**Size**: Small
**Priority**: Medium
**Dependencies**: None
**Can run parallel with**: 1.6, 1.8

**Technical Requirements**:

`src/inspect/openBrowser.js` (~10 LOC):

```js
const { spawn } = require('node:child_process');

function openBrowser(url) {
  const platform = process.platform;
  const cmd =
    platform === 'darwin' ? 'open' :
    platform === 'win32'  ? 'start' :
                            'xdg-open';
  // Detached + ignored stdio so the child outlives this process.
  spawn(cmd, [url], { detached: true, stdio: 'ignore' }).unref();
}

module.exports = { openBrowser };
```

Note: on Windows, `start` is a shell built-in, not an executable. The Node `spawn('start', [url])` form actually works because `cmd.exe` is in PATH and `start` is invoked via its cmd-builtin wrapper on modern Windows. If this proves unreliable in practice, switch to `spawn('cmd', ['/c', 'start', '', url])`. Document the simpler form for now.

**Acceptance Criteria**:
- [ ] `openBrowser(url)` exported from `src/inspect/openBrowser.js`
- [ ] Platform branch covers `darwin`, `win32`, default (Linux/other → xdg-open)
- [ ] Child process is detached + unref'd so the CLI can exit independently if needed
- [ ] No throw on missing binary (best-effort; user gets URL printed regardless)

---

### Task 1.8: Vite dev server wrapper

**Description**: `startInspectServer({ ideaDir, port })` — boots Vite with the right `fs.allow` and a `/inspect-view.json` middleware that reads from the idea directory.
**Size**: Medium
**Priority**: High
**Dependencies**: 1.1 (Vite installed)
**Can run parallel with**: 1.6, 1.7

**Technical Requirements**:

Per spec §8.3, build a Vite middleware that serves a single fixed route from the resolved idea directory. The path is captured in a closure during boot.

`src/inspect/server.js`:

```js
const { createServer } = require('vite');
const fs = require('node:fs/promises');
const path = require('node:path');

async function startInspectServer({ ideaDir, port }) {
  const repoRoot = path.resolve(__dirname, '..', '..');
  const server = await createServer({
    root: repoRoot,
    configFile: path.join(repoRoot, 'vite.config.ts'),
    server: {
      port,
      strictPort: typeof port === 'number',
      host: '127.0.0.1',
      fs: { allow: [ideaDir, repoRoot] },
    },
  });
  server.middlewares.use('/inspect-view.json', async (_req, res) => {
    try {
      const body = await fs.readFile(path.join(ideaDir, 'inspect-view.json'));
      res.setHeader('Content-Type', 'application/json');
      res.setHeader('Cache-Control', 'no-store');
      res.end(body);
    } catch (err) {
      res.statusCode = 500;
      res.end(JSON.stringify({ error: err.message }));
    }
  });
  await server.listen();
  return server;
}

module.exports = { startInspectServer };
```

The default port behaviour: when `port` is undefined, Vite picks an auto port starting from 5180. When the user passes `--port`, set `strictPort: true` so Vite fails fast on EADDRINUSE rather than silently picking another port.

**Acceptance Criteria**:
- [ ] `startInspectServer({ ideaDir, port })` exported from `src/inspect/server.js`
- [ ] Programmatically registers `/inspect-view.json` middleware via `server.middlewares.use`
- [ ] `server.fs.allow` includes both the idea directory and the repo root
- [ ] `server.host === '127.0.0.1'` (localhost only — no LAN exposure per spec §12)
- [ ] When `port` is provided, `strictPort: true`
- [ ] Returns the Vite server instance so the caller can attach SIGINT cleanup

---

### Task 1.9: CLI command — `msv inspect` wire-up

**Description**: Top-level command that orchestrates load → build view → write `inspect-view.json` → boot Vite → open browser → wait for SIGINT.
**Size**: Medium
**Priority**: High
**Dependencies**: 1.2, 1.3, 1.4, 1.5, 1.7, 1.8
**Can run parallel with**: SPA work (after the view JSON contract is stable)

**Technical Requirements**:

`src/commands/inspect.js`:

```js
const path = require('node:path');
const fs = require('node:fs/promises');
const {
  ensureStorageDirs, ideaDir, archivedIdeaDir, atomicWriteText,
} = require('../storage');
const { buildLoaderInput } = require('../inspect/loader');
const { buildView } = require('../inspect/view/build');
const { startInspectServer } = require('../inspect/server');
const { openBrowser } = require('../inspect/openBrowser');

function parseArgs(args) {
  // Positional: idea id (required).
  // Flags: --no-open, --port <n>.
  // Reject any other args.
}

async function resolveIdeaDir(id) {
  for (const dir of [ideaDir(id), archivedIdeaDir(id)]) {
    try { await fs.access(path.join(dir, 'index.json')); return dir; }
    catch { /* not found, try next */ }
  }
  return null;
}

async function runInspectCommand(args) {
  const opts = parseArgs(args);
  if (opts.error) {
    process.stderr.write(`${opts.error}\nUsage: msv inspect <id> [--no-open] [--port <n>]\n`);
    process.exitCode = 1;
    return;
  }

  await ensureStorageDirs();
  const dir = await resolveIdeaDir(opts.id);
  if (!dir) {
    process.stderr.write(`idea not found: ${opts.id}\n`);
    process.exitCode = 1;
    return;
  }

  let view;
  try {
    const loaderInput = await buildLoaderInput(dir);
    view = buildView(loaderInput);
  } catch (err) {
    process.stderr.write(`view build error: ${err.message}\n`);
    process.exitCode = 2;
    return;
  }

  await atomicWriteText(
    path.join(dir, 'inspect-view.json'),
    JSON.stringify(view, null, 2) + '\n'
  );

  const stageCount = view.stages.filter((s) => s.status === 'done').length;
  const moveCount = Object.values(view.debates).reduce((n, d) => n + d.moves.length, 0);
  const nodeCount = view.forum.nodes.length;
  process.stdout.write(`→ built view: ${stageCount} stages, ${moveCount} moves, ${nodeCount} forum nodes\n`);
  process.stdout.write(`→ wrote ${path.join(dir, 'inspect-view.json')}\n`);

  let server;
  try {
    server = await startInspectServer({ ideaDir: dir, port: opts.port });
  } catch (err) {
    process.stderr.write(`vite failed to bind: ${err.message}\n  (try a different port with --port <n>)\n`);
    process.exitCode = 3;
    return;
  }

  const url = `http://localhost:${server.config.server.port}/?id=${opts.id}`;
  process.stdout.write(`→ Vite dev server ready on ${url}\n`);

  if (!opts.noOpen) {
    openBrowser(url);
    process.stdout.write(`→ opened browser\n`);
  }
  process.stdout.write(`\n  ➜  press Ctrl-C to stop\n`);

  return new Promise((resolve) => {
    process.on('SIGINT', async () => {
      try { await server.close(); } catch {}
      resolve();
    });
  });
}

module.exports = { runInspectCommand };
```

Wire into `src/cli.js`:
- Add an `'inspect'` command branch that calls `runInspectCommand(args)`.
- Update `HELP_TEXT` to list `inspect <id> [--no-open] [--port <n>]`.

**Acceptance Criteria**:
- [ ] `msv inspect <id>` works end-to-end against `~/.msv/archive/722b7e3c-…`
- [ ] `msv inspect <id> --no-open` prints the URL but does not call the platform opener
- [ ] `msv inspect <id> --port 5999` pins the port
- [ ] `msv inspect bad-uuid` → stderr "idea not found", exit 1
- [ ] Ctrl-C cleanly closes Vite, exit 0
- [ ] `inspect-view.json` is written to the resolved idea dir (ideas OR archive)
- [ ] `msv --help` lists the new command

---

### Task 1.10: SPA bootstrap — `main.tsx`, `App.tsx`, `ViewContext.tsx`, `useView.ts`

**Description**: Minimum viable React shell that fetches `/inspect-view.json`, provides it via context, and renders an empty `AppShell`.
**Size**: Small
**Priority**: High
**Dependencies**: 1.1, 1.6
**Can run parallel with**: 1.11 (theme)

**Technical Requirements**:

`src/inspect-app/main.tsx`:
```tsx
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { MantineProvider, createTheme } from '@mantine/core';
import '@mantine/core/styles.css';
import { App } from './App';

const theme = createTheme({ primaryColor: 'blue' });

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <MantineProvider theme={theme} defaultColorScheme="light">
      <App />
    </MantineProvider>
  </StrictMode>,
);
```

`src/inspect-app/hooks/useView.ts`:
```ts
import { use } from 'react';
import type { InvestigationView } from '../../inspect/types';

const viewPromise: Promise<InvestigationView> = fetch('/inspect-view.json')
  .then((r) => {
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return r.json();
  });

export function useView(): InvestigationView {
  return use(viewPromise);
}
```

Notes on `use(promise)`:
- React 19 stable supports `use(promise)` inside Suspense boundaries.
- The promise is module-scoped so it is created exactly once and re-used across re-mounts (StrictMode double-render included).

`src/inspect-app/ViewContext.tsx`:
```tsx
import { createContext, useContext, type ReactNode } from 'react';
import type { InvestigationView } from '../inspect/types';
import { useView } from './hooks/useView';

const ViewContext = createContext<InvestigationView | null>(null);

export function ViewProvider({ children }: { children: ReactNode }) {
  const view = useView();
  return <ViewContext.Provider value={view}>{children}</ViewContext.Provider>;
}

export function useViewContext(): InvestigationView {
  const v = useContext(ViewContext);
  if (!v) throw new Error('useViewContext must be inside ViewProvider');
  return v;
}
```

`src/inspect-app/App.tsx`:
```tsx
import { Suspense } from 'react';
import { AppShell, Loader, Center } from '@mantine/core';
import { ViewProvider } from './ViewContext';

export function App() {
  return (
    <Suspense fallback={<Center h="100vh"><Loader/></Center>}>
      <ViewProvider>
        <AppShell navbar={{ width: 240, breakpoint: 'sm' }} padding="md">
          <AppShell.Navbar p="md">{/* nav links — Task 1.10b */}</AppShell.Navbar>
          <AppShell.Main>
            {/* Section components mounted here in subsequent tasks */}
          </AppShell.Main>
        </AppShell>
      </ViewProvider>
    </Suspense>
  );
}
```

The navbar's anchor-link list is initially empty; each component task adds its entry as it lands. Acceptable to scaffold a `<Nav>` primitive with hard-coded links from the start — implementer's call.

**Acceptance Criteria**:
- [ ] `npx tsc --noEmit -p tsconfig.inspect-app.json` succeeds
- [ ] `msv inspect <id>` boots Vite and the browser renders an empty `AppShell` with a Mantine loader briefly visible
- [ ] `useView()` resolves the view exactly once even under StrictMode's double-render
- [ ] `useViewContext()` throws a clear error if used outside `ViewProvider`
- [ ] Mantine's global CSS is loaded once (`@mantine/core/styles.css` imported in `main.tsx`)

---

### Task 1.11: Theme — tokens + persona colour assignment

**Description**: Single source of truth for spacing/typography scales and the persona-colour function.
**Size**: Small
**Priority**: Medium
**Dependencies**: 1.1
**Can run parallel with**: 1.10

**Technical Requirements**:

`src/inspect-app/theme/tokens.ts`:
```ts
// Layout + typography tokens that don't fit Mantine's default theme.
// Mantine's <Stack gap="md"> handles most spacing; these tokens are for
// custom layouts (e.g., the persona card grid, move cards).
export const tokens = {
  personaRail: 4,            // px width of persona-coloured left rail
  moveCardGap: 12,           // px between move cards
  highlightPulseMs: 600,     // duration of #move-<id> scroll-target pulse
} as const;
```

`src/inspect-app/theme/personas.ts`:
```ts
const PALETTE = [
  '#E69F00', '#56B4E9', '#009E73', '#F0E442',
  '#0072B2', '#D55E00', '#CC79A7', '#000000',
] as const;  // Okabe-Ito; colourblind-safe; WCAG AA against #FFFFFF

export function personaColor(personaId: string): string {
  let h = 0;
  for (let i = 0; i < personaId.length; i++) {
    h = (h * 31 + personaId.charCodeAt(i)) | 0;
  }
  return PALETTE[Math.abs(h) % PALETTE.length];
}
```

No `ThemeProvider` for persona colours. Components import `personaColor` and apply it via Emotion `css` with a CSS variable on the element.

**Acceptance Criteria**:
- [ ] `personaColor(id)` is a pure function — same id always returns the same hex
- [ ] Palette has 8 colours; assignments distribute via a per-character hash
- [ ] `tokens.highlightPulseMs === 600` (consumed by `useAnchorScroll` in Phase 2)
- [ ] No new Mantine dependencies needed at this layer

---

### Task 1.12: `<Header>` + `<StatusPill>` + `<BudgetBar>`

**Description**: Top section showing topic, status, parent link, budget bars, runtime.
**Size**: Small
**Priority**: Medium
**Dependencies**: 1.10, 1.11
**Can run parallel with**: 1.13–1.18

**Technical Requirements**:

Per spec §8.6.1:

- Topic in full (no truncation — `index.json` preserves verbatim).
- `<StatusPill>`: Mantine `<Badge>` — green `ready`, yellow `investigating`, grey `archived`. Investigating ideas show "partial transcript — not all stages completed" via a Mantine `<Alert>` below the pill.
- `parent_id` rendered as Mantine `<Anchor>` pointing to `?id=<parent_id>`. The link target is computed from the record's own `parent_id` field — no directory scanning. (User runs `msv inspect <parent_id>` separately if they want to drill up.)
- `<BudgetBar>`: two Mantine `<Progress>` bars (executor calls, tokens). Bar colour goes red when fill > 100%. The reference run `722b7e3c-…` overshot both — the inspector must surface that.
- Runtime: `completed_at − started_at` formatted as `m:ss`.

**Files to create**: `Header/Header.tsx`, `Header/StatusPill.tsx`, `Header/BudgetBar.tsx`.

Format the runtime via a tiny helper `formatDuration(ms): string` in `utils/format.ts` (or inline if you prefer):
- `< 60s` → `1.4s`
- `< 3600s` → `2m 13s`
- otherwise → `1h 12m`

For the budget bars, use `<Progress.Root>` with `<Progress.Section>` so we can stack the over-100% portion in a different colour.

**Acceptance Criteria**:
- [ ] `<Header>` renders the topic without truncation
- [ ] `<StatusPill>` colour matches `ready`/`investigating`/`archived`
- [ ] `<BudgetBar>` shows fill % and absolute numbers; bar goes red on overshoot
- [ ] Reference run `722b7e3c-…` shows red bars on both executor calls and tokens
- [ ] Runtime renders as `m:ss` (or `Xs` when under a minute)
- [ ] Parent link is clickable when `parent_id !== null`

---

### Task 1.13: `<Timeline>` + `<StageChip>`

**Description**: Horizontal pipeline-stages timeline using Mantine's `<Timeline>` inside a `<ScrollArea>`.
**Size**: Small
**Priority**: Medium
**Dependencies**: 1.10, 1.11
**Can run parallel with**: 1.12, 1.14–1.18

**Technical Requirements**:

Per spec §8.6.2:

- Mantine `<Timeline>` component, oriented horizontally inside a `<ScrollArea>`.
- Each `<Timeline.Item>` is one of the seven pipeline stages (per `view.stages[]`): name, duration (`formatDuration(ms)`), status icon, per-stage token usage in a Mantine `<Tooltip>`.
- Clicking an item sets `window.location.hash = '#stage-<key>'`. In Phase 1, scroll handling can be the browser's native anchor behaviour; smooth-scroll is fully wired up in Phase 2 (Task 2.4 / `useAnchorScroll`).
- The spawn round (4b) renders as an inline 8th item only when `coordinator.spawn.sub_questions.length > 0`. When declined, render `<Text size="xs" c="dimmed">spawn declined — budget_cap (used N%)</Text>` under stage 4.

Status icons:
- `done` → ✓
- `partial` → ⏵
- `failed` → ⚠
- `not_run` / `skipped` → ·

**Files to create**: `Timeline/Timeline.tsx`, `Timeline/StageChip.tsx`.

**Acceptance Criteria**:
- [ ] All seven stages render in order against the `722b7e3c-…` fixture
- [ ] Status icons match `view.stages[].status`
- [ ] Click on a stage scrolls (native anchor jump is sufficient for Phase 1)
- [ ] `f61fd8b6-…` shows "spawn declined" annotation; no inline 4b item
- [ ] Per-stage tokens visible on `<Tooltip>` hover

---

### Task 1.14: `<Discovery>` — search queries + persona cards (no results panel yet)

**Description**: Discovery section with search query chips, persona card grid (selected vs cut), and a stub for the search results panel.
**Size**: Medium
**Priority**: Medium
**Dependencies**: 1.10, 1.11
**Can run parallel with**: 1.12, 1.13, 1.15–1.18

**Technical Requirements**:

Per spec §8.6.3:

- `<SearchQueryList>` — Mantine `<Group>` of `<Badge variant="light">` chips, one per `search_queries[]`.
- `<SearchResultList>` — Phase 1: renders a `<Text c="dimmed">(search results not preserved — see §9.5)</Text>` stub. The real results render lands in Task 2.7 / Phase 2.
- `<PersonaCard>` grid — Mantine `<Grid>` with 3-column layout. Selected personas get a coloured left border (their persona colour via `personaColor`) and a "selected" `<Badge>`; cut personas are dimmed via `opacity: 0.6`. Card content: id, name, tradition, stance, description (clamped via Mantine `<Spoiler maxHeight={72}>`). Order: selected first by `selected_persona_ids` order, then cut by id. Fixed personas (skeptic, builder) get a small separate `<Group>` labelled "Fixed (always added)".

The persona card's left-border colour applies via Emotion `css` prop with a CSS variable:
```tsx
import { css } from '@emotion/react';
import { personaColor } from '../../theme/personas';

const cardStyle = css`
  border-left: 4px solid var(--persona-color, transparent);
`;
<div css={cardStyle} style={{ '--persona-color': personaColor(p.id) } as any}>...</div>
```

Degraded-discovery handling: `f61fd8b6-…` has `candidate_personas: []`. Render an `<Empty>` message "discovery returned 0 candidate personas — see open question §15.5 in the spec".

**Files to create**: `Discovery/Discovery.tsx`, `Discovery/SearchQueryList.tsx`, `Discovery/PersonaCard.tsx`, `Discovery/SearchResultList.tsx` (stub).

**Acceptance Criteria**:
- [ ] All discovery search queries render as chips
- [ ] Selected personas appear first, with coloured left borders and "selected" badge
- [ ] Cut personas appear dimmed
- [ ] Long descriptions clamp via Spoiler and expand on click
- [ ] Fixed personas (skeptic, builder) section labelled appropriately
- [ ] `f61fd8b6-…` renders the empty-discovery message without crashing
- [ ] `<SearchResultList>` renders its stub message (real impl in Phase 2)

---

### Task 1.15: `<Coordinator>` + `<SubQuestionCard>`

**Description**: Coordinator decisions section with initial and spawn sub-question cards.
**Size**: Small
**Priority**: Medium
**Dependencies**: 1.10, 1.11
**Can run parallel with**: 1.12–1.14, 1.16–1.18

**Technical Requirements**:

Per spec §8.6.4:

- Initial decomposition — N `<SubQuestionCard>` instances in a `<Stack>`. Each card: id, question, rationale, the assigned pair (two `<PersonaChip>` components colour-tagged consistently with their colour across the inspector), `pair_distinctness_score` as a Mantine `<Progress size="xs">` (value 0–1 → 0–100%).
- Spawn decision — second block, same card layout when `spawn.sub_questions.length > 0`. When declined, render the reason + `budget_used_pct` from `coordinator-spawn.jsonl` (already in `view.coordinator.spawn.reason`).

The `<PersonaChip>` primitive (in `primitives/PersonaChip.tsx`) takes a `Persona` and renders a Mantine `<Badge>` with the persona's colour as background and the name as label. Reusable across Discovery, Coordinator, and Debate sections.

**Files to create**: `Coordinator/Coordinator.tsx`, `Coordinator/SubQuestionCard.tsx`, `primitives/PersonaChip.tsx`.

**Acceptance Criteria**:
- [ ] Each sub-question renders its id, question, rationale, pair chips, and distinctness bar
- [ ] Pair chips use the same persona colours as everywhere else
- [ ] Spawn block: when declined, shows the reason; when spawned, renders additional cards
- [ ] `722b7e3c-…` shows 6 initial sub-questions + declined spawn block
- [ ] `<PersonaChip>` is reusable from other sections

---

### Task 1.16: `<DebateSection>` — Accordion + `<MoveCard>` + `<ConfidenceChart>`

**Description**: Per-sub-question debate panels with confidence chart and move-by-move thread.
**Size**: Large
**Priority**: High
**Dependencies**: 1.10, 1.11, 1.15 (for `<PersonaChip>`)
**Can run parallel with**: 1.12–1.14, 1.17, 1.18

**Technical Requirements**:

Per spec §8.6.5:

One Mantine `<Accordion>` panel per `pair_debates[]` entry. Each panel:

- Header (`<Accordion.Control>`): sub-question text, pair chips, `terminated_by`, surviving-claim count.
- Body (`<Accordion.Panel>`):
  - `<ConfidenceChart>` — Recharts `<LineChart width={…} height={80}>` with one `<Line>` per persona, dots customised by move type:
    - Circle for Claim
    - Triangle for Rebut
    - Square for Concede
    - Diamond for Question
    - Plus for Support
    - Synthesized moves get a dashed-stroke version of whatever shape
    - Recharts `<Tooltip>` shows move type + confidence on hover
  - `<Stack>` of `<MoveCard>` instances. Each card:
    - Left rail coloured by `personaColor(move.by_persona_id)` (via Emotion `css` prop with a CSS variable)
    - Header line: `m_sq_001_0005 · Persona Name · Rebut · conf 8 · refs m_sq_001_0004`
    - `content` as prose
    - `evidence_basis` in a muted Mantine `<Code block>` with "Evidence basis" label
    - `references_move_id` is a clickable `<Anchor>` that sets `window.location.hash = '#move-m_sq_001_0004'`. Smooth scroll + pulse animation lands in Phase 2 (Task 2.4 / `useAnchorScroll`); for Phase 1, use the browser's native anchor jump (every move card gets `id={move.move_id}`).
    - Surviving claims get a coloured left border accent and a "surviving claim" `<Badge>`
    - Synthesized moves get a Mantine `<Alert color="yellow">` with the calcification explanation

Recharts shape for custom dots:
```tsx
import { LineChart, Line, Tooltip, ResponsiveContainer } from 'recharts';

function CustomDot(props: any) {
  const { cx, cy, payload } = props;
  const shapes: Record<string, JSX.Element> = {
    Claim:   <circle cx={cx} cy={cy} r={4} />,
    Rebut:   <polygon points={`${cx},${cy-5} ${cx-5},${cy+4} ${cx+5},${cy+4}`} />,
    Concede: <rect x={cx-4} y={cy-4} width={8} height={8} />,
    Question:<polygon points={`${cx},${cy-5} ${cx+5},${cy} ${cx},${cy+5} ${cx-5},${cy}`} />,
    Support: <path d={`M${cx-4},${cy} h8 M${cx},${cy-4} v8`} />,
  };
  return shapes[payload.type] ?? <circle cx={cx} cy={cy} r={3} />;
}
```

The dot stroke is dashed (`strokeDasharray="3 2"`) when `payload.synthesized === true`.

Data shape passed to `<LineChart data={...}>` — convert `view.debates[sq_id].confidence_trajectory[]` into:
```ts
[
  { move: 1, p_002: 8, skeptic: undefined, type: 'Claim', synthesized: false, ... },
  { move: 2, p_002: undefined, skeptic: 7, type: 'Claim', ... },
  ...
]
```
One row per move, with persona-keyed confidence columns (undefined where the persona didn't move that turn). Recharts handles gaps as line breaks; use `connectNulls={true}` to keep the line continuous.

**Files to create**: `Debate/DebateSection.tsx`, `Debate/MoveCard.tsx`, `Debate/ConfidenceChart.tsx`.

**Acceptance Criteria**:
- [ ] One Accordion item per pair debate
- [ ] Confidence chart renders two lines (one per persona) with shape-coded dots per move type
- [ ] Synthesized moves have dashed-stroke dots
- [ ] Move cards display all fields per spec (header line, content, evidence_basis, references)
- [ ] Clicking a `refs` anchor scrolls (native jump for Phase 1)
- [ ] Surviving claims have a visible accent and badge
- [ ] Calcification-fallback synthesized moves render the yellow Alert
- [ ] `722b7e3c-…` renders all 6 debates with their move threads readable

---

### Task 1.17: `<Forum>` — Tabs scaffold + `<ForumGraph>` (contradictions only)

**Description**: Forum section with three-tab Mantine layout; Phase 1 implements only the graph tab with contradiction edges. Tabs 2/3 land in Phase 2.
**Size**: Large
**Priority**: High
**Dependencies**: 1.10, 1.11
**Can run parallel with**: 1.12–1.16, 1.18

**Technical Requirements**:

Per spec §8.7.1:

Mantine `<Tabs>` with three panels. Phase 1 ships only Tab 1 (graph); Tabs 2 and 3 render stub placeholders.

Tab 1 — `<ForumGraph>`:

- Built on `@xyflow/react` (React Flow v12) in **controlled mode** with deterministic positioning (`useNodesState` / `useEdgesState`).
- **Nodes** — one per `forum.nodes[]` entry. Custom node renderer (`ForumNode.tsx`) draws a circle (radius proportional to `aggregate_confidence`, clamped 16–48 px) filled with the working group's colour (use the working_group_id → colour mapping derived from `personaColor(sub_question.assigned_pair[0])`). A `?` badge for `has_open_question: true`. Node label is the `node_id`; on hover, a Mantine `<HoverCard>` shows the full claim content. Register the custom node via the `nodeTypes` prop.
- **Edges** (Phase 1):
  - **Contradictions** (red, solid) — one per `forum.contradiction_edges[]`. Hovering shows the LLM's contradiction reason (read from `view.forum.contradiction_edges[].reason`).
- **Layout** — deterministic ring grouped by `working_group_id`. Sub-questions form clusters around the perimeter; contradictions become arcs across the centre. Compute positions once at mount via a pure `layoutRing(nodes): Record<node_id, {x, y}>` in `view/derive/forumLayout.ts` (added in Task 1.5 if not already). Algorithm:
  1. Group nodes by `working_group_id`.
  2. Distribute groups evenly around a circle of radius R (e.g., 280 px).
  3. Within each group, place nodes in a small arc around the group centre.

Force-directed layout is **rejected** — its non-determinism makes screenshots and AI-aided reviews unreliable.

Interaction in Phase 1: hover only (no NodeDrawer yet — that's Task 2.1). Selecting a node can be local state (`useState`) for future use.

```tsx
import { ReactFlow, Background, Controls, useNodesState, useEdgesState } from '@xyflow/react';
import '@xyflow/react/dist/style.css';

function ForumGraph() {
  const view = useViewContext();
  const positions = useMemo(() => layoutRing(view.forum.nodes), [view.forum.nodes]);
  const [nodes, , onNodesChange] = useNodesState(
    view.forum.nodes.map((n) => ({
      id: n.node_id,
      position: positions[n.node_id],
      data: { node: n, view },
      type: 'forumNode',
    })),
  );
  const [edges, , onEdgesChange] = useEdgesState(
    view.forum.contradiction_edges.map((e, i) => ({
      id: `c-${i}`,
      source: e.from_node_id,
      target: e.to_node_id,
      label: e.reason,
      style: { stroke: '#D55E00', strokeWidth: 2 },
      type: 'default',
      data: { kind: 'contradiction', reason: e.reason },
    })),
  );
  return (
    <div style={{ height: 540 }}>
      <ReactFlow
        nodes={nodes}
        edges={edges}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        nodeTypes={{ forumNode: ForumNode }}
        fitView
      >
        <Background />
        <Controls />
      </ReactFlow>
    </div>
  );
}
```

**Files to create**: `Forum/Forum.tsx`, `Forum/ForumGraph.tsx`, `Forum/ForumNode.tsx`. Add `src/inspect/view/derive/forumLayout.js` (or put `layoutRing` in `forumLayout.ts` inside the SPA — implementer's call; if in the SPA, the function is TS-only).

**Acceptance Criteria**:
- [ ] Forum section renders three Mantine `<Tabs>` (graph default + two stubs)
- [ ] Graph displays one node per forum entry with colour = working-group palette
- [ ] Node radius scales with `aggregate_confidence` (clamped 16–48 px)
- [ ] `?` badge appears on nodes with `has_open_question`
- [ ] Contradiction edges render red between contradicting nodes
- [ ] Hovering a node shows the full claim content in a Mantine `<HoverCard>`
- [ ] Hovering an edge shows the contradiction reason
- [ ] Ring layout is deterministic — same view → same positions every load
- [ ] `722b7e3c-…` shows 12 nodes + 5 contradiction edges

---

### Task 1.18: `<Synthesis>` + `<Markdown>` (sanitised)

**Description**: Final section: headline findings, open tensions, sanitised markdown report.
**Size**: Small
**Priority**: Medium
**Dependencies**: 1.10
**Can run parallel with**: 1.12–1.17

**Technical Requirements**:

Per spec §8.6.8 + §12:

- `headline_findings[]` as a Mantine `<List type="ordered">`, prominent typography (`size="lg"`).
- `open_tensions[]` in a Mantine `<Alert color="yellow">` callout. Skip rendering when the array is empty.
- `report` rendered via `<Markdown source={view.synthesis.report} />` (the wrapper component below).

`<Markdown>` wraps `react-markdown` with `rehype-sanitize` configured for the GitHub-safe schema:

```tsx
import ReactMarkdown from 'react-markdown';
import rehypeSanitize, { defaultSchema } from 'rehype-sanitize';

export function Markdown({ source }: { source: string }) {
  return (
    <ReactMarkdown rehypePlugins={[[rehypeSanitize, defaultSchema]]}>
      {source}
    </ReactMarkdown>
  );
}
```

**No** `dangerouslySetInnerHTML` — `react-markdown` renders to React elements. The synthesizer's report has historically used only paragraphs, `**bold**`, and inline backticks (verified against both reference runs), but the sanitiser is mandatory regardless — LLM output is untrusted.

Partial-transcript handling: when `view.synthesis === null` (status: investigating), render an `<Empty>` placeholder reading "synthesis not yet produced — investigation in progress".

**Files to create**: `Synthesis/Synthesis.tsx`, `Synthesis/Markdown.tsx`.

**Acceptance Criteria**:
- [ ] `headline_findings[]` render as ordered list
- [ ] `open_tensions[]` render in a yellow Alert (or are skipped when empty)
- [ ] Markdown report renders with paragraphs and inline bold
- [ ] A `<script>` tag in a synthesised report does NOT execute (sanitiser blocks it)
- [ ] `synthesis: null` shows the placeholder, not a crash
- [ ] `722b7e3c-…` shows 5 headline findings + 3 open tensions + a readable multi-paragraph report

---

### Task 1.19: `<Empty>` primitive

**Description**: Reusable placeholder for sections with no data (investigating-state, degraded-discovery, etc.).
**Size**: Small
**Priority**: Low
**Dependencies**: 1.10
**Can run parallel with**: any UI task

**Technical Requirements**:

`src/inspect-app/primitives/Empty.tsx`:

```tsx
import { Center, Text, Stack } from '@mantine/core';

type Props = { title: string; description?: string };

export function Empty({ title, description }: Props) {
  return (
    <Center py="xl">
      <Stack align="center" gap="xs">
        <Text c="dimmed" size="sm" fw={500}>{title}</Text>
        {description && <Text c="dimmed" size="xs">{description}</Text>}
      </Stack>
    </Center>
  );
}
```

Used by `<DebateSection>` (no debates), `<Forum>` (no nodes), `<Synthesis>` (no synthesis), `<Discovery>` (no candidate personas).

**Acceptance Criteria**:
- [ ] `<Empty title="…" description="…" />` renders consistently across sections
- [ ] All four sections that may be empty consume this primitive

---

### Task 1.20: Test fixtures

**Description**: Three idea-directory fixtures under `test/fixtures/inspect/`.
**Size**: Small
**Priority**: Medium
**Dependencies**: 1.5 (view shape stable so fixtures reflect it)
**Can run parallel with**: 1.21, 1.22

**Technical Requirements**:

Fixtures live under `test/fixtures/inspect/`:

- `ready/` — copy of a known-good `ready` idea with all stages. Source: `~/.msv/archive/722b7e3c-e231-46c8-84cd-b2f272222323/`. Copy `index.json` + entire `logs/` directory.
- `investigating/` — same idea trimmed to stage 3 only (no `pair_debates`). Manually edit the copied `index.json`: remove `pair_debates[]`, `cross_pollination[]`, `forum`, `synthesis`; set `status: "investigating"`; clear `investigation.completed_at`. Remove the corresponding logs.
- `degraded-discovery/` — copy of the `f61fd8b6` shape: empty `candidate_personas`. Source: `~/.msv/ideas/f61fd8b6-59b0-4b90-97ec-7b41e36a7610/`.

Add `test/fixtures/inspect/README.md`:
```markdown
# Inspect test fixtures

Each subdirectory mirrors the shape of `~/.msv/ideas/<uuid>/`.

## Regenerating from scratch

```
MSV_ROOT=test/fixtures/inspect/ready msv add < topic.txt
MSV_ROOT=test/fixtures/inspect/ready msv run --all
```

For the `investigating/` fixture, copy a `ready/` fixture and hand-edit
`index.json` to remove later stages.

For `degraded-discovery/`, copy any `ready` fixture and replace the
`candidate_personas: []` array (then strip downstream consequences).
```

**Acceptance Criteria**:
- [ ] Three fixture directories committed under `test/fixtures/inspect/`
- [ ] Each fixture has `index.json` and a `logs/` subdir (at least one log file)
- [ ] README documents regeneration
- [ ] Fixtures total <2 MB checked in

---

### Task 1.21: `test/inspect/loader.test.js`

**Description**: Two tests for the loader's correctness and tolerance to missing/empty data.
**Size**: Small
**Priority**: Medium
**Dependencies**: 1.3, 1.4, 1.20
**Can run parallel with**: 1.22

**Technical Requirements**:

Per spec §10.1, file shape using Node's built-in `node:test` + `node:assert/strict`:

```js
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { buildLoaderInput } = require('../../src/inspect/loader');

const FIX = path.resolve(__dirname, '..', 'fixtures', 'inspect');

test('loader merges index + logs correctly', async () => {
  const input = await buildLoaderInput(path.join(FIX, 'ready'));
  // Assertions:
  // - every stage's structured data has the matching log timings attached
  // - forum-contradictions verdicts are keyed via contradictionKey
  // - debate moves carry attempt counts
  assert.ok(input.index.id);
  assert.ok(input.enrichments.forum.contradiction_verdicts);
  // Pick a specific known claim_id pair from the fixture and assert presence:
  const someKey = Object.keys(input.enrichments.forum.contradiction_verdicts)[0];
  assert.match(someKey, /^c_.*\|c_.*/);
});

test('loader tolerates missing logs and empty discovery', async () => {
  // Sub-case (a): investigating fixture (synthesizer.jsonl + forum-contradictions.jsonl missing)
  const inv = await buildLoaderInput(path.join(FIX, 'investigating'));
  assert.equal(inv.index.investigation.synthesis, null);
  assert.deepEqual(inv.enrichments.forum.contradiction_verdicts, {});

  // Sub-case (b): degraded-discovery fixture (empty candidate_personas)
  const deg = await buildLoaderInput(path.join(FIX, 'degraded-discovery'));
  assert.deepEqual(deg.index.investigation.perspective_discovery.candidate_personas, []);
});
```

**Acceptance Criteria**:
- [ ] Both tests pass via `CI=true npm test`
- [ ] Test runtime <2s
- [ ] Tests reference real fixture data — not inline objects

---

### Task 1.22: `test/inspect/view.test.js`

**Description**: Four tests for the view builder's derivations and atomicWriteText.
**Size**: Small
**Priority**: Medium
**Dependencies**: 1.5, 1.20
**Can run parallel with**: 1.21

**Technical Requirements**:

Per spec §10.1. Four tests in `test/inspect/view.test.js` (the atomicWriteText test from Task 1.2 may live here or in `test/storage.test.js` — implementer's call):

```js
test('view model: contradiction edges are deduplicated', () => {
  // Build a loaderInput where forum.nodes has A pointing to B and B pointing to A.
  // Assert view.forum.contradiction_edges.length === 1.
});

test('view model: persona interactions matrix counts move types correctly', () => {
  // Build a debate where persona A emits:
  //   - 3 Rebuts each referencing a move by B
  //   - 1 Concede referencing a move by B
  // Assert personaInteractions['A']['B'] === { Rebut: 3, Concede: 1, Question: 0, Support: 0 }
});

test('view model: stage durations handle null timestamps', () => {
  // Build a loaderInput where one stage has started_at but no completed_at.
  // Assert view.stages[<that key>].duration_ms === null (not NaN).
  // Assert view.stages[<that key>].status === 'partial'.
});

test('atomicWriteText leaves prior content intact on rename failure', async () => {
  // Pre-create file, monkey-patch fs.rename to throw, attempt write, assert original content.
});
```

Each test is built from a hand-crafted minimal loaderInput rather than the fixture — keeps the test focused on the derivation logic, not on fixture details.

**Acceptance Criteria**:
- [ ] All four tests pass via `CI=true npm test`
- [ ] Test runtime <2s combined
- [ ] No fixture dependency for the derivation tests

---

### Task 1.23: Update README + steer card `[i]` key

**Description**: Document `msv inspect` in README and add the `[i]` key to `msv review`'s steer card.
**Size**: Small
**Priority**: Medium
**Dependencies**: 1.9
**Can run parallel with**: anything

**Technical Requirements**:

Add a section to `README.md` between `msv run` and `msv review`:

```markdown
### `msv inspect <id>`

Boots a local Vite dev server with a React SPA showing the full transcript of an investigation: the search queries discovery ran, every candidate persona (selected and cut), the coordinator's decomposition, every debate move with confidence and evidence_basis, the forum graph with contradiction edges, and the synthesis.

```bash
msv inspect 722b7e3c-e231-46c8-84cd-b2f272222323
msv inspect <id> --no-open    # don't open the browser; print URL only
msv inspect <id> --port 6000  # pin the port
```

The terminal stays attached until Ctrl-C. Editing files under `src/inspect-app/` triggers Vite HMR — the browser updates instantly. Data is read once at mount; re-run `msv inspect <id>` to refresh after a new `msv run`.

#### Where things live (`src/inspect-app/`)

- `App.tsx` — Mantine `<AppShell>` layout, mounts every section
- `components/{Header,Timeline,Discovery,Coordinator,Debate,Forum,Synthesis}/` — one folder per section
- `theme/personas.ts` — Okabe-Ito palette + deterministic id-to-colour hash. Import `personaColor(id)` everywhere.
- `hooks/useView.ts` — fetches `/inspect-view.json` once at mount via `use(promise)`
- Mantine handles layout primitives; Emotion's `css` prop for custom one-off styles. **No Tailwind.**
```

Add the `[i]` key to `msv review` per spec §9.1. Update `src/commands/review.js` and the steer card rendering in `src/render.js`:

- Steer card line: `[r]ead full report  [d]eeper (new topic)  [k]ill  [n]otes  [i]nspect`
- On `i`: `await runInspectCommand([currentIdea.id])`; the inspect process attaches to the same terminal — when the user Ctrl-Cs, control returns to `msv review`.

**Acceptance Criteria**:
- [ ] README has a complete `msv inspect` section
- [ ] `msv review`'s steer card shows `[i]nspect`
- [ ] Pressing `i` in `msv review` boots the inspector for the current idea
- [ ] Ctrl-C from the inspector returns to the review loop, not the shell

---

## Phase 2 — Interaction depth + web search capture

### Task 2.1: Forum `<NodeDrawer>` (click-through to debate tree)

**Description**: Mantine right-side `<Drawer>` opened when a forum node is clicked. Shows claim, full move tree, cross-pollination reactions, all contradictions.
**Size**: Large
**Priority**: High
**Dependencies**: 1.17
**Can run parallel with**: 2.2, 2.5

**Technical Requirements**:

Per spec §8.7.1 ("Interaction"):

`<NodeDrawer>` opens when `<ForumGraph>`'s `onNodeClick` fires. Mantine `<Drawer position="right" size="lg">`. Content sections (in order):

1. **Claim** — full content + `aggregate_confidence` + working group id.
2. **Originating debate move tree** — the moves of the debate (`view.debates[node.working_group_id]`) rendered as a parent-child tree by `references_move_id`. Implement as a recursive `<MoveTree>` component:
   ```tsx
   function MoveTree({ rootId, moves }: { rootId: string | null; moves: Move[] }) {
     const children = moves.filter((m) => m.references_move_id === rootId);
     return (
       <Stack gap="xs">
         {children.map((m) => (
           <Box key={m.move_id} pl="md">
             <MoveCard move={m} compact />
             <MoveTree rootId={m.move_id} moves={moves} />
           </Box>
         ))}
       </Stack>
     );
   }
   ```
   Start with `rootId={null}` to get the opening Claims. Every Rebut/Concede/Support feeds into a surviving claim transitively — the tree exposes that.
3. **Cross-pollination reactions** — all reactions in `view.cross_pollination[]` where `target_node_id === node.node_id`. Each rendered as a card with reactor persona, reaction type, content, confidence.
4. **All contradictions involving this node** — iterate `view.forum.contradiction_edges[]` and include any where `from_node_id` or `to_node_id` matches. Render the LLM's reason verbatim. Include "not the most pointed" verdicts too — these are in `loaderInput.enrichments.forum.contradiction_verdicts` and may be richer than `contradiction_edges[]`. (Add a derivation to surface them if not already present in the view.)

Drawer state: lifted to `<Forum>` (`useState<string | null>`). `<ForumGraph>` calls a passed `onNodeSelect(id)`; drawer reads the selected id and pulls the relevant data from `useViewContext()`.

**Files to create**: `Forum/NodeDrawer.tsx`, `Forum/MoveTree.tsx` (or co-locate inside `NodeDrawer.tsx`).

**Acceptance Criteria**:
- [ ] Clicking any forum node opens the drawer with the full claim and details
- [ ] Move tree renders the debate as a parent-child tree by `references_move_id`
- [ ] All cross-pollination reactions targeting the node appear
- [ ] All contradictions involving the node appear (not just the "most pointed" one)
- [ ] Drawer closes via the close button + Esc key (Mantine default)
- [ ] `722b7e3c-…`: clicking node `n_012` (highest survival_rank) shows its full move tree + 2 reactions + 1 contradiction

---

### Task 2.2: Forum tabs 2 & 3 — `<DebateThreadsTab>` and `<PersonaMatrix>`

**Description**: Two additional Forum tabs: a debate-threads view (re-uses `<DebateSection>`) and a persona-interaction matrix.
**Size**: Medium
**Priority**: High
**Dependencies**: 1.17, 1.16 (for `<DebateSection>` re-use), 1.5 (`personaInteractions` derivation)
**Can run parallel with**: 2.1, 2.3, 2.5

**Technical Requirements**:

Per spec §8.7.2 and §8.7.3:

**`<DebateThreadsTab>`** — re-uses the existing `<DebateSection>` component inside the Forum scope. Single line:
```tsx
import { DebateSection } from '../Debate/DebateSection';
export function DebateThreadsTab() { return <DebateSection />; }
```
The component already reads `view.debates` from context — no duplication.

**`<PersonaMatrix>`** — a Mantine `<Table>` with one row per persona and one column per persona. Cells contain reference counts broken down by move type, as derived in `view.personaInteractions` (Task 1.5 already builds this; if not in the view object, add it now via `view.derive/personaInteractions`).

Display format:
```
                p_006   p_011   skeptic   builder
p_006             —      4R/2C    0       1R
p_011           5R/3C     —       0       0
skeptic           0        0      —       3R/1C
builder           2R       0     2R/1C     —
```

`R` = Rebut, `C` = Concede, `Q` = Question, `S` = Support. Cell background opacity proportional to total reference count (heatmap effect). Use Emotion `css` with a CSS variable for the opacity:

```tsx
<td css={cellStyle} style={{ '--intensity': totalCount / maxCount } as any}>
  {breakdown}
</td>
```

```ts
const cellStyle = css`
  background: rgba(86, 180, 233, var(--intensity));
`;
```

Clicking a cell scrolls to the relevant debate's Accordion item via `window.location.hash = '#debate-<sq_id>'`. The sub-question is the one where both personas were paired — derived by finding the debate whose pair includes both. When personas were paired in multiple sub-questions, scroll to the first.

**Files to create**: `Forum/DebateThreadsTab.tsx`, `Forum/PersonaMatrix.tsx`.

**Acceptance Criteria**:
- [ ] Forum's three tabs all render
- [ ] Tab 2 mirrors the main `<DebateSection>` exactly
- [ ] Tab 3 matrix has the right rows/columns for `722b7e3c-…` (7 personas: 5 discovered + 2 fixed)
- [ ] Cell counts match `derivePersonaInteractions` output (use the unit test as a check)
- [ ] Heatmap opacity scales with total cell count
- [ ] Clicking a cell navigates to a relevant debate

---

### Task 2.3: Cross-pollination edges + intra-cluster toggle on `<ForumGraph>`

**Description**: Add two more edge types to the forum graph: cross-pollination reactions (blue dashed) and optional intra-cluster references (grey, toggled by a Switch).
**Size**: Medium
**Priority**: Medium
**Dependencies**: 1.17
**Can run parallel with**: 2.1, 2.2, 2.5

**Technical Requirements**:

Per spec §8.7.1 ("Edges"):

Three edge types in total now:

1. **Contradictions** (red, solid) — already implemented in Task 1.17.
2. **Cross-pollination reactions** (blue, dashed) — for each `view.cross_pollination[].reactions[]`, an edge from the reactor's "home" cluster centre to the target claim's node. Hovering shows reactor persona, reaction type, content, confidence.
   - The reactor's home cluster: the working group whose pair the reactor was originally assigned to. Find it by searching `view.debates` for a debate whose `pair[*].id === reaction.by_persona_id`.
   - The "cluster centre" is a virtual node — easier to draw the edge from the first node of the cluster (the lowest-ranked node by `survival_rank` within the cluster). Implementer's call; the spec uses "cluster centre" semantically but doesn't pin the geometry.
3. **Intra-cluster references** (grey, faint, toggleable) — `references_move_id` chains within the same working group. Off by default (Mantine `<Switch>` above the canvas controls visibility). On demand for debugging calcification or Support chains.
   - Compute these as: for each non-Claim move in each debate, if the move references another move within the same debate, draw a faint grey edge between the two forum nodes corresponding to those moves' surviving claims (if any). Many moves won't map to surviving claims — skip those.

The Switch state lives in local `<ForumGraph>` state. When toggled on, regenerate the edges array with the additional grey edges; when toggled off, regenerate without them. React Flow with `useEdgesState` handles the re-render cleanly.

**Acceptance Criteria**:
- [ ] Blue dashed cross-pollination edges visible by default
- [ ] Hovering a blue edge shows reactor persona, type, content, confidence
- [ ] Switch above the graph toggles grey intra-cluster edges
- [ ] `722b7e3c-…` shows ~10 cross-pollination edges + 5 contradiction edges by default
- [ ] Grey edges only appear when the switch is on; canvas remains readable

---

### Task 2.4: `useHashRoute` + `useAnchorScroll` + wire all routes

**Description**: Implement hash-based navigation with smooth scroll and pulse animation; wire all five route patterns from spec §8.8.
**Size**: Medium
**Priority**: Medium
**Dependencies**: 1.13, 1.16, 1.17, 2.1, 2.2
**Can run parallel with**: 2.3, 2.5

**Technical Requirements**:

Per spec §8.8. Two hooks:

`hooks/useHashRoute.ts`:
```ts
import { useEffect, useState } from 'react';

export function useHashRoute(): string {
  const [route, setRoute] = useState(() => window.location.hash);
  useEffect(() => {
    const handler = () => setRoute(window.location.hash);
    window.addEventListener('hashchange', handler);
    return () => window.removeEventListener('hashchange', handler);
  }, []);
  return route;
}
```

`hooks/useAnchorScroll.ts`:
```ts
import { useEffect } from 'react';
import { tokens } from '../theme/tokens';

export function useAnchorScroll() {
  useEffect(() => {
    const handler = () => {
      const id = window.location.hash.slice(1);
      if (!id) return;
      const el = document.getElementById(id);
      if (!el) return;
      el.scrollIntoView({ behavior: 'smooth', block: 'start' });
      el.setAttribute('data-pulse', 'on');
      window.setTimeout(() => el.removeAttribute('data-pulse'), tokens.highlightPulseMs);
    };
    window.addEventListener('hashchange', handler);
    handler(); // run once on mount in case the URL came with a hash
    return () => window.removeEventListener('hashchange', handler);
  }, []);
}
```

CSS keyframes for the pulse — via Emotion's `Global` or per-element `css`:
```tsx
import { css, Global } from '@emotion/react';

<Global styles={css`
  @keyframes msv-pulse { 0% { background: rgba(86,180,233,.3); } 100% { background: transparent; } }
  [data-pulse="on"] { animation: msv-pulse 600ms ease-out; }
`}/>
```

Mount `<Global>` once in `App.tsx`. Call `useAnchorScroll()` once at the top of `App` (after `ViewProvider`).

Wire the route patterns:

- `#stage-<key>` — `<Timeline>` items already set this hash; native browser jump (Phase 1) + smooth scroll now via `useAnchorScroll`. Add `id={\`stage-${key}\`}` anchor markers to each detail section's `<Section>` wrapper.
- `#debate-<sq_id>` — `<DebateSection>` watches `useHashRoute` and opens the matching Accordion item via Mantine's controlled `<Accordion value={...}>`. The Accordion's `value` derives from the hash when it starts with `#debate-`.
- `#move-<move_id>` — every `<MoveCard>` already has `id={move.move_id}`. `useAnchorScroll` handles the scroll + pulse.
- `#node-<node_id>` — `<Forum>` reads `useHashRoute`; when it starts with `#node-`, switch the Tabs to graph, call `onNodeSelect(id)`, open the drawer.
- `#persona-<persona_id>` — `<Forum>` switches Tabs to persona-matrix, highlights the persona's row (add `id={\`persona-${persona_id}\`}` to each row, then the scroll handles itself; for highlight, set a CSS class via state).

**Acceptance Criteria**:
- [ ] Every Timeline-item click smooth-scrolls + pulses the target section
- [ ] Every `references_move_id` anchor smooth-scrolls + pulses the target move card
- [ ] Hash `#debate-sq_003` auto-opens the corresponding Accordion item
- [ ] Hash `#node-n_012` switches Forum to tab 1 + selects the node + opens the drawer
- [ ] Hash `#persona-p_006` switches Forum to tab 3 + scrolls + highlights the row
- [ ] Back/forward browser nav restores the right state via `hashchange`

---

### Task 2.5: Web-search capture (`src/anthropic.js` logging widening)

**Description**: Extend the SDK response wrapper to extract `server_tool_use` + `web_search_tool_result` blocks and append them to the relevant per-stage log under `kind: "web_search"`.
**Size**: Small
**Priority**: Medium
**Dependencies**: None (touches CLI side)
**Can run parallel with**: 2.1, 2.2, 2.3, 2.4

**Technical Requirements**:

Per spec §9.5:

Today `src/agents/discovery.js` logs only `candidate_count` and `search_query_count` per discovery response. The actual `server_tool_use` / `web_search_tool_result` blocks the SDK returns are dropped. Same for persona executors (`webSearchTool({ maxUses: 2 })` — when invoked, results disappear).

The widening: extend `src/anthropic.js`'s `runStructuredCall` (or add a separate helper called from each caller) so that `ServerToolUseBlock` (`type: 'server_tool_use'`, `name: 'web_search'`) and `WebSearchToolResultBlock` (`type: 'web_search_tool_result'`) content blocks are extracted from `response.content` and exposed alongside `toolUse` and `usage`.

**Important SDK constraint discovered during spec validation**: the SDK's `WebSearchResultBlock` does **not** expose a `snippet` field — its shape is `{ encrypted_content, page_age, title, url }`. The actual result text is wrapped in `encrypted_content`, opaque to the client. The inspector can show *what the model searched for* and *which pages it landed on*, but **not the prose excerpts the model read**.

**Implementation sketch** — extend `src/anthropic.js`:

```js
function extractWebSearches(response) {
  const blocks = response?.content || [];
  const searches = [];
  let pending = null;
  for (const block of blocks) {
    if (block.type === 'server_tool_use' && block.name === 'web_search') {
      if (pending) searches.push(pending);
      pending = { query: block.input?.query || '', results: [] };
    } else if (block.type === 'web_search_tool_result' && pending) {
      const content = Array.isArray(block.content) ? block.content : [];
      pending.results = content
        .filter((r) => r.type === 'web_search_result')
        .map((r) => ({ title: r.title, url: r.url, page_age: r.page_age ?? null }));
    }
  }
  if (pending) searches.push(pending);
  return searches;
}
```

Return `web_searches` from `runStructuredCall`:
```js
return { response, toolUse, usage, web_searches: extractWebSearches(response) };
```

Update each caller (`src/agents/discovery.js`, `src/agents/persona.js`) to append a log entry per search:
```js
for (const search of web_searches) {
  await appendLog(idea.id, logFile, { kind: 'web_search', payload: search });
}
```

The `logFile` for discovery is `'discovery'`; for persona executors during pair debates, it's `pair-${subQuestion.id}` (already passed in as `logFile`).

**Acceptance Criteria**:
- [ ] `runStructuredCall` returns `web_searches` array (empty when no search happened)
- [ ] `src/agents/discovery.js` appends `{kind: "web_search", payload: {query, results}}` log lines per search
- [ ] Persona executors do the same when they invoke web search
- [ ] A fresh `msv run` produces logs with `web_search` entries visible in the corresponding `.jsonl`
- [ ] No behavioural change to the agents themselves — only logging

---

### Task 2.6: Loader — web-search enrichment + Discovery search result rendering

**Description**: Loader populates `view.discovery.web_search_results[]` (and any persona-driven searches per debate). Discovery section renders the results.
**Size**: Small
**Priority**: Medium
**Dependencies**: 2.5, 1.4 (loader enrichments structure)
**Can run parallel with**: 2.1, 2.2, 2.3, 2.4

**Technical Requirements**:

**Loader side** — extend `src/inspect/loader/enrichments/discovery.js`:

```js
async function enrichDiscovery({ index, logs }) {
  const records = logs['discovery'] || [];
  const web_search_results = records
    .filter((r) => r.kind === 'web_search')
    .map((r) => ({
      query: r.payload?.query || '',
      results: (r.payload?.results || []).map((x) => ({
        title: x.title,
        url: x.url,
        page_age: x.page_age ?? null,
      })),
    }));
  // existing timings logic preserved
  return { timings, web_search_results };
}
```

Optionally also expose per-debate web searches under `view.debates[sq_id].web_searches` if any persona invoked search mid-debate. Read each `pair-<sq_id>.jsonl` log for `kind: "web_search"` records and attach. Persona executors with `maxUses: 2` will rarely produce searches — this is mostly a nice-to-have.

**SPA side** — implement the real `<SearchResultList>` (replacing the stub from Task 1.14):

Per spec §8.6.3:
- Phase 2 only. Mantine `<Accordion>` keyed by query; each panel lists `{ title, url, page_age }` rows as `<Anchor target="_blank" rel="noopener noreferrer">`.
- URL validation per spec §12: the `href` attribute must start with `https://`. Any other scheme (`javascript:`, `data:`, `file:`) is replaced with `#` and the link styled as inert (`<Text c="dimmed">` with the title only).

```tsx
function safeHref(url: string): string {
  return url.startsWith('https://') ? url : '#';
}

export function SearchResultList() {
  const view = useViewContext();
  const searches = view.discovery.web_search_results;
  if (searches.length === 0) {
    return <Empty title="No web search results captured" />;
  }
  return (
    <Accordion>
      {searches.map((s, i) => (
        <Accordion.Item key={i} value={String(i)}>
          <Accordion.Control>{s.query}</Accordion.Control>
          <Accordion.Panel>
            <Stack gap="xs">
              {s.results.map((r, j) => (
                <Anchor key={j} href={safeHref(r.url)} target="_blank" rel="noopener noreferrer">
                  {r.title}
                  {r.page_age && <Text component="span" c="dimmed" size="xs"> · {r.page_age}</Text>}
                </Anchor>
              ))}
            </Stack>
          </Accordion.Panel>
        </Accordion.Item>
      ))}
    </Accordion>
  );
}
```

**Acceptance Criteria**:
- [ ] Loader populates `view.discovery.web_search_results[]` from new `kind: "web_search"` log entries
- [ ] Discovery section renders the queries → results mapping
- [ ] Non-https URLs render inert (no `javascript:`/`data:` execution)
- [ ] Anchors open in a new tab with `rel="noopener noreferrer"`
- [ ] When no searches captured (older runs), shows the Empty state, not a crash

---

## Dependency graph (visual summary)

```
1.1 (config)──────────────────────┬──→ 1.10 (SPA bootstrap) ──┬──→ 1.12-1.19 (sections)
                                   └──→ 1.11 (theme) ─────────┘                  │
1.2 (atomicWriteText) ─→ 1.9 (CLI)                                                │
1.3 (readers) ──┬──→ 1.4 (enrichments) ──→ 1.5 (view builder) ─→ 1.6 (types)     │
                └──→                                            └──→ 1.9 ────────┤
1.7 (openBrowser) ──→ 1.9                                                         │
1.8 (server) ──→ 1.9 ──→ 1.20 (fixtures) ──→ 1.21 (loader.test) + 1.22 (view.test)│
                                                                                  │
1.16 (Debate) ───┬──→ 2.1 (NodeDrawer) ───→ Phase 2 Forum tabs                    │
1.17 (Forum) ────┘                                                                │
                                              2.2 (tabs 2/3) ─────────────────────┘
                                              2.3 (more edges)
                                              2.4 (hash routing)
                                              2.5 (anthropic widening) ──→ 2.6 (search results)
                                              1.23 (README) — any time after 1.9
```

## Parallel execution opportunities

- **First wave (no dependencies)**: 1.1, 1.2, 1.3, 1.7
- **Second wave**: 1.4, 1.5, 1.8, 1.11 (after 1.1)
- **Third wave**: 1.6, 1.10 (after 1.5 and 1.1)
- **UI components 1.12–1.19**: all parallelisable after 1.10 + 1.11
- **CLI command 1.9**: needs 1.2, 1.3, 1.4, 1.5, 1.7, 1.8
- **Tests 1.21, 1.22**: parallel after 1.4 + 1.5 + 1.20
- **Phase 2 tasks 2.1–2.6**: largely independent of each other; only 2.6 depends on 2.5

## Risk areas

- **1.16 (Debate)** is the largest single task — confidence chart custom dots + move card formatting + accordion + anchor handling. Plan for 2–3 days even with the spec laying it out.
- **1.17 (Forum graph)** has a custom layout algorithm and React Flow integration. Slightly less complex than 1.16 because React Flow handles most heavy lifting.
- **2.5 (anthropic.js widening)** touches the existing pipeline. Smoke-test against a real `msv run` after the change to confirm no regressions in non-search code paths.

## Total tasks: 29
- Phase 1: 23 tasks (1.1–1.23)
- Phase 2: 6 tasks (2.1–2.6)
