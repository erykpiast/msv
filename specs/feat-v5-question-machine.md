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
- Introduce stage-aware model selection: 1M-context Sonnet for the high-context pair sub-stages (5.4e observation, 5.4f debate), a smaller model (Haiku) for the synthesizer, standard Sonnet everywhere else.
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

- `@anthropic-ai/sdk` `0.54.0` — already pinned. v5 needs:
  - Server-side `web_search_20250305` tool — already used by Discovery.
  - Server-side `web_fetch_20250910` tool (or whichever fetch tool the SDK exposes at the version pinned). The Joint Researcher must read pages, not just snippets. If the pinned SDK does not yet expose a fetch tool, bump the dep version to the lowest one that does and document the bump in the implementation PR.
  - Multi-turn forced tool-use (already used by `emit_move` / `emit_reaction` paths).
- `uuid` `11.1.1` — unchanged.
- Node `>=20` — unchanged.

Dev / inspect-app dependencies in `package.json` (`vite`, `@xyflow/react`, etc.) belong to the parallel research-process-visualisation track and are untouched by this spec.

No new runtime dependencies.

External services: Anthropic API (Sonnet + 1M-context Sonnet + Haiku tier).

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
| `src/anthropic.js` | **EDIT** | Add the `STAGE_MODELS` map (see §6.8). Add `runResearcherCall` wrapper that exposes WebSearch + WebFetch and runs a multi-step ReAct loop until the researcher emits a final `researcher_report` tool call. |
| `src/diversity.js` | **NO CHANGE** | Selection algorithm and reactor permutation are unchanged. |

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
  ],
  "surface_area_log": [
    {
      "aligned_id": "aq_001",
      "predicted_answer_pair": ["...", "..."],
      "research_outcome_summary": "...",
      "gap_score": 0.7
    }
  ]
}
```

**Each `pair_debates[].moves[]` entry gains:**

- `stage`: `"alignment" | "debate"` — distinguishes 5.4c alignment moves from 5.4f debate moves.
- `evidence_refs`: array of `{ "observation_id": "..." }` and `{ "finding_id": "..." }` objects. **Required on every Claim emitted in `stage: "debate"`.** Optional on Support/Rebut/Question/Concede; if present, must reference at least one observation or finding actually in the pair's transcript.

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

The function `runWorkingGroup({ client, idea, model, smallModel, longContextModel, budget, territory, personas })` runs the six sub-stages for one territory. Signature mirrors the current `runPairDebate` so `run.js` can swap the call site cleanly. The pair is the territory's `assigned_pair`.

Sequence:

1. **5.4a Independent Ideation.** `Promise.all` over the two personas, each calling `runIdeation` from `persona.js`. Each invocation produces 4–6 candidate questions with `predicted_answer`, `predicted_confidence`, `surface_area_rationale`. Tool: `emit_candidate_question` (forced, with array output). Persist `candidate_questions[]`. Standard-context Sonnet.

2. **5.4b Adversarial Pre-check.** `Promise.all` over the two personas. Each persona sees the *other's* candidate questions and emits one `adversarial_mark` per question via the `emit_adversarial_mark` tool. Persist `adversarial_marks[]`. Standard-context Sonnet.

3. **5.4c Alignment Debate.** Sequential, like a v4 debate but with the restricted move set `Propose · Sharpen · Merge · Drop · Defer`. Bounded by `ALIGNMENT_MOVE_BUDGET = 8` total moves. The pair sees: candidate questions, adversarial marks. Moves persisted with `stage: "alignment"`. Standard-context Sonnet.

   After the debate concludes:
   - Collect "alignment-surviving" candidate questions (those Proposed, not Dropped/Deferred, possibly Sharpened or Merged).
   - Deterministically enforce the minority-protection rule:
     - If fewer than 1 alignment-surviving question originated from each persona's candidate list, pick the highest-rated candidate from the under-represented persona's list (rank by `predicted_confidence` descending; break ties using number of adversarial marks where the *other* persona said *cannot* answer from priors; final tiebreak by candidate_id).
     - Add that candidate as a minority-origin aligned question.
   - Cap total at 5 (`MAX_ALIGNED_QUESTIONS`). If more than 5 are surviving, drop the lowest-rated jointly-aligned questions (never drop minority origins).
   - Tag each output `aligned_question` with `origin: "minority_<persona_id>"` or `origin: "aligned"`.

4. **5.4d Researcher Delegation.** `Promise.all` over `aligned_questions`. Each call invokes `runJointResearcher({ client, idea, budget, aligned_question, territory_context, persona_lenses })` (`src/agents/researcher.js`). Each researcher writes its own log file `logs/pair-<territory_id>-researcher-<aligned_id>.jsonl`. Persist `researcher_reports[]` after all complete (or after `Promise.allSettled`-style partial — see §6.10 failure handling).

5. **5.4e Independent Observation.** Nested `Promise.all`: for each persona, for each researcher report, one call to `runObservation`. Each call produces 2–3 `observation` entries via the `emit_observation` tool. **Long-context (1M) Sonnet** — the prompt includes the full text of every researcher report in the pair (so this is the largest single context budget in the pipeline).

   The orchestrator validates the mandatory cross-reading invariant before transitioning to 5.4f: for every `(persona_id, report_id)` tuple, at least one observation must exist. If validation fails (e.g., a persona's observation call returned empty), the orchestrator retries once; on second failure it synthesizes a fallback observation `{ content: "[synthesized: no observation produced]", cited_finding_ids: [<first_finding_id>] }` and logs the synthesis. This is intentionally weak — a real production system would re-prompt more aggressively, but the prototype's job is to get to debate.

6. **5.4f Pair Debate.** Same shape as v4 `runPairDebate` (sequential moves with calcification check, parallel opening Claims, mutual-concession termination, `PAIR_MOVE_BUDGET = 12`). Two differences:
   - The system prompt is `PERSONA_DEBATE` instead of the old `PERSONA_BASE`. It instructs the persona to draw on its observations and to cite both an observation and a researcher finding on every Claim.
   - The `emit_move` tool schema requires `evidence_refs: array` on the move object; `moves.js` validates that `evidence_refs` is non-empty for Claims emitted in `stage: "debate"` and that each reference resolves to an actual observation or finding in the pair scope.
   - **Long-context (1M) Sonnet** — the prompt includes the full observation pool plus the full researcher findings index.

Output of `runWorkingGroup` is the complete `pair_debates[]` entry plus the `surface_area_log[]` (computed in a small post-hoc step: for each aligned question, pair the persona's `predicted_answer` with a one-paragraph summary of the researcher's outcome; compute a crude `gap_score` between 0 and 1 using string-similarity or LLM-graded similarity — **record-only in v5**, so the cheapest method is fine; a fixed-cost LLM call per aligned question is acceptable).

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

The implementation is a single Anthropic message loop with `tools: [webSearchTool({ maxUses: 4 }), webFetchTool({ maxUses: 6 }), EMIT_RESEARCHER_REPORT_TOOL]` and `forceTool: 'emit_researcher_report'` enabled only on the final iteration. The loop is bounded by `RESEARCHER_TOOL_BUDGET = 10` total tool calls (search + fetch combined) and `RESEARCHER_TURN_BUDGET = 6` model turns. If the budget exhausts before the model emits the final tool call, the orchestrator forces the model to emit via a final user message: "Tool budget exhausted; emit your researcher_report now via emit_researcher_report based on what you have."

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
| `PERSONA_DEBATE` | **rewritten** (formerly `PERSONA_BASE`) | Used in 5.4f. The Claim/Support/Rebut/Question/Concede protocol unchanged. Every Claim must cite an observation + a researcher finding. You are debating over evidence you and your partner have both seen. |
| `PERSONA_OPENING_OVERLAY` | **edited** | The "use web search sparingly" line is **removed** — there is no in-debate search in v5. The opening Claim must cite at least one observation + one finding. |
| `PERSONA_CALCIFIED_OVERLAY` | **edited** | Unchanged in mechanism, but the language is updated to acknowledge the observation/finding citation requirement. |
| `RESEARCHER` | **new** | See §6.5. |
| `CROSS_POLLINATION` | **edited** | Reactors now see aligned questions, claims, and the citation graph (finding summaries + URLs). The instruction adds: "You may borrow a question framing — your reaction can take the form 'if you'd also asked Q' (from the source pair's list), here's what it would have surfaced.'" |
| `SYNTHESIZER` | **rewritten** | Inputs widened: claim contents + resolved citations + question landscape + dead-end questions. Output gains `question_landscape` (structured) and `dead_end_summary` (prose). Tone discipline ("opinionated where evidence warrants") preserved. |

### 6.7 Cross-pollination

Mechanics unchanged: each pair reacts to exactly one other pair via the deterministic permutation in `selectReactorPermutation`. Two changes:

1. The reactor sees, in addition to the target pair's surviving claims: the target pair's `aligned_questions` (with provenance) and the citation graph (`finding_id → summary, source_url, source_quote` for every citation used in target claims).
2. The `emit_reaction` JSON schema gains an optional `borrows_aligned_id: string` field. If present, the reaction is treated as a "question-borrowing" reaction — the synthesizer may surface it as an example of cross-pollination of inquiry.

The constraint that reactions are Rebut/Question/Concede only (no new Claims) is unchanged.

### 6.8 Model selection

`src/anthropic.js` gains a `STAGE_MODELS` map. Each agent function reads its model from this map rather than the global `DEFAULT_MODEL`.

```js
const STAGE_MODELS = {
  discovery: 'claude-sonnet-4-6',
  coordinator: 'claude-sonnet-4-6',
  ideation: 'claude-sonnet-4-6',
  adversarial: 'claude-sonnet-4-6',
  alignment: 'claude-sonnet-4-6',
  researcher: 'claude-sonnet-4-6',
  observation: 'claude-sonnet-4-6-1m',   // 1M context window
  debate: 'claude-sonnet-4-6-1m',         // 1M context window
  cross_pollination: 'claude-sonnet-4-6',
  contradiction: 'claude-sonnet-4-6',
  synthesizer: 'claude-haiku-4-5-20251001',
};
```

The exact 1M-context model identifier (whether suffix `-1m`, header flag, or beta opt-in) is whatever the pinned SDK exposes; the map names the *role* and the implementation picks the right model wire-up. `investigation.model` (currently a single string) becomes `investigation.models` (object — same keys as `STAGE_MODELS`) so each run's model selection is recorded.

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
| 5.4d Researcher | A researcher returns `outcome: dead_end` | Expected — record as dead-end. Observations and debate proceed using the remaining `useful`/`partial` reports. If *all* researchers return dead_end, abort the working group with `terminated_by: "all_dead_end"` and record all aligned questions as dead-ends in the forum. |
| 5.4d Researcher | A researcher call throws (API error, parse error) | Retry once; on second failure, record a synthetic researcher report with `outcome: "dead_end"` and `findings: []` plus a log entry, and continue. Don't abort the pair. |
| 5.4e Observation | A persona's observation call fails | Retry once; on second failure, synthesize a placeholder observation per `(persona, report)` tuple (see §6.4 step 5). |
| 5.4f Debate | Calcification, parse errors | Identical to v4 — re-prompt, then synthesize on second rejection. |
| 5.4f Debate | Claim emitted without valid `evidence_refs` | `moves.js` rejects; re-prompt once. On second rejection, **drop the move** (do not synthesize — there's no honest fallback for a citation). The pair loses a turn but the invariant holds. |
| Cross-pollination | Reaction call fails | Identical to v4 — synthesize a fallback Question (the safest no-op move). |
| Forum, Synthesizer | Any failure | Identical to v4 — investigation stays in `investigating` status, partial state on disk, manual recovery via re-run. |

Across the pipeline, the rule is: a single pair's failure does not abort the run (use `Promise.allSettled` across territories, as v4 already does). A single researcher's failure does not abort the pair. Stage-internal failures retry once before synthesizing or dropping.

### 6.11 Logging

New log files per pair (under `~/.msv/ideas/<id>/logs/`):

- `pair-<territory_id>-ideation.jsonl`
- `pair-<territory_id>-adversarial.jsonl`
- `pair-<territory_id>-alignment.jsonl`
- `pair-<territory_id>-researcher-<aligned_id>.jsonl` (one per researcher invocation)
- `pair-<territory_id>-observation.jsonl`
- `pair-<territory_id>-debate.jsonl`

Existing log files preserved: `discovery.jsonl`, `coordinator.jsonl` (renamed from `coordinator-initial.jsonl` since there's only one invocation now), `cross-pollination.jsonl`, `forum-contradictions.jsonl`, `synthesizer.jsonl`, `parse-errors.jsonl`.

Each line remains `{"ts": "ISO", "kind": "request|response|tool_use|tool_result|rejected_move|synthesized_move|web_search|web_fetch|...", "payload": {...}}`. Per-pair logs go to distinct files so parallel writes within a pair (the parallel ideation calls, the parallel researcher calls, the parallel observation calls) don't contend — each (pair, sub-stage) writer owns its file.

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
→      12 reactions collected (3 question-borrowings)
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
- The 1M-context model's behavior at the upper end of its window. The smoke run uses a moderate-sized topic; window stress is left to actual use.

---

## 9. Performance Considerations

The architectural commitment is to spend more tokens and wall time in exchange for question depth and citation quality. The cost target is **~200–250k tokens, ~$5–10, 3–10 min wall time per run** (compared to v4's 70–100k / $1–3 / 1–3 min). This is documented in vision.md and accepted.

Specific levers:

- **Per-pair researcher parallelism** is the largest single contributor to wall-time savings. All aligned questions within a pair run their researchers concurrently; all pairs run concurrently. With 4 pairs × 5 aligned questions each, that's 20 concurrent researcher invocations at peak. Anthropic rate limits will throttle this; the SDK handles 429s with backoff (per v4's existing handling).
- **Long-context calls are expensive per call.** Observation (5.4e) and debate (5.4f) are the only stages on 1M Sonnet. Constraining these stages to small per-call output (observations: 2–3 per report; debate: 1 move) keeps the input-heavy / output-light asymmetry favorable.
- **Synthesizer on Haiku** reduces the per-token cost of the most-prompt-engineered call by an order of magnitude. The synthesizer reads structured input only — well within Haiku's capability.
- **Budget tracking** is unchanged in mechanism (`investigation.budget` counters, checked between stages). New counter: `used_researcher_tool_calls`. If a researcher exceeds its per-question budget, it's force-emitted as described in §6.5.

The cost estimate printed at the end of a run (§7.2) helps the user notice runaway costs in real time.

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
- **No new top-level docs.** This spec is the spec.

---

## 12. Implementation Phases

A single coherent rebuild rather than incremental migration. v5 is a clean break and the prototype's whole point is to validate the new architecture end-to-end, not to ship partial improvements.

### Phase 1 — Scaffolding and schema

1. Add `schema_version`, `STAGE_MODELS`, updated `freshInvestigation()` in storage.
2. Add the new tool schemas and validators in `moves.js`.
3. Add empty `src/working_group.js` and `src/agents/researcher.js` modules.
4. Rewire `run.js` to call the new orchestrator (initially calling stubs that throw `not_implemented`).

Once this phase compiles and tests pass for the deterministic parts, the rest can be implemented sub-stage by sub-stage with manual smoke runs in between.

### Phase 2 — Discovery and coordinator updates

1. Rewrite `PERSPECTIVE_DISCOVERY` and `COORDINATOR_TERRITORIES` prompts.
2. Update `discovery.js` and `coordinator.js` to match.
3. Delete `runCoordinatorSpawn`.
4. Smoke-test the first three stages on a throwaway topic.

### Phase 3 — Working-group sub-stages 5.4a–5.4c

1. Implement `runIdeation`, `runAdversarialMark`, `runAlignmentMove` in `persona.js`.
2. Implement the deterministic minority-protection post-step in `working_group.js`.
3. Unit-test the minority rule across synthetic inputs.
4. Smoke-test: one pair, one territory, stages 5.4a–5.4c.

### Phase 4 — Joint Researcher

1. Implement `researcher.js` and `runResearcherCall` in `anthropic.js`.
2. Add WebFetch tool wiring (or bump SDK version if needed).
3. Test the budget-bounded loop with a stub client.
4. Smoke-test: one aligned question through the researcher.

### Phase 5 — Working-group sub-stages 5.4d–5.4f

1. Implement `runObservation` and `runDebateMove` in `persona.js`.
2. Wire 1M-context model selection.
3. Wire `evidence_refs` validation into `moves.js` debate path.
4. Smoke-test: one full working group (5.4a → 5.4f).

### Phase 6 — Cross-pollination and forum

1. Update `CROSS_POLLINATION` prompt and `runCrossPollinationReaction` for citation-aware reactions.
2. Update `forum.js` for dead-end propagation.
3. Smoke-test: two working groups + cross-pollination + forum.

### Phase 7 — Synthesizer and review card

1. Rewrite `SYNTHESIZER` prompt; update synthesizer to read structured input only.
2. Wire Haiku model selection.
3. Update `render.js` and `review.js` for the new card and `[q]`/`[e]` keys.
4. End-to-end smoke run on a throwaway topic.

### Phase 8 — README + prototype.md follow-up

1. Update README with new cost expectations and review keys.
2. Open a follow-up issue/spec to rewrite prototype.md to match the implementation.

No time estimates per the spec template's guidance.

---

## 13. Open Questions

1. **WebFetch tool availability in pinned SDK.** Need to verify `@anthropic-ai/sdk@0.54.0` exposes a server-side WebFetch tool. If not, the Joint Researcher's quality depends on bumping the dep. Resolve before Phase 4.
2. **1M-context model identifier.** The Anthropic SDK may expose 1M context as a model variant, a header flag, or a beta opt-in. The implementation needs to pin to whichever surface the SDK offers; resolve during Phase 1.
3. **`gap_score` computation for `surface_area_log`.** Currently described as "crude string-similarity or LLM-graded." The first implementation should pick the cheapest workable option and document the choice in code. Since this is record-only in v5, the exact algorithm isn't load-bearing.
4. **Cross-pollination's "question borrowing" semantics.** §6.7 introduces an optional `borrows_aligned_id` field on reactions. Whether the synthesizer actually does anything special with it (vs. just rendering it in the question landscape) is unclear. First pass: just record it; revisit after smoke runs.
5. **Researcher report context budget.** A researcher_report with many findings can be large. The observation stage feeds the full report into 1M-context Sonnet. Need to verify (during Phase 5 smoke) that real reports fit comfortably and don't pathologically blow the context.
6. **Should the cross-pollination round see researcher reports or just summaries?** §6.7 says "summaries + URLs." If smoke runs show reactors making thin reactions because they lack source quotes, expand to include source quotes. Tune after first runs.

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
