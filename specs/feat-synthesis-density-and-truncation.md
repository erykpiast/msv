# Synthesis Density & Truncation Fix

## Problem Statement

Users running msv investigations get a synthesis (`inv.synthesis` / `synthesis.md`) that reads shallow and thin relative to how much research actually happened. A representative investigation gathered 180 findings across 156 distinct sources, but the final synthesis surfaced only ~30 findings total, an empty `report` field, and `null` `key_references`/`next_pass_proposals` — with no indication to the user that anything was cut or missing. The user expects the synthesis to reflect the density of what was actually investigated, not a fixed-size summary that silently degrades on richer investigations.

Two independent root causes were identified by inspecting a real session (`~/.msv/ideas/e69c43d1-.../logs/synthesizer.jsonl`, `synthesis.md`, `index.json`):

1. **Silent truncation.** The synthesizer call hit `stop_reason: max_tokens` at exactly the configured ceiling (10,000 tokens), consuming the whole budget on `sections`/`tension_points` before ever reaching `key_references`, `next_pass_proposals`, or `report`. The code's existing recovery path (`coerceArray`, `payload.report || ''`) absorbs this into `null`/`""` instead of surfacing it — so the pipeline reports success (`idea.status = 'ready'`) with a synthesis that is silently missing entire fields.
2. **Fixed, input-size-independent output caps.** The `emit_synthesis` tool schema hard-caps `sections` (≤6), `key_findings` per section (≤5), `key_references` (≤8), `headline_findings` (≤5), and `next_pass_proposals` (≤6) regardless of how many findings/sources the investigation actually produced. `renderFindings` additionally pre-truncates the reference list handed to the synthesizer to the top 30 sources before the model ever sees the rest. The result: a 20-source investigation and a 200-source investigation produce a synthesis of roughly the same size.

## Solution

Fix the truncation bug first (it is an active, currently-silent data-loss bug), then address the fixed-cap sizing as a related but separable follow-on. For the truncation fix specifically:

- Move the synthesizer off Haiku onto a stronger, single-shot-appropriate model, and move the shared research/debate model onto its current-generation successor.
- Give the synthesizer call genuine token headroom via streaming (removing the SDK non-streaming timeout ceiling that blocks raising `maxTokens` past ~16K) instead of quietly capping output.
- Detect truncation explicitly (`stop_reason: max_tokens`) rather than absorbing it into empty/null fields, and represent it as a first-class, visible state instead of a silent success or a destructive failure.
- Preserve the pipeline's existing checkpoint/resume behavior so that a truncated synthesis costs one retried synthesizer call, not a re-run of the whole investigation.

## User Stories

1. As a user reviewing a completed investigation, I want the synthesis to reflect the actual depth of research gathered, so that I don't have to go digging through raw sources to find findings the synthesis dropped.
2. As a user, I want to know when a synthesis is incomplete/truncated, so that I don't mistake a partial report for the full picture.
3. As a user whose investigation's synthesis was truncated, I want to still see the partial synthesis immediately in the inspector, so that I have something useful to read while a retry is pending.
4. As a user whose investigation's synthesis was truncated, I want re-running the investigation to only redo the synthesis step, so that I don't lose or re-pay for the research, debate, and forum-aggregation work that already succeeded.
5. As a user, I want the synthesizer to use a model capable of producing dense, well-reasoned output on a single high-value call, so that the quality of the final deliverable isn't bottlenecked by using the cheapest/fastest model tier for the highest-value step.
6. As a user, I want the research/debate pipeline stages to stay on a current-generation model, so that the whole pipeline (not just synthesis) benefits from model improvements.
7. As a maintainer, I want `stop_reason: max_tokens` on the synthesizer call to be detected and logged distinctly from a normal completion, so that recurring truncation is visible in logs/telemetry rather than only discoverable by manual session inspection.
8. As a maintainer, I want the synthesizer's streaming code path isolated to the synthesizer call site, so that the existing non-streaming `runStructuredCall` used by research/debate/working-group calls is not disturbed by this change.
9. As a maintainer, I want adaptive thinking explicitly configured (not left to each model's differing default) on both the synthesizer and the shared research/debate model, so that behavior doesn't silently change again on a future model swap.
10. As a maintainer, I want the synthesizer's `effort` set high for its single, high-value call, while research/debate calls keep their existing default effort, so that the quality investment is concentrated where it has the most leverage without inflating cost/latency across every call in the pipeline.
11. As a maintainer, I want a truncated synthesis to leave `idea.status` at `'investigating'` and `current_stage` at `'7_synthesis'` (not advance to `'complete'`/`'ready'`), so that the existing resume logic in `resume.js` naturally offers a cheap synthesis-only retry rather than requiring a new restart mechanism.
12. As a maintainer, I want the truncated-partial synthesis payload persisted to `inv.synthesis` with a visible flag, so that the inspector (which renders off `view.synthesis` presence, independent of `idea.status`) can display it without any inspector-side changes.
13. As a user browsing the CLI investigation list/failure banner, I want a truncated synthesis to show up as a recognizable prior failure (e.g. via `last_failure`), so that I understand why the investigation isn't marked `ready` yet.
14. As a maintainer, I want unit tests exercising the streaming synthesizer path (success, and simulated `stop_reason: max_tokens`) via the existing mock Anthropic client seam, so that this behavior is covered without hitting the real API.
15. As a maintainer, I want an integration test exercising `runOne`/`runPipeline` for the truncated-synthesis case, so that the "stage not advanced, resumable, partial persisted" contract is verified end-to-end the same way existing resume tests verify stage-skip behavior.
16. As a user with a richer investigation (many sources/findings), I want the synthesis output size to eventually scale with the amount gathered rather than being capped at a fixed size — this is explicitly deferred to a follow-up spec (see Out of Scope), but this spec should not make that follow-up harder.

## Implementation Decisions

- **Model configuration (`src/models.js`):**
  - `MODEL` (used as the default model for research/debate/working-group calls via `runStructuredCall`) changes from `claude-sonnet-4-6` to `claude-sonnet-5`.
  - `SYNTHESIZER_MODEL` changes from `claude-haiku-4-5-20251001` to `claude-opus-4-8`.
  - `NICKNAMER_MODEL` is unchanged (already on current Haiku).
- **Thinking configuration:** Both the shared research/debate calls (`MODEL`) and the synthesizer call explicitly pass `thinking: {type: "adaptive"}` rather than omitting the field and relying on each model's differing default (Sonnet 5 defaults to adaptive-on when omitted; Opus 4.8 defaults to no-thinking when omitted).
- **Effort configuration:** The synthesizer call sets `output_config.effort: "xhigh"`. Research/debate calls via `runStructuredCall` are left at the model default (effort omitted) — this is intentionally not part of this change.
- **New streaming call path, scoped to the synthesizer only:**
  - A new function (naming to follow existing `runStructuredCall` conventions in `src/anthropic.js`, e.g. `runStructuredStreamingCall`) wraps `client.messages.stream(...)` + `stream.finalMessage()`, mirroring `runStructuredCall`'s existing contract (accepts `client`, `system`, `messages`, `tools`, `forceTool`, `model`, `maxTokens`, `budget`; returns `{ response, toolUse, usage, web_searches }`) so `runSynthesizer` in `src/agents/synthesizer.js` can swap call styles with minimal surrounding changes.
  - `runStructuredCall` (the existing non-streaming function) is **not** modified to add streaming — it continues to serve research/debate/working-group calls unchanged.
  - The synthesizer's `maxTokens` is raised from 10,000 into the 32,000 range (exact value an implementation-time tuning decision, not below 32,000) to give adaptive thinking + all structured fields + prose report genuine headroom.
- **Truncation detection and handling in `runSynthesizer`:**
  - After the streaming call resolves, check `response.stop_reason === 'max_tokens'` explicitly (do not rely solely on `coerceArray`/`|| ''` fallbacks to infer truncation).
  - On truncation, `runSynthesizer` does **not** throw. It returns the same payload shape it always does, plus a `truncated: true` field, using whatever structured data did come back (partial `sections`, `headline_findings`, etc., with `coerceArray`/`null` fallbacks still applying to fields that never arrived).
  - Log the truncation via the existing `appendLog(idea.id, 'synthesizer', ...)` call so it's visible in `logs/synthesizer.jsonl` distinctly from a normal completion (e.g. include `truncated: true` in the logged response payload alongside the existing `stop_reason`/`usage`/counts).
- **Pipeline persistence (`src/commands/run.js`, stage `7_synthesis`):**
  - `inv.synthesis` is populated with the (possibly partial) synthesis payload as today, plus the `truncated` flag, regardless of whether truncation occurred.
  - When `truncated: true`: do **not** set `inv.progress.current_stage = 'complete'`, do **not** set `idea.status = 'ready'`, and do **not** clear `inv.last_failure`. Instead set `inv.last_failure` to describe the truncation (reason/stage `'7_synthesis'`) the same way the existing `catch` block in `runOne` populates it for other failures, so `describeResume`/the CLI failure banner surfaces it consistently.
  - `inv.progress.current_stage` remains `'7_synthesis'`, so the existing `resume.js` `planResume` logic (`idea.status !== 'ready'` → `mode: 'resume'`) naturally re-enters just the synthesis stage on the next run — no new resume/restart code path is introduced.
  - When `truncated` is falsy (normal completion), behavior is unchanged from today (`current_stage = 'complete'`, `status = 'ready'`, `last_failure = null`).
- **Inspector:** No changes required. `SynthesisNode.tsx`/`leafRenderers.tsx` already render off `view.synthesis` presence rather than `idea.status`, so a partial-but-persisted synthesis displays immediately once `inv.synthesis` is written.
- **Fixed output caps (schema `maxItems` on `sections`, `key_findings`, `key_references`, `headline_findings`, `next_pass_proposals`, `tension_points`, and the 30-source pre-truncation in `renderFindings`) are explicitly not changed in this spec** — see Out of Scope.

## Testing Decisions

- Tests should exercise observable behavior (payload shape, persisted `inv` state, resumability) through the existing seams, not internal call mechanics.
- **Unit level (`test/synthesizer.test.js`, mirroring existing tests in that file):**
  - Extend `test/mocks/anthropic.js` to support a `messages.stream(...)` call returning an object with `.finalMessage()`, matching the real SDK surface, so `runSynthesizer`'s new streaming path can be exercised without touching `runStructuredCall`'s existing mock behavior.
  - Add a case where the mock's streamed final message reports `stop_reason: 'max_tokens'` with a partial `emit_synthesis` payload (e.g. missing `report`/`key_references`), asserting `runSynthesizer` returns `truncated: true` plus whatever partial fields were present, and does not throw.
  - Keep/extend the existing "full payload from mock" test to assert `truncated` is falsy on a normal completion.
- **Integration level (`test/integration_resume.test.js`, mirroring the existing `runOne`/`runPipeline` stage-7 resume tests in that file):**
  - Add a case using the mock client configured to simulate a truncated synthesizer response at `current_stage: '7_synthesis'`, asserting after `runOne`: `inv.synthesis.truncated === true`, `inv.progress.current_stage === '7_synthesis'` (unchanged), `idea.status !== 'ready'`, and `inv.last_failure` is populated.
  - Add a case confirming that re-invoking `runOne` on that same idea (simulating the next resume) re-enters and re-runs only the synthesis stage — following the same assertion pattern as the existing `'runPipeline skips stages 1–6 when resuming at stage 7 (synthesis)'` test.
- Prior art: `test/synthesizer.test.js` (mock-client unit tests for `runSynthesizer`), `test/integration_resume.test.js` (existing `runOne`/`runPipeline` resume-at-stage-7 tests, including a prior-failure-at-stage-7 case), `test/anthropic.test.js` (mock-client conventions for `runStructuredCall`).

## Out of Scope

- Redesigning or scaling the fixed schema caps (`sections`, `key_findings`, `key_references`, `headline_findings`, `next_pass_proposals`, `tension_points` `maxItems`, and the 30-source cap in `renderFindings`) so synthesis size scales with investigation size. This was identified as the second, independent root cause of shallow synthesis output and is intentionally deferred to a follow-up spec — this spec only fixes the truncation/model/streaming issue.
- Any change to `runStructuredCall`'s non-streaming behavior or its use by research/debate/working-group calls beyond the `MODEL` constant swap and explicit `thinking`/effort configuration described above.
- A UI/CLI affordance specifically surfacing "this synthesis was truncated" beyond what already falls out of `last_failure` and the persisted `truncated` field (e.g. no new inspector banner component is specified here — only that the data needed for one is present).
- Retry-with-shorter-prompt or other automatic content-shrinking strategies on truncation — explicitly rejected in favor of raising `maxTokens` + streaming, with truncation as a rare, visible, resumable event rather than something silently compensated for.
- Any change to the nicknamer model or its call path.

## Further Notes

- The truncation bug is currently silent: `logs/synthesizer.jsonl` for the inspected session showed `stop_reason: 'max_tokens'`, `report_chars: 0`, and `null` `key_references`/`next_pass_proposals`, while the investigation still completed with `idea.status = 'ready'`. This spec's logging change (surfacing `truncated: true` in the logged response payload) is what would have made this bug visible without manual session archaeology.
- The follow-up spec for scaling the fixed schema caps should account for the fact that `renderFindings` currently discards all but the top 30 deduplicated source URLs before the synthesizer prompt is even built — raising the `emit_synthesis` schema's `maxItems` alone would not help if the upstream source list handed to the model is still capped at 30.
- This spec assumes `claude-sonnet-5` and `claude-opus-4-8` are available model IDs with no beta header required for the 1M-token context window (verified as the current default for both models, not a separate opt-in).
