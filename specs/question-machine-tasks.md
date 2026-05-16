# Task Breakdown: Rebuild msv as a Question-Generation Machine (v5)

**Generated:** 2026-05-16
**Source:** `specs/question-machine.md`
**STM task IDs:** see `stm list` after running `/spec:decompose`.

> **Implementation status:** This document is a static decomposition artifact. Live status lives in STM (`stm list --pretty`). As of 2026-05-16, Phases 0–9 are implemented except for the three smoke-test tasks (11, 27, 32) which require real API calls.

---

## Overview

Structural rewrite of msv from a debate-centric pipeline (v4) to a question-generation pipeline (v5). The Coordinator emits broad territories instead of focused sub-questions; working groups internally run a six-sub-stage flow (Independent Ideation → Adversarial Pre-check → Alignment Debate → Researcher Delegation → Independent Observation → Pair Debate); a new Joint Researcher sub-agent does heavy retrieval via `web_search` + `web_fetch`; debate Claims require strict citation (`evidence_refs` with ≥1 observation_id AND ≥1 finding_id).

The breakdown follows the spec's 10 phases (0 through 9). Each task is self-contained — STM `--details` carries the exact code, schema, algorithm, and prompts needed to implement it without re-reading the spec.

---

## Execution Strategy

- **Sequential phases.** Each phase depends on the prior phase's smoke run passing. Within a phase, the listed tasks may run in parallel where dependencies allow.
- **Phase 0 is a hard gate.** v4 must still work end-to-end against the bumped SDK before any v5 code lands.
- **Phase 8 (inspect) depends on Phase 7's smoke output** as fixture seed.
- **Smoke runs are ad-hoc** — the spec accepts manual verification per the v4 testing posture (§8).

---

## Phase 0 — SDK bump + request queue

### Task 0.1: Bump `@anthropic-ai/sdk` to a version that exposes `web_fetch`

**Size:** Small | **Priority:** High | **Dependencies:** none | **Parallel:** none (gates Phase 1)

`@anthropic-ai/sdk@0.54.0` does not export `web_fetch`. Latest stable is ≥0.96.0 as of 2026-05; pin to whatever the latest stable is at implementation time. Update `package.json` and `package-lock.json`. Run `npm install` and confirm `node_modules/@anthropic-ai/sdk/resources/messages/messages.d.ts` references `web_fetch_*`.

**Acceptance:**
- `package.json` `@anthropic-ai/sdk` version ≥ 0.96.0.
- `grep -rn "web_fetch" node_modules/@anthropic-ai/sdk/resources` returns at least one hit.
- Existing `import { Anthropic } from '@anthropic-ai/sdk'` import sites still type-check / require without error.

### Task 0.2: Build `src/api_queue.js` — concurrency-bounded request queue

**Size:** Medium | **Priority:** High | **Dependencies:** 0.1 | **Parallel:** none

Single entry point for every `client.messages.create` call across the codebase. Responsibilities:
- Bounded concurrency (start at 6; document tunable).
- 429 backoff: prefer `Retry-After` header; fall back to exponential backoff with jitter (base 1s, max 30s) when absent.
- Per-error-class policy: retry on 429, 503, network errors; surface 4xx (except 429) immediately.
- Max retries = 5 per call.

Evaluate `bottleneck` or `p-queue` for the concurrency primitive before hand-rolling. Both are zero-config-friendly. If using a library, wrap it; expose a single `enqueue(fn): Promise` function plus a `getStats()` helper for in-progress / queued / completed counters surfaced in progress output.

Top-of-file comment documents the SDK version it was built against and the chosen tunables.

**Acceptance:**
- Module exports `enqueue(fn): Promise` and `getStats(): {inflight, queued, completed, retried}`.
- Unit-tested with a stub client that throws 429 → confirm the queue waits and retries.
- Unit-tested with a stub client that throws a non-retryable 4xx → confirm the error surfaces without retry.

### Task 0.3: Route every existing v4 `messages.create` call through `src/api_queue.js`; run v4 regression smoke

**Size:** Medium | **Priority:** High | **Dependencies:** 0.2 | **Parallel:** none

Audit every `messages.create` callsite and rewrite to `apiQueue.enqueue(() => client.messages.create(...))`. Callsites live in `src/agents/*.js` and `src/anthropic.js`. Capture the list in the PR description.

After routing, run the v4 end-to-end smoke (existing `msv run` against a throwaway idea) on the new SDK. Fix any regressions in `messages.create` payload shape, tool-result block handling, or forced-tool semantics until the v4 run completes successfully.

**Acceptance:**
- `grep -rn "messages\.create" src/ | grep -v api_queue` returns zero hits.
- `msv add` + `msv run <id>` against a throwaway idea completes with `status: "ready"` and a non-empty synthesis report.

---

## Phase 1 — Scaffolding and schema

### Task 1.1: Schema constants, v5 `freshInvestigation()`, `schema_version` legacy dispatcher

**Size:** Medium | **Priority:** High | **Dependencies:** 0.3 | **Parallel:** 1.2, 1.3, 1.4

Edit `src/storage.js`:
- `freshInvestigation()` returns the v5 shape including `schema_version: "v5"` and the new budget fields:
  - `max_executor_calls: 180` (was 60)
  - `max_total_tokens: 1_500_000` (was 500_000)
  - `max_researcher_tool_calls: 60` (new)
  - `used_researcher_tool_calls: 0` (new)
- Drop `coordinator_decisions.spawn` from the fresh shape (v5 coordinator runs once).
- Rename `coordinator_decisions.initial.sub_questions` → `coordinator_decisions.initial.territories` in the fresh shape.
- New per-pair fields: `territory_id`, `candidate_questions[]`, `adversarial_marks[]`, `aligned_questions[]`, `researcher_reports[]`, `observations[]`. (Empty arrays at init.)
- New forum field: `dead_end_questions[]`.
- New synthesis fields: `question_landscape`, `dead_end_summary`.

Loader: on read, if `investigation.schema_version` is missing, set it to `"v4"` so legacy ideas continue to render through v4 code paths. Never mutate the on-disk JSON during read — only the in-memory copy.

The v4 `pair_debates[].sub_question_id` field is removed for new investigations. Legacy v4 ideas keep the field; v5 ideas key on `territory_id` only.

Extend `test/storage.test.js` with two cases:
1. `freshInvestigation()` returns an object whose `investigation.schema_version === "v5"` and whose `budget.max_researcher_tool_calls === 60`.
2. Loading a fixture without `schema_version` returns an object with `schema_version === "v4"` in memory.

**Acceptance:**
- `node -e "console.log(require('./src/storage').freshInvestigation().schema_version)"` prints `v5`.
- Loading any of the existing `test/fixtures/inspect/*` (v4-shaped) sets `schema_version === "v4"` in memory.
- `npm test -- test/storage.test.js` passes both new cases.

### Task 1.2: New tool schemas + validators in `src/moves.js`

**Size:** Medium | **Priority:** High | **Dependencies:** 0.3 | **Parallel:** 1.1, 1.3, 1.4

Add to `src/moves.js`:

- `ALIGNMENT_MOVE_TYPES = ['Propose', 'Sharpen', 'Merge', 'Drop', 'Defer']`.
- `ALIGNMENT_JSON_SCHEMA` — the move shape for stage 5.4c alignment moves (Propose / Sharpen / Merge / Drop / Defer); references which `candidate_id` (or sharpened/merged candidate) it acts on.
- `IDEATION_JSON_SCHEMA` — the candidate-question shape: `{ candidate_id, by_persona_id, question, predicted_answer, predicted_confidence: integer 0-10, surface_area_rationale }`.
- `ADVERSARIAL_MARK_JSON_SCHEMA` — `{ candidate_id, marker_persona_id, could_answer_from_priors: boolean, predicted_answer: string (optional, present when could_answer_from_priors is true) }`.
- `OBSERVATION_JSON_SCHEMA` — `{ observation_id, by_persona_id, report_id, content, cited_finding_ids: [string, ...] (min 1) }`.
- `RESEARCHER_REPORT_JSON_SCHEMA` — see Task 4.1 for the exact JSON Schema.

Extend `MOVE_JSON_SCHEMA` with:
- `stage`: enum `["alignment", "debate"]`.
- `evidence_refs`: array of objects matching either `{ observation_id: string }` or `{ finding_id: string }`. Optional at schema level — validation that it's *required* for debate Claims lives in `validateDebateMove`.

Add `validateDebateMove(move, pairScope) -> { valid: boolean, error?: string }`:
- If `move.stage === "debate"` and `move.type === "Claim"`:
  - Reject if `evidence_refs` is empty or missing.
  - Reject if zero `evidence_refs` entries carry an `observation_id`.
  - Reject if zero `evidence_refs` entries carry a `finding_id`.
  - Reject if any `observation_id` does not resolve to an entry in `pairScope.observations`.
  - Reject if any `finding_id` does not resolve to an entry in `pairScope.findings`.
- For non-Claim moves in `stage: "debate"`: if `evidence_refs` is present, every reference must resolve in `pairScope`; missing-reference rejection only.
- For `stage: "alignment"`: skip evidence_refs validation.

Keep all existing v4 validators unchanged.

Extend `test/moves.test.js` (per spec §8.1) with cases:
1. Debate Claim missing `evidence_refs` → rejected.
2. Debate Claim with only observation_id (no finding_id) → rejected.
3. Debate Claim with only finding_id (no observation_id) → rejected.
4. Debate Claim with both refs, both resolving → accepted.
5. Debate Claim with both refs, finding_id unknown → rejected.
6. Alignment Propose move with no evidence_refs → accepted (alignment moves don't require refs).
7. Each new schema (`IDEATION`, `ADVERSARIAL_MARK`, `OBSERVATION`) validates a well-formed example and rejects a malformed one.

Each test has a `// Test: …` leading comment explaining the assertion's purpose.

**Acceptance:**
- All seven new test cases pass.
- `npm test -- test/moves.test.js` green.

### Task 1.3: Empty module scaffolds for `src/working_group.js`, `src/agents/researcher.js`

**Size:** Small | **Priority:** Medium | **Dependencies:** 0.3 | **Parallel:** 1.1, 1.2, 1.4

Create two files with `module.exports = {};` and a header comment pointing at the spec section that owns the file (`§6.4` for `working_group.js`, `§6.5` for `researcher.js`). The real implementations land in Phases 3 / 4 / 5.

No stub functions that throw — keep the surface area empty so Phase 1 doesn't lock in placeholder shapes that get rewritten.

**Acceptance:**
- Both files exist, `require()`-able.
- Each has a header comment referencing the spec.

### Task 1.4: `MODEL` / `SYNTHESIZER_MODEL` constants in `src/anthropic.js`

**Size:** Small | **Priority:** High | **Dependencies:** 0.3 | **Parallel:** 1.1, 1.2, 1.3

Rename `DEFAULT_MODEL` (the v4 export) to `MODEL`. Add `SYNTHESIZER_MODEL` next to it:

```js
const MODEL = 'claude-sonnet-4-6';
const SYNTHESIZER_MODEL = 'claude-haiku-4-5-20251001';
```

Update every existing import of `DEFAULT_MODEL` to import `MODEL` instead. Synthesizer call site (`src/agents/synthesizer.js`) reads `SYNTHESIZER_MODEL`. `investigation.model` continues to be populated with `MODEL` at run time (v4 read-path compatibility); add a new `investigation.synthesizer_model` field populated with `SYNTHESIZER_MODEL`.

**Acceptance:**
- `grep -n "DEFAULT_MODEL" src/` returns zero hits.
- A v4-shaped legacy idea's `investigation.model` field still reads as the Sonnet ID.
- A freshly-created idea has both `investigation.model === 'claude-sonnet-4-6'` and `investigation.synthesizer_model === 'claude-haiku-4-5-20251001'`.

### Task 1.5: Rewire `src/commands/run.js` to the new orchestrator surface

**Size:** Medium | **Priority:** High | **Dependencies:** 1.1, 1.2, 1.3, 1.4 | **Parallel:** none

Edit `src/commands/run.js`:
1. Delete the `runCoordinatorSpawn` import (line ~20).
2. Delete the spawn-round if-block (lines 174–200; recovering the spawn decision, conditional spawn-pair debates, the `spawnDecision.sub_questions` aggregation).
3. Replace the pair-debate dispatch with per-territory dispatch into a new `runWorkingGroup` helper (initially imported from the scaffold, will be filled in later phases).
4. Update progress lines to the v5 shape from §7.2 of the spec (territories, six sub-stages per pair, no spawn round).

The orchestrator now reads `investigation.coordinator_decisions.initial.territories[]` and dispatches one `runWorkingGroup({ client, idea, model, synthesizerModel, budget, territory, personas })` per territory under `Promise.allSettled`.

**Acceptance:**
- `node -e "require('./src/commands/run')"` succeeds (no import errors).
- The file no longer references `runCoordinatorSpawn` or `spawnDecision`.
- Progress lines match the v5 format from §7.2 (visual inspection — exact strings flex).

---

## Phase 2 — Discovery and coordinator updates

### Task 2.1: Rewrite `PERSPECTIVE_DISCOVERY` prompt

**Size:** Small | **Priority:** High | **Dependencies:** 1.5 | **Parallel:** 2.2

In `src/agents/prompts.js`, rewrite `PERSPECTIVE_DISCOVERY` to shift from "what does this tradition believe?" to **"what does this tradition find puzzling, surprising, or under-investigated?"** Reframe each candidate persona as a curious investigator first, advocate second.

The runner shape in `src/agents/discovery.js` is unchanged — only the system prompt changes. Candidate personas should still emit the same JSON shape so the diversity selection (`src/diversity.js`) and downstream coordinator both keep working without changes.

**Acceptance:**
- One smoke run produces candidate personas whose `description` fields are framed interrogatively (manual inspection).
- The existing diversity selection still chooses 5 personas from the candidate list (no schema regression).

### Task 2.2: Replace `COORDINATOR_INITIAL` with `COORDINATOR_TERRITORIES`; delete `runCoordinatorSpawn`

**Size:** Medium | **Priority:** High | **Dependencies:** 1.5 | **Parallel:** 2.1

In `src/agents/prompts.js`:
- Add `COORDINATOR_TERRITORIES`: decompose the idea into **4–5 broad territories**. Each territory has `name` (short kebab-case) and `description` (1–2 sentences). Pair personas to maximize productive tension. Justify each territory briefly.
- Delete `COORDINATOR_INITIAL` and `COORDINATOR_SPAWN` constants entirely.

In `src/agents/coordinator.js`:
- Rename / rewire `runCoordinatorInitial` to emit `territories: [{ id, name, description, assigned_pair: [persona_id, persona_id], rationale }]` via a new `emit_territories` tool (forced).
- Delete `runCoordinatorSpawn` function and its export. Delete the `emit_spawn_decision` tool definition.

The investigation JSON now stores: `investigation.coordinator_decisions.initial.territories[]` instead of `.sub_questions[]`. `investigation.coordinator_decisions.spawn` field is gone.

**Acceptance:**
- `grep -n "runCoordinatorSpawn\|COORDINATOR_SPAWN\|COORDINATOR_INITIAL\|emit_spawn_decision" src/` returns zero hits.
- `grep -n "COORDINATOR_TERRITORIES\|emit_territories\|territories" src/agents/coordinator.js` returns hits.
- A v5 dry-run on a throwaway idea writes `coordinator_decisions.initial.territories[]` to `investigation.json`.

### Task 2.3: Smoke test — discovery + selection + coordinator (stages 1–3)

**Size:** Small | **Priority:** High | **Dependencies:** 2.1, 2.2 | **Parallel:** none

Run `msv add` + `msv run <id>` on a throwaway topic and inspect:
- `investigation.perspective_discovery.candidate_personas` reflects interrogative framing.
- `investigation.coordinator_decisions.initial.territories[]` has 4–5 entries with `name`, `description`, `assigned_pair`.
- The run halts here (working-group stage is not yet implemented; `runWorkingGroup` is still empty — `Promise.allSettled` returns immediately with no work done).

Capture the resulting idea directory as the Phase 3 seed.

**Acceptance:**
- All three v5 fields visible in the output JSON.
- No regressions vs the v4 discovery / selection paths.

---

## Phase 3 — Working-group sub-stages 5.4a–5.4c

### Task 3.1: `PERSONA_IDEATION` prompt + `runIdeation` in `persona.js`

**Size:** Medium | **Priority:** High | **Dependencies:** 2.3 | **Parallel:** 3.2

In `src/agents/prompts.js`, add `PERSONA_IDEATION`: Generate 4–6 candidate questions for the territory. For each, predict your prior-only answer, rate prediction confidence (0–10), articulate why the question is worth asking. Stay interrogative — you are asking questions, not advocating.

In `src/agents/persona.js`, add `runIdeation({ client, idea, model, budget, territory, persona, otherPersona }) -> { candidate_questions: [...] }`:
- One forced tool call to `emit_candidate_question` (array output: 4–6 entries).
- Tool schema matches `IDEATION_JSON_SCHEMA` from Task 1.2.
- Result entries: `{ candidate_id: 'cq_<NNN>', by_persona_id, question, predicted_answer, predicted_confidence, surface_area_rationale }`.
- `candidate_id` is assigned by the orchestrator post-hoc; the tool emits without it and `working_group.js` stamps IDs.
- Logged via the new `pair-<territory_id>-ideation.jsonl` log file (Task 3.6 wires this).

**Acceptance:**
- Stub-client test: forced-tool call returns 4–6 candidates with all fields populated.
- One real call against the API produces a non-empty array.

### Task 3.2: `PERSONA_ADVERSARIAL` prompt + `runAdversarialMark` in `persona.js`

**Size:** Medium | **Priority:** High | **Dependencies:** 2.3 | **Parallel:** 3.1

In `src/agents/prompts.js`, add `PERSONA_ADVERSARIAL`: For each of the other persona's candidate questions, mark whether you could confidently answer it from priors alone. If yes, briefly say what your answer would be. Honesty is the point — if you don't know, say so.

In `src/agents/persona.js`, add `runAdversarialMark({ client, idea, model, budget, territory, persona, otherPersonaCandidates }) -> { adversarial_marks: [...] }`:
- Single forced tool call to `emit_adversarial_mark` (array output: one mark per other-persona candidate).
- Tool schema matches `ADVERSARIAL_MARK_JSON_SCHEMA` from Task 1.2.
- Result entries: `{ candidate_id, marker_persona_id, could_answer_from_priors: boolean, predicted_answer?: string }`.
- Logged via `pair-<territory_id>-adversarial.jsonl`.

**Acceptance:**
- Stub-client test: emits one mark per input candidate.
- Marks where `could_answer_from_priors: false` may omit `predicted_answer`.

### Task 3.3: `ALIGNMENT_DEBATE` prompt + `runAlignmentMove` in `persona.js`

**Size:** Medium | **Priority:** High | **Dependencies:** 3.1, 3.2 | **Parallel:** none

In `src/agents/prompts.js`, add `ALIGNMENT_DEBATE`: Restricted move set (Propose, Sharpen, Merge, Drop, Defer). Goal: settle on up to 5 aligned questions. The minority-protection rule will be enforced deterministically afterward; you do not need to argue for it.

In `src/agents/persona.js`, add `runAlignmentMove({ client, idea, model, budget, territory, persona, transcript, candidates, marks }) -> { move: AlignmentMove }`:
- Single move per call (sequential, like v4 debate moves).
- Tool: `emit_alignment_move` (forced), schema matches `ALIGNMENT_JSON_SCHEMA` from Task 1.2.
- Move shape: `{ move_id, by_persona_id, type, target_candidate_id, content, stage: "alignment" }` where `type ∈ {Propose, Sharpen, Merge, Drop, Defer}`.
- For `Sharpen`: include the sharpened question text in `content`.
- For `Merge`: `target_candidate_id` is an array of two candidate_ids being merged; `content` is the merged question text.
- `move_id` format: `m_<territory_id>_alignment_<NNNN>` assigned by orchestrator.
- Logged via `pair-<territory_id>-alignment.jsonl`.

**Acceptance:**
- Stub-client tests cover one example of each move type.
- The `ALIGNMENT_MOVE_TYPES` constant from Task 1.2 is the source-of-truth list.

### Task 3.4: Deterministic alignment post-step in `src/working_group.js` (load-bearing minority-protection algorithm)

**Size:** Large | **Priority:** High | **Dependencies:** 3.3 | **Parallel:** none

This is the load-bearing rule for the entire v5 experiment. Implement `selectAlignedQuestions({ alignmentSurvivors, candidates, marks, personas, MAX_ALIGNED_QUESTIONS = 5 }) -> AlignedQuestion[]` in `src/working_group.js`.

Algorithm (copy verbatim from spec §6.4 step 3):

1. **Build the alignment-surviving pool.** Every candidate question that was Proposed in 5.4c and not Dropped/Deferred, with Sharpen and Merge edits applied. Each entry carries its `by_persona_id`.

2. **Rank the alignment-surviving pool**:
   - Primary key: `predicted_confidence` descending.
   - Secondary key: count of adversarial marks where the *other* persona said `could_answer_from_priors: false` (more such marks = better — the question genuinely surfaces an unknown).
   - Final tie-break: `candidate_id` ascending (deterministic).

3. **Take the top 3 jointly-rated entries** from this ranked pool. Tag each with `origin: "aligned"`.

4. **For each pair member separately**, take that persona's highest-ranked alignment-surviving candidate that is **not already in the chosen 3**. Tag with `origin: "minority_<persona_id>"`. If the persona had no surviving candidates at all, skip — no minority slot is forced for that persona.

5. **Deduplicate by candidate_id**: a candidate already promoted by step 3 cannot also be a minority pick — the minority slot moves to the next-best candidate from that persona.

6. **Cap the final list at 5.** The algorithm produces at most 3 + 2 = 5 entries after dedup, so the cap is structural; it rejects nothing in practice.

**Worked example (copy as inline comment for future readers):** Personas A and B. A's alignment-surviving candidates ranked: a1(conf=8), a2(conf=6), a3(conf=4). B's ranked: b1(conf=7), b2(conf=5). Joint ranking by confidence: a1, b1, a2, b2, a3. Step 3 picks {a1, b1, a2}. Step 4 picks A's best not-already-picked → a3, and B's best not-already-picked → b2. Final aligned set: {a1, b1, a2, a3, b2}, origins `aligned, aligned, aligned, minority_A, minority_B`.

**Counter-example:** If B's only surviving candidate is b1 and step 3 picks {a1, b1, a2}, step 4 picks a3 for A and **skips** B (no remaining B candidate). Final: 4 questions — no slot is fabricated.

Output: `[{ aligned_id: 'aq_<NNN>', question, origin: "aligned" | "minority_<persona_id>", source_candidate_ids: [...] }]`. `aligned_id` is assigned in order of selection.

Add a top-of-function comment explaining the minority-protection enforcement (per spec §11 "in-code comments" — surprise factor for a future reader).

**Acceptance:**
- Function is exported, pure (no I/O), and deterministic given the same input.
- See Task 3.5 for unit tests.

### Task 3.5: Unit tests for `selectAlignedQuestions` in `test/working_group.test.js` (new file)

**Size:** Medium | **Priority:** High | **Dependencies:** 3.4 | **Parallel:** none

Create `test/working_group.test.js`. Each test has a leading `// Test: …` comment explaining its purpose.

Test scenarios:
1. **Worked example from spec §6.4** (5 survivors, both personas contribute). Asserts: final set is `[a1, b1, a2, a3, b2]` with origins `[aligned, aligned, aligned, minority_A, minority_B]`.
2. **Counter-example from spec §6.4** (B has only one survivor, gets picked in step 3, no minority slot for B). Asserts: final set has 4 entries, no `minority_B` origin.
3. **Tie-break by adversarial marks.** Two candidates with `predicted_confidence: 7`; one has 3 "cannot answer from priors" marks, the other has 1. Asserts: the one with more such marks ranks higher.
4. **Final tie-break by candidate_id.** Identical confidence and adversarial marks; lower `candidate_id` wins.
5. **Cap at 5.** Force-feed 8 survivors (4 from each persona, all with distinct confidences). Asserts: exactly 5 returned, originating from both personas.
6. **Empty input.** No survivors → returns empty array, no error.
7. **One persona has zero survivors.** Asserts: 3 jointly-aligned + 1 minority from the other persona (no error from missing-persona path).

**Acceptance:**
- All seven cases pass.
- `CI=true npm test -- test/working_group.test.js` green.

### Task 3.6: Wire 5.4a/b/c into `src/working_group.js`; smoke test stages 1–3 + 5.4a/b/c

**Size:** Medium | **Priority:** High | **Dependencies:** 3.4, 3.5 | **Parallel:** none

In `src/working_group.js`, implement the entry point `runWorkingGroup({ client, idea, model, synthesizerModel, budget, territory, personas }) -> pair_debate`:

1. **5.4a Independent Ideation.** `Promise.all` over the two personas calling `runIdeation`. Stamp `candidate_id` values (`cq_<territory_id>_<NN>` to keep stable). Persist `candidate_questions[]` to `investigation.json` (atomic via `writeIdea`).

2. **5.4b Adversarial Pre-check.** `Promise.all` over the two personas calling `runAdversarialMark`, each given the *other's* `candidate_questions`. Persist `adversarial_marks[]`.

3. **5.4c Alignment Debate.** Sequential `runAlignmentMove` calls bounded by `ALIGNMENT_MOVE_BUDGET = 8`. Pair sees: candidates + adversarial marks + prior alignment moves. Persist each move under `pair_debates[].moves[]` with `stage: "alignment"`. After the loop, call `selectAlignedQuestions` and persist `aligned_questions[]`.

For phase 3, the function returns after step 3 (stages 5.4d–f land in Phase 5). Subsequent phases extend it.

Logging: each sub-stage uses its dedicated `pair-<territory_id>-{ideation,adversarial,alignment}.jsonl` file. Concurrent appends within a sub-stage rely on the existing append-only helper (§6.11 — single line per await, O_APPEND, sub-PIPE_BUF lines).

Smoke test: one pair, one territory, end-to-end stages 1–3 + 5.4a/b/c.

**Acceptance:**
- `investigation.json` after the smoke run contains:
  - `pair_debates[].candidate_questions[]` (4–6 per persona)
  - `pair_debates[].adversarial_marks[]` (one per other-persona candidate)
  - `pair_debates[].moves[]` with `stage: "alignment"` (≤ 8 moves)
  - `pair_debates[].aligned_questions[]` (≤ 5 entries with `origin` tags)
- At least one `origin: "minority_<persona_id>"` entry per pair (verifying the load-bearing rule on a real run).
- All three log files exist and have content.

---

## Phase 4 — Joint Researcher

### Task 4.1: `RESEARCHER` prompt + `emit_researcher_report` tool schema + `RESEARCHER_REPORT_JSON_SCHEMA`

**Size:** Medium | **Priority:** High | **Dependencies:** 3.6 | **Parallel:** 4.2

In `src/agents/prompts.js`, add `RESEARCHER`. The system prompt emphasizes:
- **Source quality hierarchy** (adapted from claudekit's research-expert): primary sources > academic > professional > news > general web.
- **Red flags**: content farms, undated content, sources without citations.
- **Honest outcome**: `outcome` must be one of `"useful" | "partial" | "dead_end"` and reflect what the researcher actually found, not what they hoped to find.
- **Confidence semantics**: each finding's `confidence_in_source` reflects source quality, not finding plausibility.

In `src/moves.js`, add `RESEARCHER_REPORT_JSON_SCHEMA` (verbatim from spec §6.5):

```json
{
  "type": "object",
  "required": ["outcome", "findings", "search_trace"],
  "properties": {
    "outcome": { "enum": ["useful", "partial", "dead_end"] },
    "findings": {
      "type": "array",
      "minItems": 0,
      "items": {
        "type": "object",
        "required": ["summary", "source_url", "source_quote", "confidence_in_source"],
        "properties": {
          "summary": { "type": "string", "minLength": 1 },
          "source_url": { "type": "string" },
          "source_quote": { "type": "string", "minLength": 1 },
          "confidence_in_source": { "type": "integer", "minimum": 0, "maximum": 10 }
        }
      }
    },
    "search_trace": {
      "type": "array",
      "items": { "type": "string" }
    }
  }
}
```

Define the `EMIT_RESEARCHER_REPORT_TOOL = { name: 'emit_researcher_report', input_schema: RESEARCHER_REPORT_JSON_SCHEMA }`.

`finding_id` values are NOT in the schema — they're assigned by the orchestrator post-hoc as `f_<aligned_id>_<NN>` (Task 5.3 stamps them).

**Acceptance:**
- The schema validates a well-formed example report and rejects a malformed one (test in `test/moves.test.js`).
- The `RESEARCHER` prompt is exported from `prompts.js`.

### Task 4.2: `runJointResearcher` loop in `src/anthropic.js`

**Size:** Large | **Priority:** High | **Dependencies:** 4.1 | **Parallel:** 4.1

Implement `runJointResearcher({ client, idea, budget, aligned_question, territory_context, persona_lenses }) -> researcher_report` in `src/anthropic.js`. The loop:

1. **Plan**: broad-search prompt — generate 1–2 search queries from the aligned question.
2. **Execute**: call `web_search`; capture results.
3. **Read**: from search results, pick 2–4 URLs worth fetching. Call `web_fetch` on each.
4. **Reflect**: did this answer the question? If yes, emit final report. If no, identify gap.
5. **Gap-fill**: 1–2 more targeted searches or fetches.
6. **Emit**: final `researcher_report` via forced tool `emit_researcher_report`.

Implementation: a single Anthropic message loop with `tools: [webSearchTool({ maxUses: 4 }), webFetchTool({ maxUses: 6 }), EMIT_RESEARCHER_REPORT_TOOL]`.

**Loop bounds:**
- `RESEARCHER_TOOL_BUDGET = 10` total tool calls (search + fetch combined).
- `RESEARCHER_TURN_BUDGET = 6` model turns.

**Force-emit trigger (verbatim from spec §6.5):**
- For turns 1 through `RESEARCHER_TURN_BUDGET - 1`, `tool_choice` is `auto` and `emit_researcher_report` is available alongside web_search/web_fetch — the model may voluntarily emit at any point.
- When *either* `used_tool_calls >= RESEARCHER_TOOL_BUDGET` *or* `turn_index == RESEARCHER_TURN_BUDGET - 1` (final turn), the next request switches `tool_choice` to `{ type: "tool", name: "emit_researcher_report" }` and appends a user message: `"Tool budget exhausted; emit your researcher_report now via emit_researcher_report based on what you have."` The model has no other valid action.

Track `used_researcher_tool_calls` on the budget object across all researcher invocations in the run (the orchestrator-shared counter from §6.3).

Logged to `pair-<territory_id>-researcher-<aligned_id>.jsonl` — each request, tool_use, tool_result, and final emission appended.

Route every `messages.create` through `apiQueue.enqueue` (Task 0.2).

**Acceptance:**
- Stub-client test (Task 4.3) demonstrates force-emit triggers on `used_tool_calls >= RESEARCHER_TOOL_BUDGET`.
- Stub-client test demonstrates force-emit triggers on `turn_index == RESEARCHER_TURN_BUDGET - 1` even if tool budget not exhausted.
- One real call against an aligned question returns a `researcher_report` matching `RESEARCHER_REPORT_JSON_SCHEMA`.

### Task 4.3: `test/researcher.test.js` (new) + smoke test one aligned question

**Size:** Medium | **Priority:** High | **Dependencies:** 4.2 | **Parallel:** none

Create `test/researcher.test.js`. Each test has a leading `// Test: …` comment.

Test scenarios with a stubbed Anthropic client:
1. **Voluntary emit on turn 2.** Stub returns search results on turn 1, emits `researcher_report` on turn 2. Asserts: loop terminates after turn 2 with the report.
2. **Force-emit on tool budget exhaustion.** Stub keeps issuing `web_search` calls. Asserts: after `RESEARCHER_TOOL_BUDGET = 10` tool calls, the next request has `tool_choice: { type: "tool", name: "emit_researcher_report" }` and the user message is appended.
3. **Force-emit on turn budget exhaustion.** Stub keeps issuing text responses (no tool calls). Asserts: at `turn_index == RESEARCHER_TURN_BUDGET - 1`, the next request switches to forced emit.
4. **Final emission validated against schema.** Stub emits a `dead_end` outcome with `findings: []`. Asserts: the orchestrator accepts and returns the report without error.

Smoke test: one aligned question (from the Phase 3 seed idea) through the real researcher; manually inspect the resulting `researcher_report` for shape, citations, and outcome plausibility.

**Acceptance:**
- All four stub-client cases pass.
- The smoke run yields a `researcher_report` with at least one finding (or a documented `dead_end` outcome).
- `pair-<territory_id>-researcher-<aligned_id>.jsonl` exists and contains the full trace.

---

## Phase 5 — Working-group sub-stages 5.4d–5.4f

### Task 5.1: `PERSONA_OBSERVATION` prompt + `runObservation` + cross-reading invariant

**Size:** Medium | **Priority:** High | **Dependencies:** 4.3 | **Parallel:** 5.2

In `src/agents/prompts.js`, add `PERSONA_OBSERVATION`: For each researcher report, produce 2–3 observations through your role lens. Each observation must cite at least one finding. Observations are not claims yet — they are what this evidence means *from your perspective*.

In `src/agents/persona.js`, add `runObservation({ client, idea, model, budget, territory, persona, report, allReports, personaLens }) -> { observations: [...] }`:
- Single forced tool call to `emit_observation` (array output: 2–3 entries per call).
- Tool schema matches `OBSERVATION_JSON_SCHEMA` from Task 1.2.
- Result entries: `{ observation_id, by_persona_id, report_id, content, cited_finding_ids: [...] }`.
- `observation_id` stamped by the orchestrator (`o_<territory_id>_<NNN>`).
- The prompt includes the full text of every non-dead-end researcher report in the pair (largest single context budget; Sonnet 4.6's 1M window absorbs it).
- Logged via `pair-<territory_id>-observation.jsonl`.

**Cross-reading invariant** (enforced in `working_group.js` after the nested `Promise.all`): for every `(persona_id, report_id)` tuple where the report has ≥1 finding, at least one observation must exist. If validation fails on a non-dead-end report:
- Retry once.
- On second failure, synthesize a fallback observation `{ content: "[synthesized: no observation produced]", cited_finding_ids: [<first_finding_id_of_that_report>] }` and log the synthesis.

Dead-end reports (`outcome: "dead_end"` with `findings: []`) are skipped — no observation call is made; the invariant excludes them.

**Acceptance:**
- Stub-client test: emits 2–3 observations per (persona, report) call.
- Dead-end reports are filtered out before observation calls.
- Cross-reading retry and fallback paths covered by stub-client tests.

### Task 5.2: `PERSONA_DEBATE` prompt + `runDebateMove` with strict citation

**Size:** Medium | **Priority:** High | **Dependencies:** 4.3 | **Parallel:** 5.1

In `src/agents/prompts.js`:
- Rewrite `PERSONA_BASE` → `PERSONA_DEBATE`. Used in 5.4f. The Claim/Support/Rebut/Question/Concede protocol is unchanged. **Every Claim must cite at least one observation AND at least one researcher finding** (strict — matches the validator in Task 1.2). You are debating over evidence you and your partner have both seen.
- Edit `PERSONA_OPENING_OVERLAY`: the "use web search sparingly" line is removed. The opening Claim must cite at least one observation AND at least one finding.
- Comment out `PERSONA_CALCIFIED_OVERLAY` (template stays in the file for future reinstatement if smoke runs show debates walking in circles).

In `src/agents/persona.js`, add `runDebateMove({ client, idea, model, budget, territory, persona, transcript, observations, findings }) -> { move: DebateMove }`:
- Single move per call (sequential, mirrors v4 `runPairDebate` move loop).
- `emit_move` tool schema requires `evidence_refs: array` on the move object.
- `moves.js` `validateDebateMove` enforces strict citation (Task 1.2):
  - On Claims in `stage: "debate"`: ≥1 observation_id AND ≥1 finding_id, all resolving in pair scope.
  - Reject otherwise; orchestrator re-prompts once. On second rejection, **drop the move** (don't synthesize — no honest citation fallback). The pair loses a turn but the invariant holds.
- `move_id` format: `m_<territory_id>_debate_<NNNN>`.
- Logged via `pair-<territory_id>-debate.jsonl`.

The prompt includes the full observation pool plus the full researcher findings index. Sonnet 4.6 (same model as everywhere else).

**Acceptance:**
- Stub-client test: Claim without `evidence_refs` is rejected and re-prompted.
- Stub-client test: Claim with both ref types resolving in scope is accepted.
- Stub-client test: second rejection drops the move (no synthesized fallback).

### Task 5.3: Stamp `finding_id` values + wire 5.4d researcher delegation into `working_group.js`

**Size:** Medium | **Priority:** High | **Dependencies:** 4.3 | **Parallel:** 5.1, 5.2

Extend `src/working_group.js` `runWorkingGroup` to add stages 5.4d–f after 5.4c:

**5.4d Researcher Delegation:**
- `Promise.all` over `aligned_questions`. Each invokes `runJointResearcher` from `src/agents/researcher.js` (which wraps `runJointResearcher` from `src/anthropic.js`).
- After each researcher returns, stamp `finding_id` values onto its findings: `f_<aligned_id>_<NN>` (NN starts at 01, increments per finding within the report). The `aligned_id` is already the parent.
- Persist `researcher_reports[]` to `investigation.json` after all researchers complete (`Promise.allSettled` semantics so one failure doesn't break the pair).
- Each researcher writes to its own `pair-<territory_id>-researcher-<aligned_id>.jsonl` log file.

`src/agents/researcher.js` exports a thin wrapper `runJointResearcher` that delegates to `src/anthropic.js`'s `runJointResearcher`, applying the prompt and tool-schema context for the aligned question. Keeps the agent-vs-API-wrapper split consistent with v4.

**Acceptance:**
- `pair_debates[].researcher_reports[]` is written with `findings[*].finding_id` stamped.
- IDs are stable and unique within a pair.
- One real run produces at least one `outcome: "useful"` or `"partial"` report.

### Task 5.4: Wire 5.4e observation + 5.4f debate into `working_group.js`; full working-group smoke test

**Size:** Large | **Priority:** High | **Dependencies:** 5.1, 5.2, 5.3 | **Parallel:** none

Extend `src/working_group.js`:

**5.4e Independent Observation:**
- Nested `Promise.all`: for each persona, for each researcher report **with non-empty `findings`**, call `runObservation`.
- Skip reports with `outcome: "dead_end"` and `findings: []`.
- Stamp `observation_id` values (`o_<territory_id>_<NNN>`).
- Apply the cross-reading invariant from Task 5.1 (retry once, then synthesize fallback).
- Persist `observations[]`.

**5.4f Pair Debate:**
- Sequential `runDebateMove` calls bounded by `PAIR_MOVE_BUDGET = 12`.
- Parallel opening Claims (both personas emit one opening Claim concurrently, mirroring v4).
- Mutual-concession termination: when both personas have emitted at least one `Concede` move in a row, end the debate.
- v4's calcification detector is **dropped by default**. With strict citations + `PAIR_MOVE_BUDGET = 12` + mutual concession, a persona cannot re-Claim parametric priors.
- Persist each move with `stage: "debate"`.
- Compute `surviving_claims[]` after termination (same logic as v4) and stamp `evidence_refs[]` from each surviving Claim's originating move.

Pair-abort logic (per §6.10): if any sub-stage fails per the spec's table (ideation_failure / alignment_failure / all_dead_end), mark `pair_debates[].terminated_by` and skip remaining sub-stages. Aligned questions produced before abort still get propagated to forum dead-ends (Task 6.2 handles forum-side).

**Smoke test:** one full working group end-to-end (5.4a → 5.4f) on a throwaway topic.

**Acceptance:**
- `pair_debates[]` entry has all six sub-stage artifacts: `candidate_questions[]`, `adversarial_marks[]`, `moves[]` (alignment + debate filtered by `stage`), `aligned_questions[]`, `researcher_reports[]`, `observations[]`, `surviving_claims[]`.
- At least one `surviving_claims[]` entry has both an `observation_id` and a `finding_id` in `evidence_refs[]`.
- All six per-pair log files exist and have content.

---

## Phase 6 — Cross-pollination and forum

### Task 6.1: Update `CROSS_POLLINATION` prompt + `runCrossPollinationReaction` for citation-aware reactions

**Size:** Small | **Priority:** Medium | **Dependencies:** 5.4 | **Parallel:** 6.2

In `src/agents/prompts.js`, edit `CROSS_POLLINATION`: reactors now see, in addition to the target pair's surviving claims, the target pair's `aligned_questions[]` (with provenance) and the citation graph (`finding_id → summary, source_url, source_quote` for every citation used in target claims). The richer context helps the reactor pick a claim worth reacting to and ground its reaction.

v5 does **not** introduce a "borrow this question framing" mechanic. The reactor still emits exactly one Rebut/Question/Concede reaction to one surviving claim. The `emit_reaction` JSON schema is unchanged in v5.

In `src/agents/persona.js`, edit `runCrossPollinationReaction` to assemble the citation graph and aligned-question list from the target pair before calling the model.

**Acceptance:**
- Reactions are still Rebut/Question/Concede only (verified by existing v4 tests).
- A smoke run shows reactor prompts include citation-graph context (manual log inspection).

### Task 6.2: Forum dead-end propagation (researcher dead-ends + pair-abort) + extend `test/forum.test.js`

**Size:** Medium | **Priority:** High | **Dependencies:** 5.4 | **Parallel:** 6.1

In `src/forum.js`, extend the aggregator:
- Read `pair_debates[].researcher_reports[]` for `outcome: "dead_end"` entries and append to `forum.dead_end_questions[]`. Each entry: `{ aligned_id, territory_id, originating_persona_id, outcome_summary: "Researcher returned outcome=dead_end after N tool calls; no usable findings." }`.
- Read `pair_debates[]` for `terminated_by` and append every `aligned_questions[]` entry produced before the abort to `forum.dead_end_questions[]` with `outcome_summary` reflecting the abort reason (e.g., `"Pair aborted: ideation_failure"`).
- Also: aligned questions whose researcher returned `outcome: "useful"|"partial"` but yielded no `surviving_claims[]` referencing any finding from that question's report ⇒ propagate as dead-end too (per §6.5 "aligned questions that yielded no surviving observations propagate as dead-ends").

Extend `test/forum.test.js` (per spec §8.1) with cases:
1. Researcher dead-end → entry in `forum.dead_end_questions[]`.
2. Pair-abort with `terminated_by: "ideation_failure"` → all aligned questions before abort propagate.
3. Useful report with no surviving claim referencing its findings → propagates.
4. Aggregate confidence math unchanged for `useful`/`partial` reports (regression).

Each test has a leading `// Test: …` comment.

**Acceptance:**
- All four cases pass.
- `forum.dead_end_questions[]` shape matches §6.3.

### Task 6.3: Smoke test — two working groups + cross-pollination + forum

**Size:** Small | **Priority:** Medium | **Dependencies:** 6.1, 6.2 | **Parallel:** none

Run two-territory smoke (4 personas + skeptic/builder, 2 pairs). Verify:
- Cross-pollination reactions reference observations / findings from the target pair (manual log inspection).
- Forum aggregates surviving claims into nodes and contradictions.
- `forum.dead_end_questions[]` is populated if any researcher returned dead-end.

**Acceptance:**
- A complete `investigation.json` with both pairs' artifacts, cross-pollination reactions, and forum aggregation, including at least one dead-end entry (force one if needed by selecting a topic with niche territory).

---

## Phase 7 — Synthesizer and review card

### Task 7.1: Rewrite `SYNTHESIZER` prompt + extend synthesis output schema

**Size:** Medium | **Priority:** High | **Dependencies:** 6.3 | **Parallel:** 7.3

In `src/agents/prompts.js`, rewrite `SYNTHESIZER`. Inputs widen: claim contents + resolved citations + question landscape + dead-end questions. Output gains:
- `question_landscape`: structured. Per territory, the aligned questions with provenance (origin tag, originating persona, source_candidate_ids).
- `dead_end_summary`: short prose summarizing what the pipeline tried and couldn't answer (~3 sentences).
- Existing `report`, `headline_findings`, `open_tensions` preserved.

Tone discipline ("opinionated where evidence warrants") preserved from v4.

In `src/agents/synthesizer.js`:
- Update the input assembly to feed structured input (claims + citation graph + question_landscape + dead_end_questions).
- Update the output JSON schema to require the new fields.

**Acceptance:**
- One smoke run produces a non-empty `report`, `question_landscape`, and `dead_end_summary`.
- The schema rejects a synthesis output missing either new field.

### Task 7.2: Wire `SYNTHESIZER_MODEL` (Haiku) with Sonnet fallback if prompt > ~150k

**Size:** Small | **Priority:** High | **Dependencies:** 7.1 | **Parallel:** none

The synthesizer call site reads `SYNTHESIZER_MODEL` (Haiku 4.5) by default. Haiku has a 200k context window; if real synthesis prompts approach ~150k tokens (measured on the Phase 7 smoke run via `count_tokens` API or local estimation), switch to `MODEL` (Sonnet 4.6) before merging.

Implementation: count input tokens before the call. If `tokenCount > 150_000`, fall back to `MODEL` and log a warning. The fallback path is preferred over silently truncating.

**Acceptance:**
- Smoke run completes with the synthesizer model recorded in `investigation.synthesizer_model`.
- If the fallback fires, the log records the reason and the substitute model.

### Task 7.3: Update `src/render.js` review card to v5 format

**Size:** Medium | **Priority:** Medium | **Dependencies:** 6.3 | **Parallel:** 7.1

New review card format (verbatim from spec §6.9):

```text
────────────────────────────────────
{captured_at}  ·  {raw_capture truncated to 72 chars}
{territory_count} territories · {question_count} questions · {observation_count} observations · {token_count} tokens
────────────────────────────────────

QUESTIONS ASKED
{one representative aligned question per territory}
  · [commercial]   What price floor would make this defensible against incumbents?
  · [cognitive]    Where does the user's mental model break when faced with X?
  ...
                                            [q] expand full list with provenance

HEADLINE FINDINGS
{headline_findings as bullets, max 5}

OPEN TENSIONS
{open_tensions as bullets, max 3}

DEAD ENDS
{count} questions researched but yielding no evidence  [e] expand

────────────────────────────────────
[r]ead full report  [q]uestions  [e]dead ends  [d]eeper (new topic)  [k]ill  [n]otes
>
```

**Acceptance:**
- `render.js` produces the card for a v5 idea with all sections populated.
- A v4 legacy idea still renders the v4 card (no regression).

### Task 7.4: `src/commands/review.js` handlers for `[q]` and `[e]` keystrokes

**Size:** Small | **Priority:** Medium | **Dependencies:** 7.3 | **Parallel:** none

Add handlers:
- `[q]` — page through `investigation.synthesis.question_landscape`, rendered as: per territory, the aligned questions with `origin` annotation (`(minority: persona_name)` or `(aligned)`). After paging, return to the main prompt.
- `[e]` — page through `forum.dead_end_questions`, rendered as: `[territory_name] question (originating persona: name) — outcome_summary`. After paging, return to the main prompt.

`[r]`, `[d]`, `[k]`, `[n]` semantics unchanged from v4.

**Acceptance:**
- `[q]` displays the question landscape and returns to the prompt.
- `[e]` displays dead-ends and returns to the prompt.
- All other keys behave as v4.

### Task 7.5: End-to-end smoke run on a throwaway topic; capture Phase 8 fixtures

**Size:** Small | **Priority:** High | **Dependencies:** 7.1, 7.2, 7.3, 7.4 | **Parallel:** none

Run the full v5 pipeline end-to-end on a throwaway idea. Verify the pass criteria from spec §8.2:
- All seven outer stages complete.
- Per pair, all six sub-stages emit recorded artifacts.
- At least one minority question survives in each working group.
- At least one Claim cites a researcher finding.
- The synthesizer emits a non-empty `report`, `question_landscape`, and `dead_end_summary`.

Capture the resulting idea directory as `test/fixtures/inspect/v5-ready/` for Phase 8. Also force two failure variants:
- Manually edit a fresh run's `status` to `investigating` mid-pipeline ⇒ snapshot as `v5-investigating/`.
- Inject a degraded discovery condition (e.g., very narrow topic that yields few candidate personas) ⇒ snapshot as `v5-degraded/`.

**Acceptance:**
- Three fixture directories populated.
- Spec §8.2 pass criteria all met.

---

## Phase 8 — Inspect surfaces (Node + React)

### Task 8.1: Extend `src/inspect/types.d.ts` with v5 types

**Size:** Medium | **Priority:** High | **Dependencies:** 7.5 | **Parallel:** 8.2

Add v5 types (keep all v4 types for legacy):
- `Territory: { id, name, description, assigned_pair: [string, string], rationale }`.
- `CandidateQuestion: { candidate_id, by_persona_id, question, predicted_answer, predicted_confidence: number, surface_area_rationale }`.
- `AdversarialMark: { candidate_id, marker_persona_id, could_answer_from_priors: boolean, predicted_answer?: string }`.
- `AlignedQuestion: { aligned_id, question, origin: "aligned" | string, source_candidate_ids: string[] }` (string for `minority_<persona_id>` form).
- `ResearcherReport: { report_id, aligned_id, outcome: "useful" | "partial" | "dead_end", findings: Finding[], search_trace: string[] }`.
- `Finding: { finding_id, summary, source_url, source_quote, confidence_in_source: number }`.
- `Observation: { observation_id, by_persona_id, report_id, content, cited_finding_ids: string[] }`.
- `EvidenceRef: { observation_id?: string, finding_id?: string }`.
- `DeadEndQuestion: { aligned_id, territory_id, originating_persona_id, outcome_summary }`.
- `QuestionLandscape: Record<territory_name, AlignedQuestion[]>`.

Extend `Move` to include `stage?: "alignment" | "debate"` and `evidence_refs?: EvidenceRef[]`.

**Acceptance:**
- TypeScript compile (`tsc --noEmit` or equivalent) on the inspect-app passes with the new types.

### Task 8.2: Update `src/inspect/loader/` for v5 log files + chunked-line format

**Size:** Medium | **Priority:** High | **Dependencies:** 7.5 | **Parallel:** 8.1

Update `loader/index.js`, `loader/readLogs.js`, `loader/readIndex.js`, `loader/enrichments/` to:
- Read the new per-pair log files: `pair-<territory_id>-{ideation,adversarial,alignment,researcher-<aligned_id>,observation,debate}.jsonl`.
- Read the renamed `coordinator.jsonl` (was `coordinator-initial.jsonl`).
- Handle the `log_chunk_start` split-line format from §6.11 (header line names the chunk_id and total_chunks; subsequent chunk lines reassemble the payload).
- Add a `discovery.jsonl` enrichment hook surfacing any new `kind` records from the interrogative-posture prompt change.

**Acceptance:**
- Loading `test/fixtures/inspect/v5-ready/` produces an enriched loader output containing all six per-pair sub-stage log streams.
- Legacy v4 fixtures still load unchanged.

### Task 8.3: Update `src/inspect/view/build.js` with schema dispatcher + v5 builder

**Size:** Large | **Priority:** High | **Dependencies:** 8.1, 8.2 | **Parallel:** 8.4

Top of `view/build.js`: schema-version dispatcher. `schema_version === "v5"` → new builder, otherwise → existing builder.

New builder:
- Replace `buildSubQuestionMap` with `buildTerritoryMap` (reads `coordinator_decisions.initial.territories[]`).
- Per pair, produce sub-stage sections: `ideation`, `adversarial`, `alignment`, `researcher`, `observation`, `debate`, each with its typed payload.
- Add `dead_end_questions[]` (from `forum.dead_end_questions[]`).
- Add `question_landscape{}` (from `synthesis.question_landscape`).
- Per claim: resolve `evidence_refs[]` — `observation_id` / `finding_id` references become hydrated `Observation` / `Finding` objects inline so the SPA can render quotes without re-walking the JSON.
- Budget builder reads `used_researcher_tool_calls` / `max_researcher_tool_calls`.
- Models map reads `investigation.model` + `investigation.synthesizer_model` (no `STAGE_MODELS` reference).

**Acceptance:**
- v5 fixture builds a view JSON containing all six sub-stage sections per pair, evidence_refs resolved, and the question landscape.
- v4 fixture still builds via the legacy path (no regression).

### Task 8.4: Update `src/inspect/view/derive/*.js` (4 files)

**Size:** Medium | **Priority:** Medium | **Dependencies:** 8.1 | **Parallel:** 8.3

- `confidenceTrajectory.js`: bucket moves by `stage` (alignment vs debate). v4 callers receive the flat shape; v5 callers receive `{ alignment: Move[], debate: Move[] }`.
- `contradictionEdges.js`: resolve contradictions across `evidence_refs` — two claims citing different findings about the same aligned question are first-class contradictions; surface the citing-finding pair on the edge.
- `personaInteractions.js`: add a `questions_originated_by_persona` counter (count of `candidate_questions` and `aligned_questions` where `by_persona_id == persona.id`, broken down by origin tag).
- `stageDurations.js`: add the six sub-stage labels to the duration breakdown; drop the `spawn` label.

**Acceptance:**
- All four derivers produce the expected v5 shapes against the Phase 7 fixture.
- v4 fixtures still produce the v4 shapes.

### Task 8.5: Add schema_version dispatcher to `src/inspect-app/App.tsx`; rename SubQuestionCard → TerritoryCard

**Size:** Medium | **Priority:** High | **Dependencies:** 8.3 | **Parallel:** 8.6, 8.7

In `App.tsx`, branch on `schema_version`: render the v4 component tree for legacy ideas; render the v5 component tree otherwise.

Rename `src/inspect-app/components/Coordinator/SubQuestionCard.tsx` → `TerritoryCard.tsx`. Rewire to `coordinator_decisions.initial.territories[]` with `name`, `description`, `assigned_pair`. Delete the spawn-decision rendering path.

Update `Timeline/Timeline.tsx`, `Timeline/StageChip.tsx`: drop the spawn-round chip. Add a nested chip group under "working groups" showing the six sub-stages per pair, color-coded by completion / abort state.

**Acceptance:**
- v5 fixture renders the TerritoryCard with 4–5 territories.
- v4 fixture still renders the SubQuestionCard equivalent (legacy path).
- Timeline shows the six sub-stages per pair.

### Task 8.6: Add `WorkingGroup/*` sub-stage panels; refactor `Debate/DebateSection.tsx` for v5

**Size:** Large | **Priority:** High | **Dependencies:** 8.3, 8.5 | **Parallel:** 8.7

Create new files under `src/inspect-app/components/WorkingGroup/`:
- `WorkingGroupSection.tsx` — orchestrates the six sub-stage panels (replaces v5 `DebateSection`).
- `IdeationPanel.tsx` — renders `candidate_questions[]` with predicted answers, confidence, surface_area_rationale.
- `AdversarialPanel.tsx` — renders `adversarial_marks[]` as a grid (rows = candidates, cols = adversarial verdict).
- `AlignmentPanel.tsx` — renders alignment moves filtered by `stage: "alignment"` plus the resulting `aligned_questions[]` with origin badges (minority entries get a distinct color from `theme/personas.ts`).
- `ResearcherPanel.tsx` — renders `researcher_reports[]` with findings, source URLs, outcome chip (`useful` / `partial` / `dead_end`).
- `ObservationPanel.tsx` — renders `observations[]` grouped by persona × report.

Refactor `Debate/DebateSection.tsx`: the v5 path filters moves by `stage: "debate"` and renders them via the existing `MoveCard` plus the citation-graph chips from Task 8.8.

**Acceptance:**
- v5 fixture renders all six sub-stage panels per pair.
- Minority-origin aligned questions visibly carry a distinct origin badge.
- v4 fixture renders the legacy DebateSection unchanged.

### Task 8.7: `MoveCard` evidence_refs strip + invariant violation indicator

**Size:** Medium | **Priority:** High | **Dependencies:** 8.3, 8.5 | **Parallel:** 8.6

Update `Debate/MoveCard.tsx` to render an evidence-refs strip below the move body:
- For each `observation_id`: hoverable chip showing the observation summary + persona attribution.
- For each `finding_id`: hoverable chip showing the finding summary + source URL + source quote.
- Use the resolved objects from `view/build.js` (Task 8.3) — no re-walking of JSON in the component.

**Invariant violation indicator**: a `Claim` in `stage: "debate"` missing either an observation ref or a finding ref renders with a red border + tooltip "missing required evidence_refs". This catches schema bugs visibly during smoke runs.

Also: `Debate/ConfidenceChart.tsx` — two-track chart: alignment-phase confidence (if recorded) and debate-phase confidence.

**Acceptance:**
- v5 fixture: every debate Claim renders with both chips visible.
- Synthetic test fixture (force a claim with missing refs) renders the red border.
- ConfidenceChart shows two tracks on v5 fixture.

### Task 8.8: `Forum/DeadEndsPanel.tsx` + NodeDrawer citation graph + MoveTree/PersonaMatrix updates

**Size:** Medium | **Priority:** Medium | **Dependencies:** 8.3, 8.5 | **Parallel:** 8.9

- New `Forum/DeadEndsPanel.tsx`: renders `forum.dead_end_questions[]` as `[territory_name] question (originating persona: name) — outcome_summary`.
- Update `Forum/NodeDrawer.tsx`: surface the citation graph (finding summaries + source URLs) for the selected claim.
- Update `Forum/MoveTree.tsx`: add a sub-stage axis (alignment vs debate).
- Update `Forum/PersonaMatrix.tsx`: add a "questions originated" column from the new derivation (Task 8.4 `personaInteractions.js`).

**Acceptance:**
- v5 fixture: Dead Ends panel shows entries for any dead-end question.
- NodeDrawer shows citation context for a selected claim.

### Task 8.9: `Synthesis/QuestionLandscape.tsx` + dead_end_summary rendering

**Size:** Small | **Priority:** Medium | **Dependencies:** 8.3, 8.5 | **Parallel:** 8.8

- New `Synthesis/QuestionLandscape.tsx`: renders `synthesis.question_landscape` as per-territory question lists with origin badges.
- Update `Synthesis/Synthesis.tsx`: include the QuestionLandscape and the `dead_end_summary` prose block alongside the existing `report` rendering.

**Acceptance:**
- v5 fixture: synthesis view shows three sections (report, question landscape, dead-end summary).

### Task 8.10: `Header/BudgetBar.tsx` researcher counter + `Header.tsx` model fields

**Size:** Small | **Priority:** Low | **Dependencies:** 8.3, 8.5 | **Parallel:** 8.8, 8.9

- `Header/BudgetBar.tsx`: add the `used_researcher_tool_calls / max_researcher_tool_calls` counter alongside existing executor-calls and token counters.
- `Header/Header.tsx`: read `investigation.model` + `investigation.synthesizer_model` (rather than the single v4 `model` string).
- `Header/StatusPill.tsx`: unchanged in behavior; verify it still renders correctly against the v5 schema.

**Acceptance:**
- v5 fixture: BudgetBar shows three counters; Header lists both models.

### Task 8.11: Visual verification of v5 fixtures + format.ts helpers

**Size:** Small | **Priority:** Medium | **Dependencies:** 8.5–8.10 | **Parallel:** none

Extend `src/inspect-app/utils/format.ts` with helpers for resolving `evidence_refs` and formatting `origin` badges (e.g., `formatOriginBadge(origin: string, personas: Persona[]): { label, color }`).

Eyeball-verify each of the three v5 fixtures (`v5-ready`, `v5-investigating`, `v5-degraded`) renders without console errors. Use the dev server (`npm run inspect-app:dev` or equivalent) and a browser.

**Acceptance:**
- All three v5 fixtures render without console errors.
- The v4 fixtures (existing ones) still render unchanged.

---

## Phase 9 — README + prototype.md follow-up

### Task 9.1: Update README with v5 cost / latency / review keys

**Size:** Small | **Priority:** Medium | **Dependencies:** 7.5 | **Parallel:** 9.2

Update `README.md`:
- New cost expectations: ~200–250k tokens, ~$5–10, 3–10 min wall time per run (vs v4's 70–100k / $1–3 / 1–3 min).
- New review keys: `[q]` (question landscape), `[e]` (dead ends).
- "First run" section documenting the smoke run procedure from Task 7.5.

**Acceptance:**
- README mentions the new cost target.
- README mentions `[q]` and `[e]`.

### Task 9.2: Open follow-up issue/spec to rewrite `specs/prototype.md` for v5

**Size:** Small | **Priority:** Low | **Dependencies:** 8.11 | **Parallel:** 9.1

Open a GitHub issue (or a `specs/feat-prototype-v5-rewrite.md` follow-up) tracking the rewrite of `specs/prototype.md` to absorb the v5 implementation's actual shape (final prompts, exact tool call counts, observed costs). This is **out of scope** for this spec per §11; track and merge separately.

**Acceptance:**
- Issue or follow-up spec exists.

---

## Summary

| Phase | Tasks | Critical Path |
|---|---|---|
| 0 — SDK + queue | 3 | yes |
| 1 — Scaffolding + schema | 5 | yes |
| 2 — Discovery + coordinator | 3 | yes |
| 3 — 5.4a/b/c | 6 | yes |
| 4 — Joint Researcher | 3 | yes |
| 5 — 5.4d/e/f | 4 | yes |
| 6 — Cross-pollination + forum | 3 | yes |
| 7 — Synthesizer + review | 5 | yes |
| 8 — Inspect (Node + React) | 11 | partially parallel |
| 9 — Docs | 2 | tail |
| **Total** | **45** | |

**Parallelism opportunities:**
- Phase 1: Tasks 1.1 / 1.2 / 1.3 / 1.4 in parallel.
- Phase 3: Tasks 3.1 / 3.2 in parallel; 3.3 sequential after both.
- Phase 4: Tasks 4.1 / 4.2 partially parallel (4.2 needs the tool-schema constant from 4.1).
- Phase 5: Tasks 5.1 / 5.2 / 5.3 mostly in parallel; 5.4 sequential.
- Phase 8: Most React component tasks can run in parallel after 8.3 / 8.5.

**Risk hot spots:**
- Phase 0 SDK bump — if the v4 regression breaks, fix before moving on.
- Phase 3 minority-protection algorithm — load-bearing, fully unit-tested before any real run.
- Phase 4 force-emit trigger — stub-test both paths.
- Phase 5 strict citation validation — must reject invalid Claims without silently synthesizing fallbacks.
- Phase 7 synthesizer prompt size — measure and fall back to Sonnet if needed.

---

*Tasks created in STM via `/spec:decompose`. Run `stm list --pretty` to see them.*
