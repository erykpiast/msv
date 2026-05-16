# Rebuild msv as a Question-Generation Machine (v5)

**Status:** Draft
**Author:** Eryk Napierała
**Date:** 2026-05-16
**Companion docs:** `specs/vision.md` (the *why*), `specs/architecture.md` (the *what*). This spec is the *how*.

---

## 1. Overview

Rebuild the existing msv prototype (current code matches `specs/prototype.md` v4) to match the v5 target architecture described in `specs/architecture.md`. The pipeline is restructured around question generation: the Coordinator emits broad territories instead of focused sub-questions, working groups internally run a six-sub-stage flow (Independent Ideation → Adversarial Pre-check → Alignment Debate → Researcher Delegation → Independent Observation → Pair Debate), and a new **Joint Researcher** sub-agent does the heavy retrieval work that v4 left to optional in-debate web search.

This is a structural rewrite, not a feature addition. The schema changes substantially. The model selection becomes stage-dependent. The review card surfaces a new artifact (the question landscape). v5 is a clean break — existing v4 investigations on disk remain readable but cannot be migrated or resumed.

---

## 2. Background

The v4 prototype is debate-centric. Pair debates open with Claims drawn from parametric knowledge and treat web search as a discretionary fact-checking tool (`maxUses: 2` per turn, prompts discourage use). Discovery is the only stage with mandatory search.

Two observations from real runs:

1. **Debates are close-minded.** Personas defend their priors. The "disagreement" is real but produces weaker insight than expected.
2. **The questions personas raised on the way to defending their priors were more interesting than the conclusions.** They pointed at angles the user would not have investigated alone.

Independent verification of the v4 reference materials (DMAD, DAR, DynaDebate, STORM, Co-STORM) shows the architecture inherited the wrong half of its lineage: the debate machinery from closed-book benchmarks (DMAD et al. assume parametric reasoning, no retrieval) without the per-turn retrieval discipline that makes STORM and Co-STORM work. v5 corrects this by treating retrieval as a first-class pipeline stage rather than a tool agents may incidentally invoke.

The reframing is fully developed in `specs/vision.md`. The hypothesis being tested becomes sharper: *a structured multi-agent system, with persona-anchored interrogative ideation and minority-protected alignment, produces a research question set that a thoughtful human would describe as "I wouldn't have thought to ask half of these" — and the answers to those questions leave them meaningfully further along than a single-agent synthesis would.*

---

## 3. Goals

- Replace the v4 working-group stage with the six-sub-stage flow defined in `architecture.md` §Working Groups.
- Introduce a Joint Researcher sub-agent (`src/agents/researcher.js`) that uses `web_search_20250305` **plus** real page fetches (`web_fetch_20250910` or an equivalent fetcher) to produce structured, citable findings per aligned question.
- Reframe Discovery's persona prompts toward interrogative posture ("what does this tradition find puzzling?") instead of advocacy posture.
- Move the Coordinator from "decompose into focused sub-questions" to "decompose into broad territories."
- Enforce *no Claim without citation* via the existing `moves.js` validator path.
- Implement mechanical minority protection (≥1 surviving question per persona per pair) as a deterministic orchestrator step.
- Surface the question landscape and dead-end questions in the review card.
- Run all interpretive stages on Sonnet 4.6 (1M context window is the default — no special variant) and the final synthesizer on Haiku 4.5 to cut the most-prompt-engineered call's per-token cost.
- Preserve v4's data-discipline invariants: append-only logs, atomic `index.json`, no resumability, single in-process pipeline.

---

## 4. Non-Goals

- **Cross-idea retrieval / pool sharing.** Each pair's evidence pool stays scoped to its territory. No global pool across pairs or across runs.
- **Migration of v4 investigations.** Existing ideas in `~/.msv/ideas/` continue to load and render via v4 code paths if `investigation.schema_version` is unset, but they cannot be re-run under v5. New investigations get `schema_version: "v5"`.
- **Resumability.** Same as v4 — re-run from scratch via manual `status` edit.
- **RL-trained confidence calibration.** Still out of scope. Verbalized confidence with mandatory `evidence_basis` plus the new `predicted_answer`/`surface_area_rationale` fields remain the entire calibration surface.
- **A TUI library.** `readline` + `console.log` remain the UI primitive.
- **Tests beyond invariant coverage and one smoke run.** Same posture as v4.
- **A v6 or productization plan.** This spec is for the prototype; if the hypothesis is falsified, the prototype is the deliverable.

---

## 5. Technical Dependencies

Runtime dependencies (in `package.json`):

- `@anthropic-ai/sdk` — **must be bumped** from the pinned `0.54.0` to a version that exposes the server-side `web_fetch_20250910` tool. As of the spec date, the latest published version is `0.96.0`; pin to whatever the latest stable is at implementation time. v0.54.0 does **not** expose `web_fetch`, so the bump is non-optional, not a fallback. The bump is the first thing Phase 0 does (§12); a v4 regression smoke run against the new SDK must pass before any v5 code is written. v5 uses:
  - Server-side `web_search_20250305` tool (or the newer `web_search_20260209` if the new SDK only ships the latter; both are GA per Anthropic's tool reference).
  - Server-side `web_fetch_20250910` tool (free per call beyond standard token costs).
  - Multi-turn forced tool-use (already used by `emit_move` / `emit_reaction` paths).
- `uuid` `11.1.1` — unchanged.
- Node `>=20` — unchanged.

**New runtime module — request queue / rate-limit manager.** Anthropic Tier-2 rate limits will throttle the v5 peak load (up to ~20 concurrent researcher invocations plus six sub-stages running across 4 pairs). A small `src/api_queue.js` module wraps every `client.messages.create` call: bounded concurrency, queue-on-429 with `Retry-After` honoring (fall back to exponential backoff with jitter when the header is absent), and per-error-class retry policy (retry 429 / 503 / network; surface 4xx). Evaluate `bottleneck` or `p-queue` for the concurrency primitive before writing one from scratch; both are zero-config-friendly and small. The module is the single entry point — every agent call goes through it.

**Inspect surfaces (no dep changes, but in scope).** `src/inspect/` (Node loader + view builder) and `src/inspect-app/` (React viewer) must track the v5 schema in lockstep — see §6.12. The `vite`, `@xyflow/react`, etc. dev-deps stay at their current versions.

External services: Anthropic API (Sonnet 4.6 for all interpretive stages, Haiku 4.5 for synthesis).

---

## 6. Detailed Design

### 6.1 Pipeline structure

The seven-stage outer pipeline is preserved. The internal shape of stage 4 (Working Groups) is what changes. The adaptive coordinator-spawn loop (v4 §3b) is removed — the working-group internal flow absorbs question generation, so the coordinator becomes single-shot.

See `architecture.md` for the updated mermaid diagrams. Briefly:

```
discovery → selection → coordinator (territories) → working-groups (six sub-stages per pair)
  → cross-pollination → forum (preserves dead-ends) → synthesizer (small model)
```

The orchestrator (`src/commands/run.js`) drops the spawn round (delete `runCoordinatorSpawn` import and the if-block at lines 174–200 of current `run.js`) and adds a per-territory dispatch into a new `runWorkingGroup` helper that lives in `src/working_group.js`.

### 6.2 New and changed source files

| Path | Change | Notes |
|---|---|---|
| `src/working_group.js` | **NEW** | Orchestrates the six sub-stages per pair. Returns the full pair_debate artifact. Equivalent role to current `runPairDebate` but with much more internal structure. |
| `src/agents/researcher.js` | **NEW** | Joint Researcher sub-agent. Owns its own loop: broad search → targeted deep dives → gap-fill. Uses WebSearch + WebFetch. Returns a structured `researcher_report`. |
| `src/agents/persona.js` | **REWRITE** | Split current `runPairDebate` into four exported functions: `runIdeation`, `runAdversarialMark`, `runAlignmentMove`, `runObservation`, `runDebateMove`. Keep `runCrossPollinationReaction` (it gets a small update — see §6.7). |
| `src/agents/discovery.js` | **EDIT (prompt)** | The runner shape is unchanged; the system prompt becomes interrogative (see §6.6). |
| `src/agents/coordinator.js` | **EDIT** | `runCoordinatorInitial` now emits `territories` (4–5) rather than `sub_questions`. `runCoordinatorSpawn` is **deleted**. |
| `src/agents/synthesizer.js` | **EDIT** | Input shape widens to include question landscape + dead-end questions. Output gains `question_landscape` and `dead_end_summary` fields. Model selection switches to the smaller-model entry in the stage→model map. |
| `src/agents/prompts.js` | **HEAVY EDIT** | New prompts: `PERSPECTIVE_DISCOVERY` (rewritten), `COORDINATOR_TERRITORIES` (replaces `COORDINATOR_INITIAL`), `PERSONA_IDEATION`, `PERSONA_ADVERSARIAL`, `ALIGNMENT_DEBATE`, `PERSONA_OBSERVATION`, `PERSONA_DEBATE` (formerly `PERSONA_BASE`), `RESEARCHER`, `SYNTHESIZER` (rewritten). Removed: `COORDINATOR_INITIAL`, `COORDINATOR_SPAWN`. |
| `src/moves.js` | **EDIT** | Add `ALIGNMENT_MOVE_TYPES`, `ALIGNMENT_JSON_SCHEMA`, `IDEATION_JSON_SCHEMA`, `OBSERVATION_JSON_SCHEMA`, `ADVERSARIAL_MARK_JSON_SCHEMA`, `RESEARCHER_REPORT_JSON_SCHEMA`. Extend `MOVE_JSON_SCHEMA` to include optional `evidence_refs` and add a `validateDebateMove` helper that requires `evidence_refs` on Claims. Keep all existing validators. |
| `src/forum.js` | **EDIT** | Aggregator now reads `evidence_refs` and produces `forum.dead_end_questions[]` from researcher reports with `outcome: dead_end` (also: aligned questions that yielded no surviving observations propagate as dead-ends). |
| `src/render.js` | **EDIT** | New review card format with `QUESTIONS ASKED` and `DEAD ENDS` sections. New menu actions `[q]` and `[e]` (see §6.9). |
| `src/commands/run.js` | **EDIT** | Replace pair-debate orchestration with working-group orchestration. Drop spawn-round handling. Update progress lines for the six-sub-stage shape. |
| `src/commands/review.js` | **EDIT** | Add handlers for `[q]` and `[e]` keypresses. |
| `src/storage.js` | **EDIT** | `freshInvestigation()` returns the v5 shape (see §6.3). Loader sets `schema_version: "v4"` on legacy ideas that lack the field. |
| `src/anthropic.js` | **EDIT** | Replace the single `DEFAULT_MODEL` with `MODEL` + `SYNTHESIZER_MODEL` (see §6.8). Add a `runJointResearcher` wrapper that exposes WebSearch + WebFetch and runs a multi-step ReAct loop until the researcher emits a final `researcher_report` tool call. All calls route through the new `src/api_queue.js`. |
| `src/api_queue.js` | **NEW** | Concurrency-bounded request queue with 429 backoff (`Retry-After` aware), retries, and per-error-class policy. Single entry point for every `messages.create` call. |
| `src/diversity.js` | **NO CHANGE** | Selection algorithm and reactor permutation are unchanged. |
| `src/inspect/**` | **HEAVY EDIT** | Node loader + view-builder layer. The view JSON shape changes substantially. See §6.12. |
| `src/commands/inspect.js` | **EDIT** | Serves the v5 view shape. See §6.12. |
| `src/inspect-app/**` | **HEAVY EDIT** | React viewer tracks the v5 schema (territories, alignment phase, evidence_refs, dead-ends, question landscape). See §6.12. |

### 6.3 Schema changes

The full v5 schema lives in `prototype.md` after that document is also revised (see §10 Documentation). This section enumerates the diffs.

**Top-level addition** to the idea object:

```json
"investigation": {
  "schema_version": "v5",
  ...
}
```

**Removed from `investigation`:** the `coordinator_decisions.spawn` field. v5 coordinator runs once.

**Renamed inside `investigation`:** `coordinator_decisions.initial.sub_questions` → `coordinator_decisions.initial.territories`. Each entry's `question` field becomes `territory` and gains a `name` (short kebab-case label like `commercial`, `cognitive`, `regulatory`).

**Each `pair_debates[]` entry gains:**

```json
{
  "territory_id": "t_001",
  "candidate_questions": [
    {
      "candidate_id": "cq_001",
      "by_persona_id": "p_002",
      "question": "...",
      "predicted_answer": "...",
      "predicted_confidence": 6,
      "surface_area_rationale": "..."
    }
  ],
  "adversarial_marks": [
    {
      "candidate_id": "cq_001",
      "marker_persona_id": "skeptic",
      "could_answer_from_priors": true,
      "predicted_answer": "..."
    }
  ],
  "aligned_questions": [
    {
      "aligned_id": "aq_001",
      "question": "...",
      "origin": "minority_p_002 | aligned",
      "source_candidate_ids": ["cq_003"]
    }
  ],
  "researcher_reports": [
    {
      "report_id": "rr_001",
      "aligned_id": "aq_001",
      "outcome": "useful | partial | dead_end",
      "findings": [
        {
          "finding_id": "f_001_01",
          "summary": "...",
          "source_url": "...",
          "source_quote": "...",
          "confidence_in_source": 7
        }
      ],
      "search_trace": ["query 1", "query 2", "..."]
    }
  ],
  "observations": [
    {
      "observation_id": "o_001",
      "by_persona_id": "p_002",
      "report_id": "rr_001",
      "content": "...",
      "cited_finding_ids": ["f_001_01"]
    }
  ]
}
```

The v4 `pair_debates[].sub_question_id` field is **removed**. v5 pair_debates entries key on `territory_id` only. v4 ideas continue to load (legacy code path) so the field remains in legacy JSON, but `freshInvestigation()` does not emit it for new investigations.

**Each `pair_debates[].moves[]` entry gains:**

- `stage`: `"alignment" | "debate"` — distinguishes 5.4c alignment moves from 5.4f debate moves.
- `evidence_refs`: array of `{ "observation_id": "..." }` and `{ "finding_id": "..." }` objects. **Required on every Claim emitted in `stage: "debate"`: at least one `observation_id` AND at least one `finding_id`.** The prompt and validator agree on the strict form. Exception: if the pair's researcher reports all returned `outcome: "dead_end"` with `findings: []`, the pair's working group is already aborted (see §6.10) and no debate Claims are emitted; the strict rule therefore never triggers without a valid finding pool. Support/Rebut/Question/Concede may include `evidence_refs` optionally; if present, every reference must resolve to an actual observation or finding in the pair's scope.

**`move_id` namespace** widens. Current: `m_<sub_question_id>_<NNNN>`. New:
- `m_<territory_id>_alignment_<NNNN>` for alignment moves
- `m_<territory_id>_debate_<NNNN>` for debate moves

**`pair_debates[].surviving_claims[]` entries gain `evidence_refs[]`** copied from the originating Claim move.

**`forum` gains:**

```json
"forum": {
  ...
  "dead_end_questions": [
    {
      "aligned_id": "aq_001",
      "territory_id": "t_001",
      "originating_persona_id": "p_002",
      "outcome_summary": "Researcher returned outcome=dead_end after 7 tool calls; no usable findings."
    }
  ]
}
```

**`investigation.synthesis` gains** `question_landscape` (structured: per territory, the aligned questions with provenance) and `dead_end_summary` (short prose).

**Budget defaults** in `investigation.budget`:

| Field | v4 | v5 |
|---|---|---|
| `max_executor_calls` | 60 | 180 |
| `max_total_tokens` | 500_000 | 1_500_000 |
| `max_researcher_tool_calls` (new) | — | 60 |

The orchestrator tracks `used_researcher_tool_calls` separately so a runaway researcher cannot exhaust the executor-call counter that's also used to gate budget elsewhere.

### 6.4 Working-group orchestration (`src/working_group.js`)

The function `runWorkingGroup({ client, idea, model, synthesizerModel, budget, territory, personas })` runs the six sub-stages for one territory. The pair is the territory's `assigned_pair`. `model` is Sonnet 4.6 for every sub-stage in this function; `synthesizerModel` is plumbed through only so it's available if a future per-stage override is needed (synthesizer itself does not run inside the working group).

Sequence:

1. **5.4a Independent Ideation.** `Promise.all` over the two personas, each calling `runIdeation` from `persona.js`. Each invocation produces 4–6 candidate questions with `predicted_answer`, `predicted_confidence`, `surface_area_rationale`. Tool: `emit_candidate_question` (forced, with array output). Persist `candidate_questions[]`.

2. **5.4b Adversarial Pre-check.** `Promise.all` over the two personas. Each persona sees the *other's* candidate questions and emits one `adversarial_mark` per question via the `emit_adversarial_mark` tool. Persist `adversarial_marks[]`.

3. **5.4c Alignment Debate.** Sequential, like a v4 debate but with the restricted move set `Propose · Sharpen · Merge · Drop · Defer`. Bounded by `ALIGNMENT_MOVE_BUDGET = 8` total moves. The pair sees: candidate questions, adversarial marks. Moves persisted with `stage: "alignment"`.

   After the debate concludes, the orchestrator runs a **deterministic post-step** to produce up to `MAX_ALIGNED_QUESTIONS = 5` aligned questions. The rule:

   1. Build the **alignment-surviving pool**: every candidate question that was Proposed and not Dropped/Deferred, with Sharpen and Merge edits applied. Each entry carries its `by_persona_id`.
   2. Rank the alignment-surviving pool by `predicted_confidence` descending. Tie-break by adversarial-mark count where the *other* persona said `could_answer_from_priors: false` (more such marks = better, because the question genuinely surfaces an unknown). Final tie-break by `candidate_id` ascending.
   3. **Take the top 3 jointly-rated entries** from this ranked pool. Tag each with `origin: "aligned"`.
   4. For **each pair member separately**, take that persona's highest-ranked alignment-surviving candidate that is **not already in the chosen 3**. Tag with `origin: "minority_<persona_id>"`. If the persona had no surviving candidates at all, skip — no minority slot is forced for that persona.
   5. Deduplicate by `candidate_id` (a candidate already promoted by step 3 cannot also be a minority pick — the minority slot moves to the next-best candidate from that persona).
   6. Cap the final list at 5. Because the algorithm produces at most 3 + 2 = 5 entries after dedup, the cap is structural; it rejects nothing in practice.

   **Worked example.** Personas A and B. A's alignment-surviving candidates ranked: a1(conf=8), a2(conf=6), a3(conf=4). B's ranked: b1(conf=7), b2(conf=5). Joint ranking by confidence: a1, b1, a2, b2, a3. Step 3 picks {a1, b1, a2}. Step 4 picks A's best not-already-picked → a3, and B's best not-already-picked → b2. Final aligned set: {a1, b1, a2, a3, b2}, origins `aligned, aligned, aligned, minority_A, minority_B`.

   Counter-example: if B's only surviving candidate is b1 and step 3 picks {a1, b1, a2}, step 4 picks a3 for A (next-best for A) and **skips** B (no remaining B candidate). Final: 4 questions — no slot is fabricated.

4. **5.4d Researcher Delegation.** `Promise.all` over `aligned_questions`. Each call invokes `runJointResearcher({ client, idea, budget, aligned_question, territory_context, persona_lenses })` (`src/agents/researcher.js`). Each researcher writes its own log file `logs/pair-<territory_id>-researcher-<aligned_id>.jsonl`. Persist `researcher_reports[]` after all complete (or after `Promise.allSettled`-style partial — see §6.10 failure handling).

5. **5.4e Independent Observation.** Nested `Promise.all`: for each persona, for each researcher report **with non-empty `findings`**, one call to `runObservation`. Reports with `outcome: "dead_end"` and `findings: []` are skipped — there is nothing for a persona to observe. Each call produces 2–3 `observation` entries via the `emit_observation` tool. The prompt includes the full text of every non-dead-end researcher report in the pair (this is the largest single context budget in the pipeline; Sonnet 4.6's 1M window absorbs it at standard pricing).

   The orchestrator validates the cross-reading invariant before transitioning to 5.4f: for every `(persona_id, report_id)` tuple **where the report has ≥1 finding**, at least one observation must exist. Dead-end reports do not need observations. If validation fails on a non-dead-end report (e.g., a persona's observation call returned empty), retry once; on second failure synthesize a fallback observation `{ content: "[synthesized: no observation produced]", cited_finding_ids: [<first_finding_id_of_that_report>] }` and log the synthesis. This is intentionally weak — the prototype's job is to get to debate.

6. **5.4f Pair Debate.** Sequential moves with parallel opening Claims and mutual-concession termination, `PAIR_MOVE_BUDGET = 12`. Differences from v4 `runPairDebate`:
   - The system prompt is `PERSONA_DEBATE` instead of the old `PERSONA_BASE`. It instructs the persona to draw on its observations and to cite **both an observation and a researcher finding on every Claim** (strict).
   - The `emit_move` tool schema requires `evidence_refs: array` on the move object. `moves.js` validates that Claims emitted in `stage: "debate"` carry ≥1 `observation_id` AND ≥1 `finding_id`, and that every reference resolves to an actual observation/finding in the pair's scope.
   - v4's calcification detector is **dropped by default** in v5. With the strict citation requirement plus `PAIR_MOVE_BUDGET = 12` plus mutual-concession termination, a persona cannot re-Claim parametric priors. If a smoke run shows debates still walking in circles, reinstate the calcification overlay; track as a smoke-run follow-up rather than ship-blocking work.
   - Sonnet 4.6 (same model as every other interpretive stage). The prompt includes the full observation pool plus the full researcher findings index. This is the second-largest context call in the pipeline.

Output of `runWorkingGroup` is the complete `pair_debates[]` entry. (The v4-spec `surface_area_log[]` post-step is **cut from v5**: it was record-only with no downstream consumer, so the fixed-cost LLM-grading call per aligned question is not worth its weight. If a future review wants to compare predicted answers to research outcomes, reconstruct it from `candidate_questions[].predicted_answer` and `researcher_reports[].findings` — both stay in the schema.)

### 6.5 Joint Researcher (`src/agents/researcher.js`)

The Joint Researcher is a multi-step ReAct-style agent that runs a bounded loop:

```
1. Plan: broad-search prompt — generate 1–2 search queries from the aligned question.
2. Execute: call web_search; capture results.
3. Read: from search results, pick 2–4 URLs worth fetching. Call web_fetch on each.
4. Reflect: did this answer the question? If yes, emit final report. If no, identify gap.
5. Gap-fill: 1–2 more targeted searches or fetches.
6. Emit: final researcher_report via forced tool emit_researcher_report.
```

The implementation is a single Anthropic message loop named `runJointResearcher` (exported from `src/anthropic.js`; called from `src/agents/researcher.js`) with `tools: [webSearchTool({ maxUses: 4 }), webFetchTool({ maxUses: 6 }), EMIT_RESEARCHER_REPORT_TOOL]`. The loop is bounded by `RESEARCHER_TOOL_BUDGET = 10` total tool calls (search + fetch combined) and `RESEARCHER_TURN_BUDGET = 6` model turns. The force-emit trigger:

- For turns 1 through `RESEARCHER_TURN_BUDGET - 1`, `tool_choice` is `auto` and `emit_researcher_report` is available alongside web_search/web_fetch — the model may voluntarily emit at any point.
- When *either* `used_tool_calls >= RESEARCHER_TOOL_BUDGET` *or* `turn_index == RESEARCHER_TURN_BUDGET - 1` (final turn), the next request switches `tool_choice` to `{ type: "tool", name: "emit_researcher_report" }` and appends a user message: `"Tool budget exhausted; emit your researcher_report now via emit_researcher_report based on what you have."` The model has no other valid action.

The system prompt (`RESEARCHER` in `prompts.js`) emphasises:
- Source quality hierarchy (lifted from claudekit's research-expert, adapted for general web research): primary sources > academic > professional > news > general web.
- Red flags: content farms, undated content, sources without citations.
- Output must include `outcome: "useful" | "partial" | "dead_end"` honestly.
- Each finding's `confidence_in_source` reflects source quality, not finding plausibility.

The `emit_researcher_report` tool's JSON schema:

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

`finding_id` values are assigned by the orchestrator post-hoc as `f_<aligned_id>_<NN>` so they're stable for citation.

### 6.6 Prompt rewrites

Full prompts are written during implementation; this spec enumerates scope.

| Prompt | Status | Notes |
|---|---|---|
| `PERSPECTIVE_DISCOVERY` | **rewritten** | Shift from "what does this tradition believe?" to "what does this tradition find puzzling, surprising, or under-investigated?" Reframe each candidate persona as a curious investigator first, advocate second. |
| `COORDINATOR_TERRITORIES` | **new** (replaces `COORDINATOR_INITIAL`) | Decompose into 4–5 broad territories. Each territory has `name` (short kebab-case) and `description` (1–2 sentences). Pair personas to maximize productive tension. Justify each territory briefly. |
| `COORDINATOR_SPAWN` | **deleted** | No spawn round in v5. |
| `PERSONA_IDEATION` | **new** | Used in 5.4a. Generate 4–6 candidate questions for the territory. For each: predict your prior-only answer, rate prediction confidence, articulate why the question is worth asking. Stay interrogative — you are asking questions, not advocating. |
| `PERSONA_ADVERSARIAL` | **new** | Used in 5.4b. For each of the other persona's candidate questions, mark whether you could confidently answer it from priors alone. If yes, briefly say what your answer would be. Honesty is the point — if you don't know, say so. |
| `ALIGNMENT_DEBATE` | **new** | Used in 5.4c. Restricted move set (Propose, Sharpen, Merge, Drop, Defer). Goal: settle on up to 5 aligned questions. The minority-protection rule will be enforced deterministically afterward; you do not need to argue for it. |
| `PERSONA_OBSERVATION` | **new** | Used in 5.4e. For each researcher report, produce 2–3 observations through your role lens. Each observation must cite at least one finding. Observations are not claims yet — they are what this evidence means *from your perspective*. |
| `PERSONA_DEBATE` | **rewritten** (formerly `PERSONA_BASE`) | Used in 5.4f. The Claim/Support/Rebut/Question/Concede protocol unchanged. Every Claim must cite at least one observation AND at least one researcher finding (strict — matches the validator in §6.4 step 6). You are debating over evidence you and your partner have both seen. |
| `PERSONA_OPENING_OVERLAY` | **edited** | The "use web search sparingly" line is **removed** — there is no in-debate search in v5. The opening Claim must cite at least one observation AND at least one finding. |
| `PERSONA_CALCIFIED_OVERLAY` | **dropped (default)** | v5 ships without the calcification mechanism — see §6.4 step 6. The prompt template stays in the file (commented out) so it can be reinstated by a future smoke-run-driven decision without re-deriving the language. |
| `RESEARCHER` | **new** | See §6.5. |
| `CROSS_POLLINATION` | **edited** | Reactors now see aligned questions, claims, and the citation graph (finding summaries + URLs). v5 does **not** introduce a "borrow this question framing" mechanic — the reactor still emits exactly one Rebut/Question/Concede reaction to one surviving claim; the citation graph just gives them more context for picking which claim to react to. |
| `SYNTHESIZER` | **rewritten** | Inputs widened: claim contents + resolved citations + question landscape + dead-end questions. Output gains `question_landscape` (structured) and `dead_end_summary` (prose). Tone discipline ("opinionated where evidence warrants") preserved. |

### 6.7 Cross-pollination

Mechanics unchanged: each pair reacts to exactly one other pair via the deterministic permutation in `selectReactorPermutation`. One change:

- The reactor sees, in addition to the target pair's surviving claims: the target pair's `aligned_questions` (with provenance) and the citation graph (`finding_id → summary, source_url, source_quote` for every citation used in target claims). The richer context helps the reactor pick a claim worth reacting to and ground its reaction.

The constraint that reactions are Rebut/Question/Concede only (no new Claims) is unchanged. The `emit_reaction` JSON schema is unchanged in v5.

### 6.8 Model selection

Sonnet 4.6 includes a 1M-token context window at standard pricing — no `-1m` variant, no beta header, no separate per-token rate. Every interpretive stage in v5 (discovery, coordinator, ideation, adversarial, alignment, researcher, observation, debate, cross-pollination, contradiction-finding) runs on Sonnet 4.6. Only the synthesizer runs on Haiku 4.5 to amortize the per-token cost of the heaviest single prompt-engineered call.

`src/anthropic.js` exports two constants:

```js
const MODEL = 'claude-sonnet-4-6';
const SYNTHESIZER_MODEL = 'claude-haiku-4-5-20251001';
```

`DEFAULT_MODEL` (the v4 name) is renamed to `MODEL`. Every agent except the synthesizer reads `MODEL`; the synthesizer reads `SYNTHESIZER_MODEL`. `investigation.model` stays a single string (`MODEL` at run time) and a new `investigation.synthesizer_model` string records the synthesis-stage override. The v4 `investigation.model` field continues to populate for legacy reads.

**Synthesizer context budget caveat.** Haiku 4.5 has a 200k context window. The synthesizer's input — surviving claims + resolved citations + question landscape + dead-end summaries across all pairs — is structured and bounded but can plausibly approach 200k on a 4-pair × 5-aligned-question × 5-finding run with long source quotes. Phase 7 must measure the actual prompt size against a representative smoke run; if it exceeds ~150k (leaving room for output), either (a) summarize per-pair before feeding the synthesizer, or (b) route the synthesizer to `MODEL` (Sonnet 4.6) and accept the cost delta. The fallback path is preferred over silently truncating.

### 6.9 Review card (`src/render.js`, `src/commands/review.js`)

The card format updates to surface the question landscape:

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

New keystrokes:

- `[q]` — page through `investigation.synthesis.question_landscape`, rendered as: per territory, the aligned questions with `origin` annotation (`(minority: persona_name)` or `(aligned)`). After paging, return to the main prompt.
- `[e]` — page through `forum.dead_end_questions`, rendered as: `[territory_name] question (originating persona: name) — outcome_summary`. After paging, return to the main prompt.

`[r]`, `[d]`, `[k]`, `[n]` unchanged in semantics.

### 6.10 Failure handling

Failure modes per stage and the recovery path:

| Stage | Failure mode | Handling |
|---|---|---|
| 5.4a Ideation | One persona's call fails or returns empty | Retry once; on second failure, abort the working group with `terminated_by: "ideation_failure"`. The pair contributes nothing to cross-pollination or forum. |
| 5.4b Adversarial | One persona's call fails | Retry once; on second failure, treat all the other persona's candidates as **unmarked**. Continue to 5.4c. The minority-protection mechanic still works (tie-breaks fall back to candidate_id ordering). |
| 5.4c Alignment | Move budget exhausts before a coherent aligned set emerges | Apply the minority-protection rule to whatever Propose/Sharpen moves are on the table. If fewer than 2 candidates survive across both personas, abort the working group with `terminated_by: "alignment_failure"`. |
| 5.4d Researcher | A researcher returns `outcome: dead_end` | Expected — record as dead-end. Observations and debate proceed using the remaining `useful`/`partial` reports. If *all* researchers return dead_end, abort the working group with `terminated_by: "all_dead_end"`. |
| 5.4d Researcher | A researcher call throws (API error, parse error) | Retry once; on second failure, record a synthetic researcher report with `outcome: "dead_end"` and `findings: []` plus a log entry, and continue. Don't abort the pair. |
| 5.4e Observation | A persona's observation call fails on a report with ≥1 finding | Retry once; on second failure, synthesize a placeholder observation per `(persona, report)` tuple with `cited_finding_ids: [<first_finding_id_of_that_report>]`. |
| 5.4e Observation | Dead-end report (`findings: []`) | No observation call is made. The cross-reading invariant excludes dead-end reports. |
| 5.4f Debate | Parse errors / invalid moves | Identical to v4 — re-prompt, then synthesize on second rejection. |
| 5.4f Debate | Claim emitted without valid `evidence_refs` (must carry ≥1 observation_id AND ≥1 finding_id, all resolving) | `moves.js` rejects; re-prompt once. On second rejection, **drop the move** (do not synthesize — there's no honest fallback for a citation). The pair loses a turn but the invariant holds. |
| Cross-pollination | Reaction call fails | Identical to v4 — synthesize a fallback Question (the safest no-op move). |
| Working group | Pair aborts mid-flow (`terminated_by: "ideation_failure" \| "alignment_failure" \| "all_dead_end"`) | All `aligned_questions[]` produced before the abort are added to `forum.dead_end_questions[]` with `outcome_summary` reflecting the abort reason. The pair contributes nothing else to cross-pollination, forum claims, or synthesis. |
| Forum, Synthesizer | Any failure | Identical to v4 — investigation stays in `investigating` status, partial state on disk, manual recovery via re-run. |

Across the pipeline, the rule is: a single pair's failure does not abort the run (use `Promise.allSettled` across territories, as v4 already does). A single researcher's failure does not abort the pair. Stage-internal failures retry once before synthesizing or dropping.

429s and transient API errors are not in this table — they're absorbed by the `src/api_queue.js` layer (§5) before they ever surface to the stage logic.

### 6.11 Logging

New log files per pair (under `~/.msv/ideas/<id>/logs/`):

- `pair-<territory_id>-ideation.jsonl`
- `pair-<territory_id>-adversarial.jsonl`
- `pair-<territory_id>-alignment.jsonl`
- `pair-<territory_id>-researcher-<aligned_id>.jsonl` (one per researcher invocation)
- `pair-<territory_id>-observation.jsonl`
- `pair-<territory_id>-debate.jsonl`

Existing log files preserved: `discovery.jsonl`, `coordinator.jsonl` (renamed from `coordinator-initial.jsonl` since there's only one invocation now), `cross-pollination.jsonl`, `forum-contradictions.jsonl`, `synthesizer.jsonl`, `parse-errors.jsonl`.

Each line remains `{"ts": "ISO", "kind": "request|response|tool_use|tool_result|rejected_move|synthesized_move|web_search|web_fetch|...", "payload": {...}}`.

**Append-only concurrent writes.** Within a sub-stage like 5.4a Ideation, two persona calls run in parallel and both append to `pair-<territory_id>-ideation.jsonl`. The logger uses Node's `fs.promises.appendFile` with the implicit `O_APPEND` flag plus a single line per `await` — POSIX guarantees `O_APPEND` writes of less than `PIPE_BUF` (4096 bytes on Linux/macOS) are atomic against concurrent appenders. Log lines that exceed `PIPE_BUF` (rare; oversized `payload` objects) are split into a `{"ts": "...", "kind": "log_chunk_start", "chunk_id": "...", "total_chunks": N}` header followed by chunked payload lines, each well under 4096 bytes — the inspect loader stitches them on read. This pattern is already used by v4 for the discovery log; v5 reuses the helper.

### 6.12 Inspect surfaces (Node loader + React viewer)

The inspect feature is a two-layer system that must track the v5 schema in lockstep with the pipeline:

- **`src/inspect/` (Node).** `loader/` reads `investigation.json` and the per-stage log files; `view/build.js` transforms loader input into the view JSON consumed by the SPA; `view/derive/` computes derivations (confidence trajectory, contradiction edges, persona interactions, stage durations); `types.d.ts` defines shared types; `server.js` serves the bundle; `openBrowser.js` opens it.
- **`src/inspect-app/` (React).** Component tree under `App.tsx`, consuming the view JSON.

Both layers version-gate on `investigation.schema_version`. Legacy v4 ideas keep routing through the existing components and view-builder paths. v5 ideas route through new/updated paths. The dispatcher lives in `src/inspect/view/build.js` (which branches on `schema_version` to pick a view-builder variant) and in `src/inspect-app/App.tsx` (which selects the per-section components from a `{ v4, v5 }` map).

#### 6.12.1 `src/inspect/` (Node) — changes

| File / area | Change |
|---|---|
| `types.d.ts` | Extend with v5 types: `Territory`, `CandidateQuestion`, `AdversarialMark`, `AlignedQuestion` (with `origin: "aligned" \| "minority_<persona_id>"`), `ResearcherReport`, `Finding`, `Observation`, `EvidenceRef`, `DeadEndQuestion`, `QuestionLandscape`. Move `Move` to add `stage` and `evidence_refs` fields. Keep all v4 types for legacy. |
| `loader/index.js`, `loader/readLogs.js`, `loader/readIndex.js`, `loader/enrichments/` | Read the new per-pair log files (`pair-<territory_id>-{ideation,adversarial,alignment,researcher-<aligned_id>,observation,debate}.jsonl`) and the renamed `coordinator.jsonl`. Add a `discovery.jsonl` enrichment hook for the interrogative-posture metadata (no schema change, but the prompt change may surface different `kind` records worth indexing). The loader handles the `log_chunk_start` split-line format described in §6.11. |
| `view/build.js` | Schema-version dispatcher at top: legacy → existing builder, v5 → new builder. New builder replaces `buildSubQuestionMap` with `buildTerritoryMap`; produces per-pair sub-stage sections (`ideation`, `adversarial`, `alignment`, `researcher`, `observation`, `debate`) each with their typed payload; adds `dead_end_questions[]`, `question_landscape{}`, and per-claim `evidence_refs` resolution (resolving `observation_id` / `finding_id` references into hydrated `Observation` / `Finding` objects so the SPA can render quotes without re-walking the JSON). Budget builder reads `used_researcher_tool_calls` / `max_researcher_tool_calls`. Models map reads `investigation.model` + `investigation.synthesizer_model` (no `STAGE_MODELS` reference — that map never exists at runtime). |
| `view/derive/confidenceTrajectory.js` | Bucket moves by `stage` (alignment vs debate). v4 callers continue to receive the flat shape; v5 callers receive `{ alignment: Move[], debate: Move[] }`. |
| `view/derive/contradictionEdges.js` | Resolve contradictions across `evidence_refs` — two claims citing different findings about the same aligned question are first-class contradictions; surface the citing-finding pair on the edge. |
| `view/derive/personaInteractions.js` | Add a `questions_originated_by_persona` counter (count of `candidate_questions` and `aligned_questions` where `by_persona_id == persona.id`, broken down by origin tag). |
| `view/derive/stageDurations.js` | Add the six sub-stage labels (`ideation`, `adversarial`, `alignment`, `researcher`, `observation`, `debate`) to the duration breakdown; drop the `spawn` label. |
| `server.js`, `openBrowser.js`, `inspect.js` | No structural changes. `inspect.js` may need to expose new query-string params for jumping into a specific territory / aligned question, but that's a polish item not blocking ship. |

#### 6.12.2 `src/inspect-app/` (React) — changes

| Component | v5 change |
|---|---|
| `App.tsx` | Reads `schema_version`; renders v4 tree for legacy ideas, v5 tree otherwise. |
| `Timeline/Timeline.tsx`, `Timeline/StageChip.tsx` | Drops the spawn-round chip. Adds a nested chip group under "working groups" showing the six sub-stages per pair, color-coded by completion / abort state. |
| `Header/Header.tsx`, `Header/BudgetBar.tsx`, `Header/StatusPill.tsx` | Reads `investigation.model` + `investigation.synthesizer_model`. Budget bar adds the `used_researcher_tool_calls / max_researcher_tool_calls` counter. |
| `Discovery/*` | Labels and copy reframe around interrogative posture; structure unchanged. |
| `Coordinator/SubQuestionCard.tsx` → **rename to `TerritoryCard.tsx`** | Reads `coordinator_decisions.initial.territories[]` with `name`, `description`, `assigned_pair`. The spawn-decision rendering path is deleted. |
| `Debate/DebateSection.tsx` → refactor into v5 `WorkingGroupSection.tsx` | Splits into nested sub-stage panels: **5.4a Ideation** (`candidate_questions[]` with predicted answers and confidence), **5.4b Adversarial** (`adversarial_marks[]` as a grid), **5.4c Alignment** (alignment moves filtered by `stage: "alignment"`, plus the resulting `aligned_questions[]` with `origin` badges for minority entries), **5.4d Researcher** (`researcher_reports[]` with findings, source URLs, and outcome chip), **5.4e Observation** (`observations[]` grouped by persona × report), **5.4f Debate** (existing `MoveCard` rendering but filtered by `stage: "debate"` and surfacing `evidence_refs` as inline chips that link to the cited observation / finding). |
| `Debate/MoveCard.tsx` | Adds an evidence-refs strip that renders hoverable chips with source quotes for each cited observation and finding. A Claim missing required refs → red invariant-violation indicator. |
| `Debate/ConfidenceChart.tsx` | Two-track chart: alignment-phase confidence (if recorded) and debate-phase confidence. |
| `Forum/Forum.tsx`, `Forum/ForumGraph.tsx`, `Forum/ForumNode.tsx`, `Forum/NodeDrawer.tsx` | Adds a "Dead Ends" panel reading `forum.dead_end_questions[]`. Node drawer surfaces the citation graph (finding summaries + source URLs) for the selected claim. |
| `Forum/MoveTree.tsx`, `Forum/PersonaMatrix.tsx` | Move tree gains a sub-stage axis (alignment vs debate). Persona matrix gains a "questions originated" column from the new derivation. |
| `Synthesis/Synthesis.tsx`, `Synthesis/Markdown.tsx` | Adds rendering of `synthesis.question_landscape` (per-territory question list with origin badges) and `synthesis.dead_end_summary` (prose block). |
| `hooks/usePersonaName.ts`, `utils/format.ts`, `theme/personas.ts`, `primitives/*` | Mostly unchanged; extend `format.ts` with helpers for resolving `evidence_refs` and formatting `origin` badges. |

New component files anticipated:

- `src/inspect-app/components/WorkingGroup/WorkingGroupSection.tsx`
- `src/inspect-app/components/WorkingGroup/{IdeationPanel,AdversarialPanel,AlignmentPanel,ResearcherPanel,ObservationPanel}.tsx`
- `src/inspect-app/components/Forum/DeadEndsPanel.tsx`
- `src/inspect-app/components/Synthesis/QuestionLandscape.tsx`
- `src/inspect-app/components/Coordinator/TerritoryCard.tsx` (renamed from `SubQuestionCard.tsx`)

#### 6.12.3 Invariants surfaced visually

- Every `Claim` move card visually surfaces its `evidence_refs`. A claim missing either an observation or finding ref is rendered with a red border so smoke runs visibly flag schema bugs.
- Minority-origin aligned questions render with a distinct origin badge (color from the originating persona's theme entry) — the minority-protection rule is load-bearing and must be inspectable at a glance.
- Dead-end questions are never hidden — they appear in both the per-pair Researcher panel (as outcome chips) and the global Forum DeadEnds panel.
- Pair aborts (`terminated_by: "..."`) render the working-group section with a banner stating the abort reason, and the territory's aligned questions appear in the Dead Ends panel.

#### 6.12.4 Testing

The inspect-app has no automated test suite in v4 and gains none in v5. Verification is via fixtures under `test/fixtures/inspect/`. Add `v5-ready/`, `v5-investigating/`, and `v5-degraded/` fixtures (built from the v5 smoke run output in Phase 7) and confirm each renders without console errors before merging Phase 8.

---

## 7. User Experience

### 7.1 The capture-and-run flow

Unchanged. `msv add` captures stdin to a `pending` idea directory. `msv run --all` processes all pending. `msv run <id>` runs one.

### 7.2 Progress output

`run.js` prints stage progress. The progress lines change to reflect the new shape:

```
→ <id> [1/7] perspective discovery (interrogative posture)…
→      surveyed 4 sources, generated 11 candidate personas
→ <id> [2/7] diversity selection…
→      selected 5 personas (+ skeptic, builder)
→ <id> [3/7] coordinator decomposing into territories…
→      4 territories: commercial, cognitive, regulatory, adoption
→ <id> [4/7] working groups (4 parallel pairs · six sub-stages each)…
→      [commercial] 5.4a ideation: 5+4 candidate questions
→      [commercial] 5.4b adversarial: 7 marks
→      [commercial] 5.4c alignment: 6 moves, 5 aligned questions (1 minority each)
→      [commercial] 5.4d research: 5 reports (4 useful, 1 dead-end)
→      [commercial] 5.4e observation: 18 observations
→      [commercial] 5.4f debate: 9 moves, 3 surviving claims (mutual concede)
→      [cognitive] ...
→ <id> [5/7] cross-pollination round…
→      12 reactions collected
→ <id> [6/7] forum aggregation…
→      18 nodes, 4 contradictions surfaced, 3 dead-end questions preserved
→ <id> [7/7] synthesis (haiku)…
✓ <id> ready  (used 142/180 executor calls, 1.1M/1.5M tokens, $7.40 estimated)
```

The cost estimate is computed from `usage` totals × per-model rates (in `anthropic.js`).

### 7.3 The review flow

Card format and keystrokes are described in §6.9.

---

## 8. Testing Strategy

Same testing posture as v4 — invariant coverage for the deterministic core, no broad assertion of LLM behavior. New tests required:

### 8.1 Unit tests in `test/`

| Test file | Purpose | What it validates |
|---|---|---|
| `test/working_group.test.js` (new) | The minority-protection rule produces the expected aligned set across edge cases | Inputs: synthetic candidate_questions + adversarial_marks + alignment-debate output. Expects: ≥1 aligned question per persona's origin; total ≤ 5; tie-break ordering deterministic. |
| `test/moves.test.js` (extend existing) | `validateDebateMove` enforces `evidence_refs` on Claims | Inputs: synthetic Claim moves with and without `evidence_refs`. Expects: rejection on missing refs; rejection on refs that don't resolve in the pair scope; acceptance on valid refs. |
| `test/forum.test.js` (extend existing) | Dead-end propagation works | Inputs: synthetic researcher reports with mixed outcomes. Expects: `forum.dead_end_questions[]` contains the right entries; aggregate confidence math unchanged for `useful`/`partial`. |
| `test/researcher.test.js` (new) | Researcher tool budget is respected; final emission is forced | Use a stub Anthropic client. Validate the loop terminates within `RESEARCHER_TOOL_BUDGET` and emits a `researcher_report` shape. |
| `test/storage.test.js` (extend existing) | v5 `freshInvestigation` returns the new shape; legacy load sets `schema_version: "v4"` | |

Each test has a leading purpose comment (`// Test: …`) explaining what it asserts and why the assertion matters. Avoid trivial tests that pass regardless of behavior.

### 8.2 Smoke run

One end-to-end run against the real Anthropic API on a throwaway idea, executed manually. Pass criteria:

- All seven outer stages complete.
- Per pair, all six sub-stages emit recorded artifacts.
- At least one minority question survives in each working group.
- At least one Claim cites a researcher finding.
- The synthesizer emits a non-empty `report`, `question_landscape`, and `dead_end_summary`.

The smoke run is documented in the README's "first run" section after implementation.

### 8.3 What's not tested

- Prompt quality. Iteration is manual on real runs (per the v4 posture).
- LLM-decided behavior (which questions get aligned, what the researcher decides to search). Deterministic invariants are tested; LLM judgments are not.
- Sonnet 4.6's behavior at the upper end of its 1M-token context window. The smoke run uses a moderate-sized topic; window stress is left to actual use.

---

## 9. Performance Considerations

The architectural commitment is to spend more tokens and wall time in exchange for question depth and citation quality. The cost target is **~200–250k tokens, ~$5–10, 3–10 min wall time per run** (compared to v4's 70–100k / $1–3 / 1–3 min). This is documented in vision.md and accepted.

Specific levers:

- **Per-pair researcher parallelism** is the largest single contributor to wall-time savings. All aligned questions within a pair run their researchers concurrently; all pairs run concurrently. With 4 pairs × 5 aligned questions each, that's 20 concurrent researcher invocations at peak, plus the six sub-stages firing across 4 pairs simultaneously. Anthropic Tier-2 rate limits will throttle this; the `src/api_queue.js` module (§5) wraps every call with bounded concurrency, `Retry-After`-aware backoff, and per-error-class retry — so 429s are absorbed at the queue boundary rather than surfacing into the stage logic.
- **Observation and debate are the heaviest per-call stages, not because of a different model tier, but because their prompts include the full researcher-report pool plus observation pool.** Sonnet 4.6's 1M context is the default at standard pricing ($3 / input MTok, $15 / output MTok) — there is no premium tier for long context, so the cost differential vs other stages is pure token volume. Constraining output (observations: 2–3 per report; debate: 1 move per turn) keeps the input-heavy / output-light asymmetry favorable.
- **Synthesizer on Haiku** reduces the per-token cost of the most-prompt-engineered call by an order of magnitude ($1 / input MTok vs Sonnet's $3). The trade-off is Haiku's 200k context window — see §6.8 for the fallback path to Sonnet if real synthesis prompts exceed ~150k tokens.
- **Web fetch is free per call** beyond standard token costs (verified against Anthropic's pricing page). **Web search costs $10 / 1,000 searches**: at `maxUses: 4` per researcher × ~5 aligned questions × 4 pairs ≈ 80 searches/run ≈ $0.80/run from web search alone. Negligible against the token budget.
- **Budget tracking** is unchanged in mechanism (`investigation.budget` counters, checked between stages). New counter: `used_researcher_tool_calls`. If a researcher exceeds its per-question budget, it's force-emitted as described in §6.5.

The cost estimate printed at the end of a run (§7.2) helps the user notice runaway costs in real time. End-to-end correctness verification is left to the post-implementation smoke run — Phase 0 plus per-phase smoke runs catch most breakage early.

---

## 10. Security Considerations

Same posture as v4 — local prototype, single user, no auth surface.

- **API key.** Continue to read from `ANTHROPIC_API_KEY`, never log it.
- **Idea ID path traversal.** Existing guard in `storage.js` against `..` and `/` characters in idea IDs is preserved.
- **`MSV_ROOT` override** for tests is preserved.
- **Tool-use input is trusted under the forced-tool invariant.** The new tools (`emit_candidate_question`, `emit_adversarial_mark`, `emit_alignment_move`, `emit_observation`, `emit_researcher_report`) follow the same pattern: validated by JSON schema, optionally re-prompted on failure.
- **WebFetch** is new in v5. URLs fetched by the researcher are not user-controlled but they *are* model-controlled. The model could in principle be persuaded by a malicious search result to fetch a sensitive internal URL — but the SDK's web_fetch is a server-side tool and fetches happen on Anthropic's infrastructure, not locally, so the local trust boundary is unchanged. **Sanity check during implementation:** confirm the SDK's web_fetch tool runs server-side and that no local Node fetch is involved.

No new secrets, no new auth, no new local services.

---

## 11. Documentation

- **`specs/vision.md`** — already updated as part of the brainstorm prep commit. No further changes.
- **`specs/architecture.md`** — already updated as part of the brainstorm prep commit. No further changes.
- **`specs/prototype.md`** — needs a full rewrite to match v5 after this spec is implemented. The rewrite is **out of scope** for this spec; it follows implementation and absorbs the implementation's actual shape (prompts, exact tool call counts, etc.). Track as a follow-up.
- **`README.md`** — needs a small update describing the new cost / latency expectations and the new `[q]`/`[e]` keys.
- **In-code comments** — the orchestrator (`working_group.js`) needs comments explaining the minority-protection enforcement (the deterministic step after the alignment debate is the load-bearing rule — surprise factor for a future reader).
- **Inspect-app fixtures** — `test/fixtures/inspect/` gains v5 variants (`v5-ready`, `v5-investigating`, `v5-degraded`) sourced from the Phase 7 smoke run. See §6.12.
- **No new top-level docs.** This spec is the spec.

---

## 12. Implementation Phases

A single coherent rebuild rather than incremental migration. v5 is a clean break and the prototype's whole point is to validate the new architecture end-to-end, not to ship partial improvements.

### Phase 0 — SDK bump + request queue

1. Bump `@anthropic-ai/sdk` from `0.54.0` to the latest stable that exposes `web_fetch_20250910` (≥ ~0.96.0 as of 2026-05).
2. Build `src/api_queue.js` (concurrency-bounded queue, `Retry-After`-aware 429 backoff, error-class-keyed retries). Evaluate `bottleneck` / `p-queue` first; only hand-roll if neither fits.
3. Route every existing v4 `messages.create` call through `src/api_queue.js`.
4. Run the v4 smoke run end-to-end against the new SDK to catch any breaking changes in `messages.create` shape, tool-result blocks, or forced-tool semantics. Fix regressions until v4 passes.
5. Document the SDK version and queue parameters (concurrency, max retries, backoff) in a short comment block at the top of `src/api_queue.js`.

### Phase 1 — Scaffolding and schema

1. Add `schema_version`, `MODEL` / `SYNTHESIZER_MODEL` constants, updated `freshInvestigation()` in storage.
2. Add the new tool schemas and validators in `moves.js`.
3. Add empty `src/working_group.js` and `src/agents/researcher.js` modules (real implementations come in later phases — no need for stub functions that throw).
4. Rewire `run.js` to call the new orchestrator surface.

### Phase 2 — Discovery and coordinator updates

1. Rewrite `PERSPECTIVE_DISCOVERY` and `COORDINATOR_TERRITORIES` prompts.
2. Update `discovery.js` and `coordinator.js` to match.
3. Delete `runCoordinatorSpawn`.
4. Smoke-test the first three stages on a throwaway topic.

### Phase 3 — Working-group sub-stages 5.4a–5.4c

1. Implement `runIdeation`, `runAdversarialMark`, `runAlignmentMove` in `persona.js`.
2. Implement the deterministic alignment post-step in `working_group.js` (top-3-joint + 1-each minority dedup; see §6.4 step 3).
3. Unit-test the alignment post-step across synthetic inputs.
4. Smoke-test: one pair, one territory, stages 5.4a–5.4c.

### Phase 4 — Joint Researcher

1. Implement `researcher.js` and `runJointResearcher` in `anthropic.js`.
2. Wire web_fetch + web_search tools.
3. Test the budget-bounded loop with a stub client (force-emit trigger, partial budget exhaustion).
4. Smoke-test: one aligned question through the researcher.

### Phase 5 — Working-group sub-stages 5.4d–5.4f

1. Implement `runObservation` and `runDebateMove` in `persona.js`.
2. Wire `evidence_refs` strict validation (≥1 observation_id AND ≥1 finding_id on debate Claims) into `moves.js`.
3. Smoke-test: one full working group (5.4a → 5.4f).

### Phase 6 — Cross-pollination and forum

1. Update `CROSS_POLLINATION` prompt and `runCrossPollinationReaction` for citation-aware reactions (no schema change to `emit_reaction`).
2. Update `forum.js` for dead-end propagation (both researcher-level dead-ends and pair-abort propagation).
3. Smoke-test: two working groups + cross-pollination + forum.

### Phase 7 — Synthesizer and review card

1. Rewrite `SYNTHESIZER` prompt; update synthesizer to read structured input only.
2. Wire Haiku model selection. **Measure the actual prompt size** — if it approaches 150k tokens on a representative smoke run, switch synthesizer to Sonnet 4.6 (see §6.8) before merging.
3. Update `render.js` and `review.js` for the new card and `[q]`/`[e]` keys.
4. End-to-end smoke run on a throwaway topic. Capture the resulting investigation as the seed for Phase 8 fixtures.

### Phase 8 — Inspect surfaces

1. Update `src/inspect/types.d.ts` with v5 types.
2. Update `src/inspect/view/build.js` (schema-version dispatcher, territory map, sub-stage sections, evidence_refs resolution, dead-end aggregation).
3. Update `src/inspect/view/derive/{confidenceTrajectory,contradictionEdges,personaInteractions,stageDurations}.js`.
4. Update `src/inspect/loader/` to read the new per-pair log files and the chunked-line format.
5. Add `schema_version` dispatcher to `src/inspect-app/App.tsx`.
6. Rename `Coordinator/SubQuestionCard.tsx` → `TerritoryCard.tsx`; rewire to `territories[]`.
7. Add `WorkingGroup/*` sub-stage panels and refactor `Debate/DebateSection.tsx` into the v5 working-group section.
8. Add `evidence_refs` resolution to `MoveCard` (with invariant-violation styling).
9. Add `Forum/DeadEndsPanel.tsx`; surface the citation graph in `NodeDrawer`.
10. Add `Synthesis/QuestionLandscape.tsx` and render `dead_end_summary`.
11. Update `Header/BudgetBar.tsx` for the researcher tool-call counter; update `Header.tsx` for `investigation.model` + `investigation.synthesizer_model`.
12. Capture v5 fixtures into `test/fixtures/inspect/` from the Phase 7 smoke run; eyeball-verify each renders without console errors.

### Phase 9 — README + prototype.md follow-up

1. Update README with new cost expectations and review keys.
2. Open a follow-up issue/spec to rewrite prototype.md to match the implementation.

No time estimates per the spec template's guidance.

---

## 13. Open Questions

Resolved during spec validation (kept here as a paper trail; the conclusions are inlined in the relevant sections):

- ~~**WebFetch tool availability in pinned SDK.**~~ Resolved: `@anthropic-ai/sdk@0.54.0` does not expose `web_fetch`. The SDK bump is non-optional and is Phase 0 (§12). `web_fetch_20250910` is available on the API per Anthropic's tool reference; latest SDK is ≥ 0.96.0 as of 2026-05.
- ~~**1M-context model identifier.**~~ Resolved: Sonnet 4.6's 1M context is the default at standard pricing — no `-1m` suffix, no beta header. `MODEL = 'claude-sonnet-4-6'` is the only Sonnet ID v5 uses (§6.8).
- ~~**`gap_score` for `surface_area_log`.**~~ Resolved by cutting `surface_area_log` from v5 (§6.4 output paragraph).
- ~~**Cross-pollination "question borrowing".**~~ Resolved by cutting `borrows_aligned_id` from v5 (§6.6, §6.7).

Open:

1. **Synthesizer prompt size on a real run.** Haiku 4.5 has a 200k context window; the synthesizer's structured input across 4 pairs × 5 aligned questions × ~5 findings can plausibly approach that ceiling. Phase 7 measures the actual prompt size and either keeps Haiku or falls back to Sonnet 4.6 (§6.8).
2. **Researcher report context budget into observation.** A researcher_report with many large findings is fed in full into the observation stage. Phase 5 smoke must confirm real reports don't pathologically inflate the observation prompt past comfortable working memory (well below the 1M ceiling but still costly per token).
3. **Cross-pollination context depth.** §6.7 says reactors see "the citation graph (finding summaries + URLs)." If smoke runs show reactors making thin reactions because they lack source quotes, expand to include source quotes. Tune after first runs.
4. **Should the calcification overlay come back?** §6.4 step 6 ships v5 without it on the bet that strict citations + bounded moves + mutual concession make it unnecessary. If smoke runs show debates still walking in circles, reinstate the overlay.

---

## 14. References

- `specs/vision.md` — the why.
- `specs/architecture.md` — the what.
- `specs/prototype.md` — v4 (the from-state). Will be rewritten to v5 after implementation as a follow-up.
- STORM (Shao et al. 2024) — https://arxiv.org/pdf/2402.14207 — source of the perspective-driven retrieval discipline; v5 finally honors the per-turn retrieval pattern STORM uses.
- Co-STORM (Jiang et al. 2024) — source of the dynamic mind-map idea (simplified to v4's flat forum, preserved in v5).
- DMAD (Zhu et al. 2026) — https://arxiv.org/abs/2601.19921 — source of the verbalized-confidence-with-evidence pattern; closed-book benchmark assumption explicitly corrected in v5 by routing retrieval through the Joint Researcher.
- claudekit's research-expert agent (`~/.claude/agents/research-expert.md`) — *inspiration* for the Joint Researcher's broad → targeted → gap-fill loop; not a code dependency. The Joint Researcher is implemented from scratch with a forced final tool call (claudekit's research-expert writes to a file and returns a summary; msv needs structured citable JSON instead).
- LangChain Open Deep Research (https://github.com/langchain-ai/open_deep_research) — corroborating evidence for the "parallelize search aggressively, serialize synthesis" pattern v5 adopts.

---

*Definition of done: ten real ideas processed end-to-end with the new pipeline; the user reports "I wouldn't have thought to ask half of these" on at least half of them. Negative result (the question sets are pedestrian, or the answers are thin even when the questions are good) is a valid outcome — the prototype's job is to find out.*
