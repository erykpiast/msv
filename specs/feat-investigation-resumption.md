# `msv run` — Investigation Resumption

**Status:** Draft
**Author:** Eryk Napierała · 2026-05-16
**Related:** [`specs/architecture.md`](architecture.md) "Data on disk" (line 555) (whose "no resumability" stance this spec reverses). [`specs/question-machine.md`](question-machine.md) (v5 working-group sub-stage definitions). [`specs/feat-tui-event-decoupling.md`](feat-tui-event-decoupling.md) (parallel work on the same `runPipeline`).

---

## 1. Overview

A long `msv run` is a brittle thing. Today, if the user interrupts it (Ctrl+C), or Anthropic returns 5xx for longer than `api_queue.js`'s 90-second wall-clock cap, or a single working group throws unexpectedly, the run aborts and the documented recovery path is to **start over from stage 1 of 7**. The pipeline can take many minutes; on a Tier-2 account a single run consumes thousands of `messages.create` calls and 100k+ tokens, all of which are wasted on restart.

This spec adds a resumption mechanism with two halves:

1. **Finer-grained checkpoints.** Today `idea.investigation` is persisted after each of the 7 macro stages. We add sub-stage checkpoints **within** stage 4 (working groups), so an interrupted run can resume at the exact sub-stage (ideation / adversarial / alignment / researcher / observation / debate) of the specific territory that was in flight. Other territories that already completed are preserved untouched.
2. **A typed failure state.** Today, status is ternary (`pending` / `investigating` / `ready`). An `investigating` idea is ambiguous: did it crash, did the user cancel, was it an Anthropic outage? We add a typed `last_failure` record (`anthropic_unavailable`, `user_cancelled`, `internal_error`) so resume is data-driven and the CLI can show actionable messaging. (Budget exhaustion is left as `internal_error` for Phase 1; a typed `BudgetExceededError` is deferred.)

User-visible surface stays small. `msv run <id>` auto-detects an interrupted run and resumes by default. A new `--restart` flag forces a clean re-run, archiving prior logs for forensics. First Ctrl+C triggers a graceful "finish current sub-stage, save, exit" — second Ctrl+C force-quits.

This spec deliberately stops short of per-API-call memoisation. That's a Phase 3 idea; the dominant cost we're recovering is sub-stage work, not individual calls.

---

## 2. Status

Draft.

---

## 3. Authors

Eryk Napierała · 2026-05-16.

---

## 4. Background / Problem Statement

Four concrete pain points motivate this work.

**1. Anthropic-side instability eats whole runs.** `src/api_queue.js` retries on 5xx / 429 / network errors up to 5× with backoff, capped at 90 s of wall-clock per call. When Anthropic has a real incident — sustained 500s or 529 Overloaded across the fleet — calls exhaust the cap and surface a hard error. That error propagates out of whatever stage was running, `runOne` catches at the top level (`src/commands/run.js:333-342`), prints `✗ {id} stage failed: ...`, and the idea is left in `investigating` state with partial `index.json` + intact JSONL logs. The run is dead. On a typical pipeline, stage 4 (working groups) is where roughly 70% of the calls live; losing it to a 90-second outage is the modal disaster.

**2. Manual cancellation is destructive.** There is no SIGINT handler today. Ctrl+C drops Node mid-syscall. Atomic writes to `index.json` (`src/storage.js:75-90` — exclusive tmp + rename) guarantee `index.json` is never half-written, but they don't guarantee that in-flight stage results land on disk — they don't, because each stage only persists after it completes. A user who hits Ctrl+C mid-stage-4 has thrown away all working-group progress, even though most territories may already have completed and only one was in flight.

**3. The documented recovery path is a sharp edge.** `specs/architecture.md` "Data on disk" (line 555):

> "**No resumability.** Same as v4 — re-running from scratch is the recovery path. A failed run leaves partial state in `index.json` and partial log files; the user reads them and decides whether to retry."

`src/commands/run.js:365-367` confirms this in a comment:

> "Spec §4.2: confirmation is only for ready ideas. Investigating ideas are the documented manual recovery path (hand-edit status, then re-run)."

So to recover, the user opens `~/.msv/ideas/{id}/index.json` in an editor, changes `"status": "investigating"` to `"status": "pending"`, saves, and runs `msv run {id}`. The pipeline now resets `idea.investigation` to a fresh shell and goes back to stage 1. This is fine as a documented escape hatch but terrible as a daily experience.

**4. There is no signal for why a run is paused.** `investigating` covers "currently running in another process" *and* "crashed an hour ago." `msv list` shows status but no context. Without a typed failure reason persisted alongside, the CLI can't show "interrupted by 503 from Anthropic, resume with: `msv run {id}`" — it can only show "still running?".

The goal is **work preservation, by default, with no extra UI surface area for the happy path**. A user who restarts a failed run should get back exactly as much work as had completed before the failure, without learning new commands.

---

## 5. Goals

* **Sub-stage checkpoints in the working-group pipeline.** After each of the six sub-stages within `runWorkingGroup` (ideation, adversarial, alignment, researcher, observation, debate) completes for a single territory, persist its partial result to `index.json` and mark progress.
* **Macro-stage skip-on-resume.** The seven top-level stages (`runPipeline`) each check whether their output is already present in `idea.investigation` and skip if so.
* **Auto-detect resume on `msv run <id>`.** No new subcommand. If status is `investigating` and `progress` indicates work is in flight or interrupted, resume; if status is `pending`, fresh-run; if `ready`, prompt confirmation (existing behaviour).
* **A `--restart` flag** on `msv run <id>` to force a fresh run, archiving the prior partial state (logs + index.json snapshot) under `~/.msv/ideas/{id}/.attempts/<timestamp>/` for forensics.
* **Graceful SIGINT.** First Ctrl+C: set a cancellation flag; pipeline checks at sub-stage boundaries; on detection, persist `last_failure.reason = 'user_cancelled'` and exit with code 130. Second Ctrl+C: hard exit. Print one line of explanation between them.
* **Typed `last_failure` record.** Persisted on `idea.investigation`. Enum values: `anthropic_unavailable`, `budget_exhausted`, `user_cancelled`, `internal_error`. Includes the stage / territory / sub-stage where it occurred, an error message (sanitised), and timestamp.
* **No silent data loss on crash.** If the Node process dies hard (SIGKILL, OOM), the most recent checkpoint must be sufficient to resume cleanly. We never have in-memory state that wasn't reflected on disk after the last successful sub-stage.
* **Backward compatibility for existing ideas.** Any idea written before this change (no `progress` field, schema_version `v5`) must continue to load and run via the fresh-from-scratch path with a clear log message. No data migration step is required.

---

## 6. Non-Goals

* **No per-API-call memoisation.** Caching individual `messages.create` responses keyed by request payload (so a resume could replay the prompt and reuse a logged response) is a Phase 3 idea; see §15. This spec stops at the sub-stage boundary.
* **No `AbortController` plumbing to individual API calls.** Today's `apiQueue.enqueue(fn)` does not pass an abort signal into `client.messages.stream()`. Threading an `AbortSignal` through every call site is a separable change; see §15 Phase 3. For Phase 1, in-flight API calls run to completion (within the 90 s queue cap) on cooperative cancel.
* **No partial-sub-stage resumption.** If the researcher sub-stage of one territory has emitted 3 of 5 reports when it crashes, on resume we re-run the entire sub-stage (all 5). Atomic unit of resumption is one sub-stage per territory. (Per-question memoisation is also Phase 3.)
* **No `msv resume` subcommand.** A new command would be redundant with auto-detection. The user types `msv run <id>` whether they want a new run or a resume.
* **No process-level lock or detach / re-attach.** If `msv run` is still alive in another terminal, a second `msv run <id>` against the same idea is racy. We don't add a `.lock` file in Phase 1 — single-user laptop tool, contrived risk; if real users hit it, Phase 2 can add one.
* **No status command (`msv status <id>`).** Could be useful (show "interrupted, last_failure=…, resume with: msv run") but is additive — Phase 2 if at all. `msv list` already shows status and a preview line.
* **No changes to `msv inspect`, `msv review`, `msv list`, `msv add`.** They are read-only or one-shot. They may surface the new `last_failure` field cosmetically (Phase 2) but no behaviour change in Phase 1.
* **No retroactive recovery from prior partial state.** Ideas already in `investigating` state at deploy time get the legacy "fresh-run-after-confirm" path, not auto-resume. They were written by code that didn't yet persist `progress`, so we have no anchor.
* **No changes to budget semantics on resume.** Budget counters (`used_executor_calls`, `used_total_tokens`) carry forward across resume; they reflect the cumulative cost of producing the current `index.json` state. `--restart` does reset them.
* **No coordination with the TUI-event-decoupling spec (`feat-tui-event-decoupling.md`).** Both touch `runPipeline` but they're orthogonal: one introduces a bus for live observation, this one persists state for resumption. They can land in either order; this spec uses the today-style `progress()` writes and the other spec migrates them when it lands.

---

## 7. Technical Dependencies

### Runtime (existing, unchanged)

* `node >= 20` — already required. Uses `node:fs/promises`, `node:os`, `node:process`, `process.on('SIGINT', …)`.
* `@anthropic-ai/sdk@^0.96` — unchanged. Resumption is upstream of SDK calls.
* `uuid@11.1.1` — unchanged.

### Runtime (new)

None. The mechanism is internal: schema additions on the JSON we already write, two small new modules (`src/resume.js`, `src/failure.js`), and changes to `src/commands/run.js`, `src/working_group.js`, `src/storage.js`.

### Test dependencies (existing)

* Whatever the project already uses for unit tests; the spec writes test cases as pseudocode and leaves the framework selection to the implementation PR. If the project lacks a test harness today, see §11.

### Documentation referenced

* Node SIGINT semantics — <https://nodejs.org/api/process.html#signal-events>. Specifically the "only one signal handler may be installed" model and that `process.exit(130)` is the conventional code for SIGINT.
* Node `fs.rename` atomicity guarantees — <https://nodejs.org/api/fs.html#fspromisesrenameoldpath-newpath>. Already relied on by `atomicWriteText`.
* Anthropic SDK error shape — <https://github.com/anthropics/anthropic-sdk-typescript#error-handling>. The `status` and `error.headers['retry-after']` surfaces we classify on.

No new package additions; no native dependencies.

---

## 8. Detailed Design

### 8.1 Architecture overview

```
                          ┌────────────────────────────────────┐
                          │           msv run <id>             │
                          └──────────────┬─────────────────────┘
                                         │
                          ┌──────────────▼─────────────────────┐
                          │   runRunCommand (src/commands/run) │
                          │     ┌─────────────────────────┐    │
                          │     │  parseRunSelection      │    │
                          │     │   --restart? --all?     │    │
                          │     └────────────┬────────────┘    │
                          │                  │                  │
                          │     ┌────────────▼────────────┐    │
                          │     │  planResume(idea)        │   │
                          │     │   src/resume.js          │   │
                          │     │   → 'fresh' | 'resume' | │   │
                          │     │     'restart' | 'confirm'│   │
                          │     └────────────┬─────────────┘   │
                          │                  │                 │
                          │     ┌────────────▼─────────────┐   │
                          │     │  install SIGINT handler   │  │
                          │     │  (cancellation token)     │  │
                          │     └────────────┬──────────────┘  │
                          │                  │                 │
                          │     ┌────────────▼──────────────┐  │
                          │     │  runPipeline(idea, …)     │  │
                          │     └────────────┬──────────────┘  │
                          │                  │                 │
                          │     ┌────────────▼──────────────┐  │
                          │     │  on error:                │  │
                          │     │  classifyError → last_failure  │
                          │     │  writeIdea                │  │
                          │     │  src/failure.js           │  │
                          │     └───────────────────────────┘  │
                          └────────────────────────────────────┘

  runPipeline stages (each guarded by inv.progress.current_stage):

    [1/7] discovery   → skip if perspective_discovery.candidate_personas.length > 0
    [2/7] diversity   → skip if perspective_discovery.selected_persona_ids.length > 0
    [3/7] coordinator → skip if coordinator_decisions.initial != null
    [4/7] working groups  ─┐
                           │  per-territory:
                           │    skip whole WG if progress.working_groups[id] == 'complete'
                           │    otherwise: pass previousResult to runWorkingGroup,
                           │      which skips internal sub-stages whose outputs exist
                           │
    [5/7] cross-pollination → skip if cross_pollination has been computed for current pair_debates
    [6/7] forum aggregation → skip if forum.constructed_at != null
    [7/7] synthesis        → skip if synthesis != null
```

### 8.2 Data model changes

`idea.investigation` (in `~/.msv/ideas/<id>/index.json`) gains two new top-level fields. **No `schema_version` bump.** The presence of `inv.progress` is what marks the new shape; legacy v5 ideas (no `progress`) take the fresh-run path on resume.

```jsonc
{
  "schema_version": "v5",   // unchanged

  // ... all existing fields (started_at, completed_at, model, budget,
  //     perspective_discovery, coordinator_decisions, pair_debates,
  //     cross_pollination, forum, synthesis) unchanged ...

  // NEW
  "progress": {
    "current_stage": "1_discovery"
                   | "2_diversity"
                   | "3_coordinator"
                   | "4_working_groups"
                   | "5_cross_pollination"
                   | "6_forum"
                   | "7_synthesis"
                   | "complete",
    "working_groups": {
      // Keyed by territory.id (or territory.territory_id; matches the same field
      // used everywhere else in the codebase). Present for every territory the
      // coordinator decomposed into; absent before stage 3 has completed.
      "<territory_id>": "pending"
                       | "ideation_complete"
                       | "adversarial_complete"
                       | "alignment_complete"
                       | "researcher_complete"
                       | "observation_complete"
                       | "complete"
    }
  },

  // NEW. null when the run is healthy / completed; populated on any failure or cancel.
  // Cleared on full completion; preserved across partial resumes that progress but
  // do not yet finish stage 7.
  "last_failure": null | {
    "reason": "anthropic_unavailable"
            | "user_cancelled"
            | "internal_error",
    "stage": "<current_stage value>",                   // never null
    "territory_id": "<territory_id> | null",            // null outside stage 4
    "sub_stage": "ideation" | "adversarial"             // null outside stage 4
                 | "alignment" | "researcher"
                 | "observation" | "debate"
                 | null,
    "error_message": "<sanitised single-line message>", // stripped of control chars
    "occurred_at": "<ISO 8601>"
  }
}
```

A working group that returned with `terminated_by` set (e.g. `'ideation_failure'`, `'all_dead_end'`) is treated as **`complete`** in `progress.working_groups[<id>]` — the WG reached a terminal state and the pipeline already has its (possibly minimal) result. We don't re-run terminated WGs on resume; the user can `--restart` if they want a fresh attempt.

#### Why a `progress` pointer rather than inferring from contents

We could plausibly compute the next stage by inspecting which arrays in `idea.investigation` are populated. We don't, for three reasons:

1. **Some sub-stage outputs are legitimately empty.** A WG's `adversarial_marks` may be `[]` when the marker silently failed (today's behaviour — `src/working_group.js:222-253` catches and continues with empty marks). Same for `observations` on full fallback. Length-based inference would falsely conclude "this sub-stage hasn't run yet."
2. **The pointer is the contract.** Pipeline code that fails to update `progress.current_stage` after writing a stage's output is a bug; we can lint for it. Inference encodes the same assumption silently and is easy to break.
3. **It's debuggable.** A human looking at `index.json` can read the pointer and know where the run was. Inference forces them to learn the rules.

The same logic applies to `working_groups[<territory_id>]`. Each sub-stage advances the value; absence means "the territory hasn't started yet" (legitimate when the coordinator just decomposed but stage 4 hasn't picked it up).

#### Why a separate `last_failure` instead of a status enum extension

We considered extending `idea.status` to include `failed_anthropic_unavailable`, `failed_internal_error`, etc. We rejected it because:

* `status` is observed by other commands (`msv list`, `msv inspect`, `msv review`) that have no business switching on failure types.
* The current enum (`pending` / `investigating` / `ready`) maps cleanly to "fresh run / interrupted run / completed run" — exactly the three things a planner cares about. Failure detail is orthogonal.
* `last_failure` can be cleared on successful resume without forcing a status transition. This means a previously-failed-then-resumed-and-completed idea is just `ready` with `last_failure: null`, as it should be.

`investigating` retains its meaning: there is partial work, and the run is either currently active or interrupted. Whether to resume or treat as stale is the planner's job.

### 8.3 Resume planner (new module `src/resume.js`)

A pure module — no I/O, no side effects. Single exported function:

```js
// src/resume.js
'use strict';

/**
 * Decide what to do with an idea presented to `msv run`.
 *
 * @param {object} idea      The loaded idea (post normalizeLoadedIdea).
 * @param {object} options
 * @param {boolean} options.restartFlag  Whether --restart was passed.
 * @returns {{
 *   mode: 'fresh' | 'resume' | 'restart' | 'confirm',
 *   summary: string,
 *   resumeFrom: null | {
 *     stage: string,
 *     workingGroups: Record<string, 'pending' | 'ideation_complete' | ... | 'complete'>
 *   }
 * }}
 */
function planResume(idea, { restartFlag } = {}) {
  if (restartFlag) {
    return { mode: 'restart', summary: 'restart requested', resumeFrom: null };
  }
  if (idea.status === 'ready') {
    return { mode: 'confirm', summary: 'already ready', resumeFrom: null };
  }
  if (idea.status === 'pending') {
    return { mode: 'fresh', summary: 'pending → fresh run', resumeFrom: null };
  }
  // status === 'investigating'
  const inv = idea.investigation || {};
  const progress = inv.progress;
  if (!progress?.current_stage) {
    // Legacy v5 idea with no progress field, or a v5 idea that crashed
    // before its first checkpoint. Treat as fresh.
    return {
      mode: 'fresh',
      summary: 'investigating with no resume anchor — running fresh',
      resumeFrom: null,
    };
  }
  // Note: progress.current_stage === 'complete' with status !== 'ready' is a
  // "should never happen" state. If we ever observe it, just resume — the
  // pipeline's idempotent skip-guards will fast-forward through every stage
  // and flip status to 'ready' on the final checkpoint. No special prompt.
  return {
    mode: 'resume',
    summary: describeResume(progress, inv),
    resumeFrom: {
      stage: progress.current_stage,
      workingGroups: progress.working_groups || {},
    },
  };
}

function describeResume(progress, inv) {
  const stage = progress.current_stage;
  if (stage !== '4_working_groups') {
    return `resume at stage ${stage}`;
  }
  const wgs = progress.working_groups || {};
  const counts = Object.values(wgs).reduce((acc, v) => { acc[v] = (acc[v] || 0) + 1; return acc; }, {});
  const parts = Object.entries(counts).map(([k, v]) => `${v}×${k}`).join(', ');
  return `resume at stage 4: ${parts}`;
}

module.exports = { planResume };
```

The planner returns four modes:

| `mode`     | Trigger                                             | Effect in `runRunCommand`                                                                                                                  |
| ---------- | --------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `fresh`    | `status === 'pending'`, or `investigating` with no `progress` | Reset `idea.investigation` (`freshInvestigation()`), proceed to `runPipeline`.                                                                |
| `resume`   | `status === 'investigating'` with `progress.current_stage` set | Pass existing `idea.investigation` into `runPipeline`; each stage / sub-stage checks for cached output and skips if present.                  |
| `restart`  | `--restart` flag                                    | Archive logs + index.json snapshot to `.attempts/<timestamp>/`, then proceed as `fresh`.                                                       |
| `confirm`  | `status === 'ready'`                                | Existing behaviour: prompt `"already ready; re-run? [y/N]"`. On yes, treat as `restart`.                                                       |

### 8.4 Pipeline integration (changes to `src/commands/run.js`)

The high-level shape of `runPipeline` stays the same — seven `progress(…)` + stage call + `writeIdea` blocks. Each block grows a skip-guard and a progress-pointer update.

```js
// src/commands/run.js (sketch)

async function runPipeline(idea, client, { cancellationToken }) {
  const inv = idea.investigation;
  // Whatever path we took to get here, status moves to 'investigating' on entry.
  idea.status = 'investigating';
  if (!inv.started_at) inv.started_at = new Date().toISOString();
  inv.completed_at = null;
  inv.model = MODEL;
  inv.synthesizer_model = SYNTHESIZER_MODEL;
  if (!inv.progress) inv.progress = { current_stage: '1_discovery', working_groups: {} };
  await ensureIdeaDirs(idea.id);
  await writeIdea(idea);

  const id = idea.id;

  // ───────────────── [1/7] discovery ─────────────────
  if (inv.progress.current_stage === '1_discovery') {
    progress(`→ ${id} [1/7] perspective discovery (interrogative posture)…`);
    const discovery = await withHeartbeat('discovery', () =>
      runPerspectiveDiscovery({ client, idea, model: inv.model, budget: inv.budget,
        onProgress: (msg) => progress(`→      ${msg}`) })
    );
    inv.perspective_discovery.search_queries = discovery.search_queries;
    inv.perspective_discovery.candidate_personas = discovery.candidate_personas;
    progress(`→      surveyed ${discovery.search_queries.length} sources, generated ${discovery.candidate_personas.length} candidate personas`);
    inv.progress.current_stage = '2_diversity';
    await checkpoint(idea, cancellationToken);
  } else {
    progress(`→ ${id} [1/7] discovery cached (${inv.perspective_discovery.candidate_personas.length} personas)`);
  }

  // ───────────────── [2/7] diversity ─────────────────
  if (inv.progress.current_stage === '2_diversity') {
    progress(`→ ${id} [2/7] diversity selection…`);
    const selectedDiscovered = selectDiversePersonas(
      inv.perspective_discovery.candidate_personas, { count: 5 }
    );
    inv.perspective_discovery.selected_persona_ids = selectedDiscovered.map((p) => p.id);
    progress(`→      selected ${selectedDiscovered.length} personas (+ ${FIXED_PERSONAS.map((p) => p.role || p.id).join(', ')})`);
    inv.progress.current_stage = '3_coordinator';
    await checkpoint(idea, cancellationToken);
  } else {
    progress(`→ ${id} [2/7] diversity cached (${inv.perspective_discovery.selected_persona_ids.length} selected)`);
  }

  // selectDiversePersonas is deterministic and cheap; if we wanted, we could
  // run it on every resume to avoid persisting selected_persona_ids. But
  // persistence is the contract — `inv.perspective_discovery.selected_persona_ids`
  // is what every downstream stage reads.
  const selectedDiscovered = inv.perspective_discovery.selected_persona_ids
    .map((id) => inv.perspective_discovery.candidate_personas.find((p) => p.id === id))
    .filter(Boolean);
  const personas = [...selectedDiscovered, ...FIXED_PERSONAS];

  // ───────────────── [3/7] coordinator ─────────────────
  if (inv.progress.current_stage === '3_coordinator') {
    progress(`→ ${id} [3/7] coordinator decomposing into territories…`);
    const initialDecomposition = await withHeartbeat('coordinator', () =>
      runCoordinatorInitial({ client, idea, model: inv.model, budget: inv.budget, personas })
    );
    const territories = initialDecomposition.territories || initialDecomposition.sub_questions || [];
    inv.coordinator_decisions.initial = { decided_at: initialDecomposition.decided_at, territories };
    // Seed per-WG progress map so 4 below has anchors for every territory.
    for (const t of territories) {
      const tid = t.id || t.territory_id;
      inv.progress.working_groups[tid] = inv.progress.working_groups[tid] || 'pending';
    }
    progress(`→      ${territories.length} territories: ${territories.map((t) => t.name || t.id || t.territory_id).join(', ')}`);
    inv.progress.current_stage = '4_working_groups';
    await checkpoint(idea, cancellationToken);
  } else {
    progress(`→ ${id} [3/7] coordinator cached (${inv.coordinator_decisions.initial.territories.length} territories)`);
  }

  const territories = inv.coordinator_decisions.initial.territories;

  // ───────────────── [4/7] working groups ─────────────────
  if (inv.progress.current_stage === '4_working_groups') {
    progress(`→ ${id} [4/7] working groups (${territories.length} parallel pairs · six sub-stages each)…`);
    const workingGroups = await withHeartbeat('working-groups', () =>
      runWorkingGroupsConcurrently({ client, idea, inv, personas, territories, cancellationToken })
    );
    // workingGroups already merged into inv.pair_debates by the per-WG
    // checkpoint callback (see §8.5). Here we only advance the macro pointer.
    inv.progress.current_stage = '5_cross_pollination';
    await checkpoint(idea, cancellationToken);
  } else {
    progress(`→ ${id} [4/7] working groups cached (${inv.pair_debates.length}/${territories.length})`);
  }

  // ───────────────── [5/7] cross-pollination, [6/7] forum, [7/7] synthesis ─────────────────
  // (same pattern; full code in implementation PR)

  inv.completed_at = new Date().toISOString();
  inv.progress.current_stage = 'complete';
  inv.last_failure = null;
  idea.status = 'ready';
  await checkpoint(idea, cancellationToken);
}

// Helper: persist and check for cancel at every checkpoint boundary.
async function checkpoint(idea, cancellationToken) {
  await ideaWriteMutex(idea.id, () => writeIdea(idea));
  if (cancellationToken?.requested) {
    throw new CancellationError(`cancellation requested at stage ${idea.investigation.progress.current_stage}`);
  }
}
```

The `checkpoint` helper is the **only** place we write `index.json` from the pipeline. It does two things: (1) persist, and (2) honour cancellation. Combining them ensures we never persist without checking, and never check without persisting.

### 8.5 Working-group sub-stage checkpoints (changes to `src/working_group.js`)

`runWorkingGroup` gains two new parameters and emits a checkpoint after each sub-stage.

```js
// src/working_group.js (sketch)

async function runWorkingGroup({
  client, idea, model, synthesizerModel, budget,
  territory, personas, onProgress,
  // NEW
  previousResult,   // partial WG result from prior attempt; null on fresh
  onCheckpoint,     // async ({ partialResult, completedSubStage }) => void
  cancellationToken,
}) {
  const tid = territory.id || territory.territory_id;
  const pairPersonas = personas.filter((p) => territory.assigned_pair.includes(p.id));
  const result = previousResult ? { ...previousResult } : {
    territory_id: tid,
    candidate_questions: [],
    adversarial_marks: [],
    aligned_questions: [],
    researcher_reports: [],
    observations: [],
    moves: [],
    surviving_claims: [],
    terminated_by: null,
  };

  // ───── 5.4a Ideation ─────
  if (!result.candidate_questions || result.candidate_questions.length === 0) {
    onProgress?.(`[${territory.name || tid}] ideation start`);
    try {
      const candidates = await runIdeation({ /* ... */ });
      result.candidate_questions = candidates;
    } catch (err) {
      // retry once
      const candidates = await runIdeation({ /* ... */ });
      result.candidate_questions = candidates;
    }
    onProgress?.(`[${territory.name || tid}] ideation done (${result.candidate_questions.length} candidates)`);
    if (cancellationToken?.requested) throw new CancellationError(`cancelled at ${tid} ideation`);
    await onCheckpoint?.({ partialResult: result, completedSubStage: 'ideation' });
  } else {
    onProgress?.(`[${territory.name || tid}] ideation cached (${result.candidate_questions.length} candidates)`);
  }

  // ───── 5.4b Adversarial ─────
  // Special case: adversarial_marks can legitimately be empty after a successful
  // run if the marker failed. We disambiguate by checking the progress pointer
  // passed in via previousResult.__completedSubStages (internal scratch field),
  // OR by comparing against the working-groups progress map keyed by tid.
  // Implementation: the orchestrator passes `wgProgressValue` into runWorkingGroup
  // and we check `wgProgressValue >= 'adversarial_complete'` before deciding to skip.

  if (!isSubStageComplete(wgProgressValue, 'adversarial')) {
    onProgress?.(`[${territory.name || tid}] adversarial start`);
    try {
      result.adversarial_marks = await runAdversarial({ /* ... */ });
    } catch (err) {
      // Today's behaviour: catch silently, marks stay empty.
      onProgress?.(`[${territory.name || tid}] adversarial partial_failure (marks empty)`);
    }
    if (cancellationToken?.requested) throw new CancellationError(`cancelled at ${tid} adversarial`);
    await onCheckpoint?.({ partialResult: result, completedSubStage: 'adversarial' });
  } else {
    onProgress?.(`[${territory.name || tid}] adversarial cached (${result.adversarial_marks.length} marks)`);
  }

  // ───── 5.4c Alignment, 5.4d Researcher, 5.4e Observation, 5.4f Debate ─────
  // Same pattern: check isSubStageComplete, run if not, checkpoint after.

  // Final terminator: set terminated_by, return result.
  result.terminated_by ||= 'normal';
  return result;
}

// Helper: ordered comparison on the WG progress enum.
const SUBSTAGE_ORDER = [
  'pending', 'ideation_complete', 'adversarial_complete', 'alignment_complete',
  'researcher_complete', 'observation_complete', 'complete',
];
function isSubStageComplete(progressValue, subStage) {
  // 'adversarial' is complete iff progressValue >= 'adversarial_complete'
  const target = `${subStage}_complete`;
  const idx = SUBSTAGE_ORDER.indexOf(progressValue);
  const targetIdx = SUBSTAGE_ORDER.indexOf(target);
  return idx >= 0 && idx >= targetIdx;
}
```

The orchestrator in `run.js`:

```js
async function runWorkingGroupsConcurrently({ client, idea, inv, personas, territories, cancellationToken }) {
  const settled = await Promise.allSettled(territories.map((territory) => {
    const tid = territory.id || territory.territory_id;
    const wgProgressValue = inv.progress.working_groups[tid] || 'pending';
    if (wgProgressValue === 'complete') {
      // Skip; reuse existing pair_debate entry. Return a synthetic fulfilled result.
      const existing = inv.pair_debates.find((d) => d.territory_id === tid);
      return Promise.resolve(existing);
    }
    const previousResult = inv.pair_debates.find((d) => d.territory_id === tid) || null;
    return runWorkingGroup({
      client, idea, model: inv.model, synthesizerModel: inv.synthesizer_model,
      budget: inv.budget, territory, personas,
      onProgress: (msg) => progress(`→      ${msg}`),
      previousResult, wgProgressValue, cancellationToken,
      onCheckpoint: async ({ partialResult, completedSubStage }) => {
        // Take the mutex around the entire read-modify-write. Two concurrent
        // callbacks for different territories must not both see findIndex === -1
        // and both push — that would duplicate entries.
        await ideaWriteMutex(idea.id, async () => {
          const idx = inv.pair_debates.findIndex((d) => d.territory_id === tid);
          if (idx >= 0) inv.pair_debates[idx] = partialResult;
          else inv.pair_debates.push(partialResult);
          inv.progress.working_groups[tid] = `${completedSubStage}_complete`;
          await writeIdea(idea);
        });
      },
    });
  }));

  // Mark each settled outcome. Failures inside the WG already left progress
  // at the last successful sub-stage via onCheckpoint; here we only finalise
  // the fulfilled ones. Rejected outcomes are left at their last sub-stage
  // value so resume picks them back up.
  await ideaWriteMutex(idea.id, async () => {
    settled.forEach((r, i) => {
      const tid = territories[i].id || territories[i].territory_id;
      if (r.status === 'fulfilled') inv.progress.working_groups[tid] = 'complete';
    });
    await writeIdea(idea);
  });

  return settled.filter((r) => r.status === 'fulfilled').map((r) => r.value);
}
```

#### Concurrent write safety

Six working groups may be calling `onCheckpoint` at the same time. Today's `writeIdea` is atomic with respect to readers (temp + rename) but two concurrent writers race on the *content* — the second one's snapshot may not include the first one's mutation. Worse, the read-modify-write pattern (`findIndex` → conditional `push`/replace) lets two concurrent callbacks both observe `findIndex === -1` and both append, duplicating entries.

We add a tiny per-idea async mutex in `src/storage.js` and wrap the entire read-modify-write block (not just `writeIdea`) so the in-memory mutation and the disk write happen as one critical section:

```js
// src/storage.js (new)
const _ideaMutexes = new Map();
async function ideaWriteMutex(id, fn) {
  const prev = _ideaMutexes.get(id) || Promise.resolve();
  let resolveNext;
  const next = new Promise((r) => { resolveNext = r; });
  _ideaMutexes.set(id, prev.then(() => next));
  await prev;
  try {
    return await fn();
  } finally {
    resolveNext();
    if (_ideaMutexes.get(id) === next) _ideaMutexes.delete(id);
  }
}
module.exports.ideaWriteMutex = ideaWriteMutex;
```

All pipeline checkpoint writes — both the working-group `onCheckpoint` callbacks and the macro-stage `checkpoint(idea, …)` helper — go through this mutex. Ad-hoc `writeIdea` calls outside the pipeline (e.g. `msv archive`) are single-process and don't need it.

### 8.6 Failure classification (new module `src/failure.js`)

```js
// src/failure.js
'use strict';

class CancellationError extends Error {
  constructor(message) { super(message); this.name = 'CancellationError'; }
}

const RETRYABLE_NETWORK_CODES = new Set([
  'ETIMEDOUT', 'ECONNRESET', 'ENOTFOUND', 'ECONNREFUSED', 'EPIPE',
]);

function classifyError(err) {
  if (err instanceof CancellationError) return 'user_cancelled';
  const status = err?.status ?? err?.response?.status;
  if (typeof status === 'number' && status >= 500 && status < 600) return 'anthropic_unavailable';
  if (status === 429) return 'anthropic_unavailable'; // sustained rate-limit
  const code = err?.code ?? err?.cause?.code;
  if (RETRYABLE_NETWORK_CODES.has(code)) return 'anthropic_unavailable';
  if (typeof err?.message === 'string' && /exceeded wall-clock cap/.test(err.message)) {
    return 'anthropic_unavailable';
  }
  return 'internal_error';
}

function sanitiseMessage(err) {
  const raw = err instanceof Error ? err.message : String(err);
  // Strip control chars (paranoia for raw web content embedded in error messages)
  // and clip to 1 KB.
  // eslint-disable-next-line no-control-regex
  return raw.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f]/g, '').slice(0, 1024);
}

function actionableMessage({ id, reason, stage, territory_id, sub_stage }) {
  const where = [stage, territory_id && `territory ${territory_id}`, sub_stage].filter(Boolean).join(' / ') || 'unknown';
  return `✗ ${id} failed (${reason}) at ${where} — resume with: msv run ${id}`;
}

module.exports = { CancellationError, classifyError, sanitiseMessage, actionableMessage };
```

Budget violations (today thrown as plain `Error`s from the storage / agent layer) fall into `internal_error` until a follow-up spec introduces a typed `BudgetExceededError`. The motivation for resumption is Anthropic-side instability and user cancellation, not budget tuning; conflating the two would force budget-error sites to be edited as part of this PR for no resumption benefit.

`runOne()` catches at the top, classifies, persists, and prints:

```js
async function runOne(idea, client, { cancellationToken }) {
  try {
    await runPipeline(idea, client, { cancellationToken });
    return { ok: true };
  } catch (error) {
    const reason = classifyError(error);
    const inv = idea.investigation;
    const tid = inferTerritoryFromInFlight(inv); // optional best-effort
    const subStage = inferSubStageFromInFlight(inv, tid);
    inv.last_failure = {
      reason,
      stage: inv.progress?.current_stage || 'unknown',
      territory_id: tid,
      sub_stage: subStage,
      error_message: sanitiseMessage(error),
      occurred_at: new Date().toISOString(),
    };
    try { await writeIdea(idea); } catch (writeErr) {
      process.stderr.write(`✗ ${idea.id} also failed to persist last_failure: ${writeErr.message}\n`);
    }
    process.stdout.write(`${actionableMessage({ id: idea.id, ...inv.last_failure })}\n`);
    return { ok: false, error };
  }
}
```

### 8.7 Graceful cancellation

In `runRunCommand`:

```js
// src/commands/run.js
const cancellationToken = { requested: false };
let secondSignalArmed = false;

function onSigint() {
  if (!cancellationToken.requested) {
    cancellationToken.requested = true;
    process.stdout.write('received SIGINT; finishing current sub-stage and saving (press again to force-quit)…\n');
    secondSignalArmed = true;
  } else if (secondSignalArmed) {
    process.stdout.write('force-quitting; partial work may be lost\n');
    process.exit(130);
  }
}
process.on('SIGINT', onSigint);
process.on('SIGTERM', onSigint); // treat the same; e.g. for container shutdowns
```

The token is passed into `runPipeline` and from there into `runWorkingGroupsConcurrently` and `runWorkingGroup`. Each sub-stage checks `cancellationToken.requested` at its boundary (after persisting its output, before starting the next sub-stage) and throws `new CancellationError(…)` if set. The token is **not** wired into individual API calls; those run to completion within the 90-second queue cap.

After `runOne` returns, we remove the signal handler so a subsequent idea isn't subject to a stale token state:

```js
try { ... } finally {
  process.off('SIGINT', onSigint);
  process.off('SIGTERM', onSigint);
}
```

For `msv run --all`, each idea installs / removes its own handler; cancellation mid-`--all` stops the current idea, persists, and the loop exits without proceeding to the next idea (because the cancellation token was triggered).

### 8.8 The `--restart` flag

Added to `parseRunSelection`:

```js
function parseRunSelection(args) {
  const flags = { restart: false };
  const positional = [];
  for (const arg of args) {
    if (arg === '--restart') flags.restart = true;
    else if (arg === '--all') flags.all = true;
    else positional.push(arg);
  }
  if (flags.all && flags.restart) return { mode: 'error', reason: '--restart not allowed with --all' };
  if (positional.length === 0 && !flags.all) return { mode: 'usage' };
  if (flags.all) return { mode: 'all' };
  return { mode: 'single', id: positional[0], restartFlag: flags.restart };
}
```

In the `restart` branch:

```js
async function performRestart(idea) {
  const dir = ideaDir(idea.id);
  const archiveRoot = path.join(dir, '.attempts', new Date().toISOString().replace(/[:.]/g, '-'));
  await fs.mkdir(archiveRoot, { recursive: true });
  // Move the logs directory and a snapshot of index.json
  await fs.rename(path.join(dir, 'logs'), path.join(archiveRoot, 'logs'));
  const snapshot = JSON.stringify(idea, null, 2) + '\n';
  await fs.writeFile(path.join(archiveRoot, 'index.json.before-restart'), snapshot, 'utf8');
  // Reset
  idea.investigation = freshInvestigation();
  idea.status = 'pending';
  await ensureIdeaDirs(idea.id); // recreates empty logs/
  await writeIdea(idea);
}
```

Why archive instead of delete: a user running `--restart` likely just had a bad run; the logs are the forensic evidence that motivated the restart. Cost on disk is small (logs for a single run are tens of KB to a few MB). Cleanup is a future concern (Phase 2: `msv archive prune-attempts`).

### 8.9 End-to-end data flow on resume

1. User: `msv run 7a2e…cfa3`.
2. `parseRunSelection` → `{ mode: 'single', id: '7a2e…', restartFlag: false }`.
3. `readIdea('7a2e…')` → `idea` with `status === 'investigating'`, `inv.progress.current_stage === '4_working_groups'`, `inv.progress.working_groups = { t1: 'complete', t2: 'complete', t3: 'researcher_complete', t4: 'pending', t5: 'pending' }`.
4. `planResume(idea, { restartFlag: false })` → `{ mode: 'resume', summary: 'resume at stage 4: 2×complete, 1×researcher_complete, 2×pending', resumeFrom: { stage: '4_working_groups', workingGroups: {…} } }`.
5. Print `→ ${id} ${summary}`.
6. Install SIGINT handler.
7. `runPipeline(idea, client, { cancellationToken })`:
   - Stage 1: `inv.progress.current_stage !== '1_discovery'` → print "discovery cached", skip.
   - Stage 2: same, skip.
   - Stage 3: same, skip.
   - Stage 4: `=== '4_working_groups'` → enter.
     - t1: `working_groups[t1] === 'complete'` → return existing `inv.pair_debates[find(t1)]`.
     - t2: same.
     - t3: `'researcher_complete'` → call `runWorkingGroup` with `previousResult = inv.pair_debates[find(t3)]` and `wgProgressValue = 'researcher_complete'`. Inside: ideation skipped, adversarial skipped, alignment skipped, researcher skipped, **observation runs**, checkpoint, debate runs, checkpoint, return complete result.
     - t4: `'pending'` → call `runWorkingGroup` with `previousResult = null`, runs all 6 sub-stages, checkpoints after each.
     - t5: same as t4.
   - Stage 5, 6, 7 run normally.
8. On success: `inv.progress.current_stage = 'complete'`, `inv.last_failure = null`, `status = 'ready'`, final `writeIdea`.
9. Remove SIGINT handler.

### 8.10 Schema migration

**No `schema_version` bump.** The discriminator between "old idea, no resume anchor" and "new idea, resumable" is the presence of `inv.progress`. `normalizeLoadedIdea` gains one defensive line:

```js
// src/storage.js
function normalizeLoadedIdea(idea) {
  const inv = idea?.investigation;
  if (!inv) return idea;
  // Ensure the resumption fields exist at well-known keys with null defaults,
  // so downstream code can read inv.progress without optional chaining each time.
  // An idea written by older code simply has both null; planResume treats that
  // as "no resume anchor" and falls back to fresh-run.
  if (!('progress' in inv)) inv.progress = null;
  if (!('last_failure' in inv)) inv.last_failure = null;
  // Existing v5/v4 fallback logic untouched.
  if (!inv.schema_version) {
    const firstDebate = Array.isArray(inv.pair_debates) ? inv.pair_debates[0] : null;
    const hasV5Marker = firstDebate?.territory_id != null
      || Array.isArray(inv.coordinator_decisions?.initial?.territories);
    inv.schema_version = hasV5Marker ? 'v5' : 'v4';
  }
  return idea;
}
```

No filesystem migration step: we ensure the keys exist on load and the new shape gets persisted the next time `writeIdea` runs. An idea that's never touched stays at the on-disk shape it had.

---

## 9. User Experience

### 9.1 Happy path (no change)

```
$ msv run 7a2e3c1b-...-cfa3
→ 7a2e3c1b-...-cfa3 [1/7] perspective discovery (interrogative posture)…
→      surveyed 3 sources, generated 8 candidate personas
→ 7a2e3c1b-...-cfa3 [2/7] diversity selection…
→      selected 5 personas (+ skeptic, builder)
→ 7a2e3c1b-...-cfa3 [3/7] coordinator decomposing into territories…
→      4 territories: market-fit, tech-feasibility, regulatory, adoption
→ 7a2e3c1b-...-cfa3 [4/7] working groups (4 parallel pairs · six sub-stages each)…
→      [market-fit] 8 candidates, 5 aligned, 5 reports, 10 observations, 6 debate moves, 4 claims (mutual_concession)
→      [tech-feasibility] …
→      [regulatory] …
→      [adoption] …
→ 7a2e3c1b-...-cfa3 [5/7] cross-pollination round…
→      14 reactions collected
→ 7a2e3c1b-...-cfa3 [6/7] forum aggregation…
→      19 nodes, 4 contradictions surfaced, 2 dead-end questions preserved
→ 7a2e3c1b-...-cfa3 [7/7] synthesis (haiku)…
✓ 7a2e3c1b-...-cfa3 ready  (used 142/180 executor calls, 1,124,300/1,500,000 tokens (queue: 3 retries))
```

Unchanged.

### 9.2 Resume after Anthropic outage

```
$ msv run 7a2e3c1b-...-cfa3
→ 7a2e3c1b-...-cfa3 resume at stage 4: 2×complete, 1×researcher_complete, 2×pending
   (prior failure: anthropic_unavailable at 4_working_groups / territory regulatory / researcher, 2026-05-16T14:22:11Z)
→ 7a2e3c1b-...-cfa3 [1/7] discovery cached (8 personas)
→ 7a2e3c1b-...-cfa3 [2/7] diversity cached (5 selected)
→ 7a2e3c1b-...-cfa3 [3/7] coordinator cached (4 territories)
→ 7a2e3c1b-...-cfa3 [4/7] working groups (4 parallel pairs · six sub-stages each)…
→      [market-fit] (cached, complete)
→      [tech-feasibility] (cached, complete)
→      [regulatory] researcher cached (5 reports); observation start
→      [regulatory] observation done (10 observations)
→      [regulatory] debate start
→      [adoption] ideation start
…
✓ 7a2e3c1b-...-cfa3 ready  (used 156/180 executor calls, 1,287,900/1,500,000 tokens (queue: 8 retries))
```

The summary line at the top is the user-visible signal that resume happened. The "cached" annotations on each stage / sub-stage make it clear what was reused.

### 9.3 Manual cancel

```
$ msv run 7a2e3c1b-...-cfa3
→ 7a2e3c1b-...-cfa3 [1/7] perspective discovery…
→      surveyed 3 sources, generated 8 candidate personas
…
→ 7a2e3c1b-...-cfa3 [4/7] working groups …
→      [market-fit] ideation done (8 candidates)
→      [tech-feasibility] ideation done (7 candidates)
^C
received SIGINT; finishing current sub-stage and saving (press again to force-quit)…
→      [market-fit] adversarial done (8 marks)
→      [tech-feasibility] adversarial done (7 marks)
✗ 7a2e3c1b-...-cfa3 cancelled at 4_working_groups — resume with: msv run 7a2e3c1b-...-cfa3
$
```

A second `^C` between the first signal and the next checkpoint exits immediately.

### 9.4 Restart

```
$ msv run 7a2e3c1b-...-cfa3 --restart
restart requested; archiving prior state to ~/.msv/ideas/7a2e3c1b-.../  .attempts/2026-05-16T14-22-11/
→ 7a2e3c1b-...-cfa3 [1/7] perspective discovery…
…
```

### 9.5 Already-ready idea (unchanged)

```
$ msv run 7a2e3c1b-...-cfa3
Idea 7a2e3c1b-...-cfa3 is already ready; re-run? [y/N] y
restart requested; archiving prior state to …
…
```

(`re-run? [y/N] y` is treated as `--restart`.)

---

## 10. Testing Strategy

The project uses `node:test` + `node:assert/strict`. `package.json` defines `"test": "node --test"`, and the existing `test/` directory contains six test files (`anthropic.test.js`, `diversity.test.js`, `forum.test.js`, `moves.test.js`, `storage.test.js`, `working_group.test.js`) all following the same pattern: `const test = require('node:test'); const assert = require('node:assert/strict');` then top-level `test('name', () => { … })` calls.

New tests follow the same conventions. Where related behaviour already has a test file, **extend it** rather than create a new one — keeps a single `test/<module>.test.js` per source module.

### 10.1 New file `test/resume.test.js` — planner

```js
// Test: planResume() is the single decision point for what `msv run` does
// with a given idea. Wrong dispatch here means either lost work (treating a
// resumable idea as 'fresh') or infinite loops. Enumerates every branch.

const test = require('node:test');
const assert = require('node:assert/strict');
const { planResume } = require('../src/resume');

test('pending status → fresh', () => {
  const plan = planResume({ status: 'pending', investigation: {} }, { restartFlag: false });
  assert.equal(plan.mode, 'fresh');
});

test('ready status → confirm (existing behaviour)', () => {
  assert.equal(planResume({ status: 'ready', investigation: {} }, {}).mode, 'confirm');
});

test('investigating + no progress field → fresh (legacy v5 idea)', () => {
  const idea = { status: 'investigating', investigation: { schema_version: 'v5' } };
  assert.equal(planResume(idea, {}).mode, 'fresh');
});

test('investigating + progress.current_stage set → resume with WG map', () => {
  const idea = { status: 'investigating', investigation: {
    progress: { current_stage: '4_working_groups', working_groups: { t1: 'complete', t2: 'observation_complete' } },
  }};
  const plan = planResume(idea, {});
  assert.equal(plan.mode, 'resume');
  assert.equal(plan.resumeFrom.stage, '4_working_groups');
  assert.match(plan.summary, /1×complete/);
  assert.match(plan.summary, /1×observation_complete/);
});

test('--restart flag overrides everything', () => {
  assert.equal(planResume({ status: 'ready', investigation: {} }, { restartFlag: true }).mode, 'restart');
  assert.equal(planResume({ status: 'pending', investigation: {} }, { restartFlag: true }).mode, 'restart');
});
```

### 10.2 New file `test/failure.test.js` — error classification

```js
// Test: classifyError() decides what the persisted last_failure.reason will
// be, which in turn dictates the message shown to the user. A regression here
// means a real outage gets reported as 'internal_error' and the user thinks
// there's a code bug.

const test = require('node:test');
const assert = require('node:assert/strict');
const { classifyError, sanitiseMessage, CancellationError } = require('../src/failure');

test('500 status → anthropic_unavailable', () => {
  const err = Object.assign(new Error('Internal Server Error'), { status: 500 });
  assert.equal(classifyError(err), 'anthropic_unavailable');
});

test('429 → anthropic_unavailable (sustained rate-limit treated same)', () => {
  assert.equal(classifyError(Object.assign(new Error(), { status: 429 })), 'anthropic_unavailable');
});

test('ETIMEDOUT → anthropic_unavailable', () => {
  assert.equal(classifyError(Object.assign(new Error(), { code: 'ETIMEDOUT' })), 'anthropic_unavailable');
});

test('wall-clock cap message → anthropic_unavailable', () => {
  // api_queue.js wraps the underlying error and prefixes the message.
  // We must classify on the wrapper.
  assert.equal(
    classifyError(new Error('API call exceeded wall-clock cap (90000ms) after 3 retries: Internal Server Error')),
    'anthropic_unavailable'
  );
});

test('CancellationError → user_cancelled', () => {
  assert.equal(classifyError(new CancellationError('cancelled at t1 ideation')), 'user_cancelled');
});

test('400 status (validation) → internal_error', () => {
  // 4xx (except 429) means our prompt is wrong, not Anthropic's problem.
  // Should not auto-resume.
  assert.equal(
    classifyError(Object.assign(new Error('invalid_request_error'), { status: 400 })),
    'internal_error'
  );
});

test('plain TypeError → internal_error', () => {
  assert.equal(classifyError(new TypeError('Cannot read undefined')), 'internal_error');
});

test('sanitiseMessage strips control chars and clips to 1 KB', () => {
  // Error messages may contain web content surfaced via SDK error.message.
  // Control chars are unsafe when later printed to terminal or rendered.
  const longCtl = '\x07' + 'x'.repeat(2000);
  const msg = sanitiseMessage(new Error(longCtl));
  assert.equal(msg.length, 1024);
  assert.doesNotMatch(msg, /[\x00-\x1f]/);
});
```

### 10.3 Extend `test/working_group.test.js` — sub-stage skip-guards

Add to the existing file (which already covers `selectAlignedQuestions`).

```js
// Test: the skip-guards inside runWorkingGroup are what actually save user
// time on resume. If we get them wrong (e.g. skip a sub-stage when
// previousResult has the wrong shape), we silently produce a corrupt
// working-group result downstream.

const { runWorkingGroup } = require('../src/working_group');
const { CancellationError } = require('../src/failure');

test('previousResult with candidate_questions skips ideation', async () => {
  // The fake client throws if called for ideation; we only allow adversarial onwards.
  const fakeClient = makeFakeClient({ failOnSubStage: 'ideation' });
  const previousResult = {
    territory_id: 't1',
    candidate_questions: [{ candidate_id: 'c1', question: 'q', by_persona_id: 'A' }],
  };
  await runWorkingGroup({
    client: fakeClient,
    /* idea, model, synthesizerModel, budget, territory, personas elided */
    previousResult,
    wgProgressValue: 'ideation_complete',
    onCheckpoint: async () => {},
  });
  // Assertion is implicit: if ideation had been re-run, fakeClient would have thrown.
});

test('wgProgressValue === "adversarial_complete" skips adversarial even when marks are empty', async () => {
  // Adversarial may legitimately produce an empty marks array (the marker
  // silently failed; today's behaviour preserved). The progress pointer —
  // not array length — is the source of truth. Length-based inference would
  // falsely conclude "this sub-stage hasn't run yet."
  const fakeClient = makeFakeClient({ failOnSubStage: 'adversarial' });
  const previousResult = {
    territory_id: 't1',
    candidate_questions: [{ candidate_id: 'c1', question: 'q', by_persona_id: 'A' }],
    adversarial_marks: [],
  };
  const checkpoints = [];
  await runWorkingGroup({
    client: fakeClient,
    previousResult,
    wgProgressValue: 'adversarial_complete',
    onCheckpoint: async (e) => { checkpoints.push(e); },
  });
  assert.equal(checkpoints[0].completedSubStage, 'alignment');
});

test('cancellationToken.requested between sub-stages throws CancellationError before next call', async () => {
  // Cooperative cancellation only works if every sub-stage checks the token
  // after its checkpoint.
  const cancellationToken = { requested: false };
  const onCheckpoint = async ({ completedSubStage }) => {
    if (completedSubStage === 'ideation') cancellationToken.requested = true;
  };
  await assert.rejects(
    runWorkingGroup({
      client: makeFakeClient({ fastSucceed: true }),
      previousResult: null,
      wgProgressValue: 'pending',
      onCheckpoint,
      cancellationToken,
    }),
    (err) => err instanceof CancellationError
  );
});
```

`makeFakeClient` is a small helper colocated in `test/working_group.test.js` (or moved to `test/fixtures/` if it grows) that returns an object with `messages.stream(…) → { finalMessage() }`. The existing test file already uses similar fixtures.

### 10.4 Extend `test/storage.test.js` — concurrent write mutex

Add to the existing file (which already exercises `atomicWriteJson`, `archiveIdea`, etc.):

```js
// Test: concurrent working-group checkpoints all touch index.json. Without
// the read-modify-write being inside the mutex, two callbacks can both
// observe findIndex === -1 and both push, duplicating entries. This test
// simulates that race directly.

const { ideaWriteMutex } = require('../src/storage');

test('two concurrent read-modify-writes inside the mutex preserve both mutations', async () => {
  const idea = createIdea('test mutex');
  idea.investigation.progress = { current_stage: '4_working_groups', working_groups: {} };
  await writeIdea(idea);

  const op1 = ideaWriteMutex(idea.id, async () => {
    const cur = await readIdea(idea.id);
    cur.investigation.progress.working_groups.t1 = 'complete';
    await writeIdea(cur);
  });
  const op2 = ideaWriteMutex(idea.id, async () => {
    const cur = await readIdea(idea.id);
    cur.investigation.progress.working_groups.t2 = 'complete';
    await writeIdea(cur);
  });
  await Promise.all([op1, op2]);

  const final = await readIdea(idea.id);
  assert.deepEqual(final.investigation.progress.working_groups, { t1: 'complete', t2: 'complete' });
});
```

Without the mutex, this test would fail roughly half the time because op2 reads the idea before op1's write, then writes back without `t1`.

### 10.5 New file `test/integration_resume.test.js` — end-to-end

```js
// Test: end-to-end verification that an interrupted run resumes correctly.
// This is the headline test — if it passes, the feature works.

const test = require('node:test');
const assert = require('node:assert/strict');
const { createMockClient } = require('./mocks/anthropic');
const { createIdea, writeIdea, readIdea } = require('../src/storage');
const { runOne } = require('../src/commands/run');

test('crash mid-stage-4 resumes only the affected territory', async () => {
  const client = createMockClient({
    // Succeed for stages 1-3 and territories t1-t2 in stage 4. Throw 500 on
    // the 3rd web_search call within territory t3's researcher sub-stage.
    fail: { stage: 'researcher', territory: 't3', afterCalls: 2, status: 500 },
  });

  const idea = createIdea('Test resumption');
  await writeIdea(idea);

  const r1 = await runOne(idea, client, { cancellationToken: { requested: false } });
  assert.equal(r1.ok, false);

  const after1 = await readIdea(idea.id);
  assert.equal(after1.status, 'investigating');
  assert.equal(after1.investigation.last_failure.reason, 'anthropic_unavailable');
  assert.equal(after1.investigation.last_failure.territory_id, 't3');
  assert.equal(after1.investigation.last_failure.sub_stage, 'researcher');
  assert.equal(after1.investigation.progress.working_groups.t1, 'complete');
  assert.equal(after1.investigation.progress.working_groups.t2, 'complete');
  assert.equal(after1.investigation.progress.working_groups.t3, 'alignment_complete'); // researcher didn't finish

  client.unfail();
  const callsBefore = client.callCount();

  const r2 = await runOne(await readIdea(idea.id), client, { cancellationToken: { requested: false } });
  assert.equal(r2.ok, true);

  // Verify cost-saving: stages 1-3 should not have called the client again.
  const callsByStage = client.callsByStageSince(callsBefore);
  assert.equal(callsByStage.discovery, 0);
  assert.equal(callsByStage.coordinator, 0);
  assert.equal(callsByStage.researcher_t1, 0);
  assert.equal(callsByStage.researcher_t2, 0);
  assert.ok(callsByStage.researcher_t3 > 0, 't3 researcher should re-run');

  const final = await readIdea(idea.id);
  assert.equal(final.status, 'ready');
  assert.equal(final.investigation.last_failure, null);
});

test('SIGINT mid-stage-4 produces user_cancelled and resumes cleanly', async () => {
  // Validate the cooperative cancellation path end-to-end.
  const client = createMockClient({ /* slow but successful */ });
  const idea = createIdea('Test cancel');
  await writeIdea(idea);

  const cancellationToken = { requested: false };
  setTimeout(() => { cancellationToken.requested = true; }, 200);

  const r1 = await runOne(idea, client, { cancellationToken });
  assert.equal(r1.ok, false);

  const after = await readIdea(idea.id);
  assert.equal(after.investigation.last_failure.reason, 'user_cancelled');
  assert.equal(after.investigation.progress.current_stage, '4_working_groups');

  const r2 = await runOne(after, client, { cancellationToken: { requested: false } });
  assert.equal(r2.ok, true);
});

test('--restart archives prior logs and runs fresh', async () => {
  // --restart must wipe prior state but preserve forensic logs.
  const { performRestart } = require('../src/commands/run');
  const idea = createIdea('Test restart');
  await writeIdea(idea);
  await appendLog(idea.id, 'pair-t1-ideation', { kind: 'abort', reason: 'test' });

  idea.status = 'investigating';
  idea.investigation.progress = { current_stage: '4_working_groups', working_groups: { t1: 'ideation_complete' } };
  await writeIdea(idea);

  const client = createMockClient({ /* succeeds throughout */ });
  await performRestart(idea);
  const r = await runOne(idea, client, { cancellationToken: { requested: false } });
  assert.equal(r.ok, true);

  const attemptDirs = await fs.readdir(path.join(ideaDir(idea.id), '.attempts'));
  assert.equal(attemptDirs.length, 1);
});
```

### 10.6 Mocking strategy

`test/mocks/anthropic.js` (new) exports `createMockClient(options)` that returns an object with the same shape as the SDK's `Anthropic` client (`.messages.stream(…)` with a `.finalMessage()` Promise). It:

* Records every call (params, timestamp, classification by sub-stage).
* Optionally injects failures at programmable points (`fail: { stage, territory, afterCalls, status }`).
* Optionally adds latency for cancellation tests.

No network. The mock is the only new test fixture file.

### 10.7 Tests we deliberately *don't* add

* **Real Anthropic API tests for resume.** Too expensive; the mock covers the behaviours we need. A smoke test ("run a tiny topic end-to-end") may exist separately for CI confidence; it's not specific to resume.
* **Stress test for concurrent checkpoint writes.** The mutex is small; §10.4 is sufficient. We don't simulate 1000 working groups.
* **Crash-during-rename test.** `atomicWriteText` already guarantees rename is either fully visible or fully absent; testing the OS isn't our job.

---

## 11. Performance Considerations

### 11.1 Checkpoint write frequency

Today: 7 writes per run (one per macro stage).
After: 7 macro writes + up to 6 sub-stage writes × N territories (typically 4–6).

For a typical 5-territory run: 7 + 6×5 = **37 writes** per run. Each is a JSON serialise + atomic rename. `index.json` for a complete v5 investigation is roughly 50–200 KB. Total extra I/O: ~30 writes × ~100 KB = ~3 MB per run, scattered across many seconds.

This is well under any conceivable filesystem bottleneck. The atomic-write path is bounded by `fsync` latency, typically <10 ms on SSD; in-flight pipeline work is dominated by network round-trips to Anthropic (hundreds of ms each), so checkpoints are a rounding-error.

The per-idea mutex serialises these writes, which means the worst case is sequential — a checkpoint at the same instant by all 6 working groups becomes 6×10ms = 60ms of serialised wait before the slowest one proceeds. Acceptable.

### 11.2 JSON serialisation cost

`JSON.stringify(idea, null, 2)` for a fully-populated v5 investigation runs in 5–15 ms in Node 20. With 30 extra writes that's 150–450 ms total — again negligible against pipeline duration.

### 11.3 Memory

Resume holds the partial `idea.investigation` in memory just as today's run does — no growth. The `previousResult` parameter to `runWorkingGroup` is a reference to the existing in-`inv.pair_debates` entry; we don't copy.

### 11.4 Risk: index.json grows with attempts

`--restart` archives logs but not `index.json` snapshots (we do save one snapshot under `.attempts/`). The main `index.json` does not grow on restart because we fully reset `investigation`. Disk usage under `.attempts/` grows linearly with restart count; Phase 2 may add `msv archive prune-attempts`.

---

## 12. Security Considerations

The mechanism is **internal** — no network, no new external inputs, no new permission boundaries. The relevant security surface is small but worth pinning.

### 12.1 Path traversal on `.attempts/<timestamp>/`

The timestamp is generated by `new Date().toISOString().replace(/[:.]/g, '-')`, deterministic and free of path metacharacters. We pass through `assertWithinRoot` in `storage.js` for the `.attempts` directory creation, matching the existing pattern for `ideaLogPath`. No user input flows into the path.

### 12.2 Control-character injection in `last_failure.error_message`

Error messages may include arbitrary text (web-fetched content can surface in researcher errors). We persist them to JSON (where control chars become escape sequences anyway), but we also strip control chars via `sanitiseMessage` because:

* The message is printed to the terminal via `actionableMessage`.
* The message may be read by `msv inspect` and rendered into a TUI.
* Some control chars (OSC sequences) can hijack the terminal.

Existing precedent: `stripControlChars` in `src/storage.js:151-163` for log records. We reuse the same regex.

### 12.3 Symlink replacement of `index.json` during checkpoint

`atomicWriteText` uses `flag: 'wx'` on the tmp file, which refuses to write through a pre-placed symlink. Existing defence; no regression.

### 12.4 Resume re-reads `idea.investigation` — does this re-trust prior writes?

On resume, we read `index.json` and pass `inv.pair_debates[…]` straight back into the pipeline as `previousResult`. If a prior version of the code wrote malformed data, we propagate it. Two mitigations:

* `schema_version` is checked; ideas tagged `v4` or missing essential fields take the legacy fresh-run path.
* The skip-guards inside `runWorkingGroup` are shape-aware (e.g. `result.candidate_questions.length > 0`); a malformed previousResult means we'll regenerate rather than crash mid-sub-stage.

No new trust boundary; data we read on resume came from a prior invocation of the same binary.

### 12.5 No new secrets handling

The Anthropic API key handling is unchanged. Resume doesn't touch credentials.

---

## 13. Documentation

### 13.1 In-repo

* **`specs/architecture.md`** — Update the "Data on disk" section (line 555) to remove the "No resumability" sentence and reference this spec. Add a paragraph describing the new `progress` and `last_failure` fields.
* **`specs/feat-investigation-resumption.md`** — This file.
* **CLAUDE.md (if it exists)** — Add a one-line entry under "running" to document `--restart` and the auto-resume behaviour.
* **`README.md` or top-level help** — If `msv run --help` exists, extend it to mention `--restart`. If not, leave as-is (the auto-resume path requires no learning).

### 13.2 In-line code

* Doc comment on `planResume` enumerating the four modes and when each fires.
* Doc comment on the `progress` schema in `freshInvestigation` describing the state machine for `working_groups[<id>]`.
* Doc comment on `CancellationError` describing where it's thrown.

### 13.3 Not produced

* No external user-facing docs site changes (none exists).
* No migration guide for users (auto-detect on load; legacy ideas keep working).
* No changelog beyond commit message conventions already in use.

---

## 14. Implementation Phases

### Phase 1 — MVP

The full scope described in §8.

Deliverables:

1. `src/resume.js` (new) — `planResume`.
2. `src/failure.js` (new) — `CancellationError`, `classifyError`, `sanitiseMessage`, `actionableMessage`.
3. `src/storage.js` — `progress`/`last_failure` in `freshInvestigation`; `ideaWriteMutex`.
4. `src/commands/run.js` — `--restart` flag in `parseRunSelection`; `planResume` integration in `runRunCommand`; SIGINT handler; skip-guards on each of the 7 stages; `runOne` catch/classify/persist.
5. `src/working_group.js` — `previousResult` and `onCheckpoint` parameters on `runWorkingGroup`; per-sub-stage skip-guards; cancellation checks.
6. `specs/architecture.md` — "Data on disk" amendment.
7. `test/mocks/anthropic.js` (new) — mock client.
8. Tests: new files `test/resume.test.js`, `test/failure.test.js`, `test/integration_resume.test.js`, `test/mocks/anthropic.js`; extensions to existing `test/working_group.test.js` and `test/storage.test.js`. Coverage matching §10.

Exit criteria for Phase 1: all integration tests in §10.5 pass; manual smoke test of resume after killing `msv run` mid-flight on a real idea succeeds.

### Phase 2 — Polish

* **`msv status <id>`** command — reads the idea, prints status + `progress.current_stage` + `last_failure` in a friendly format. (No new state; pure read.)
* **`msv archive prune-attempts <id>`** — cleans up `.attempts/` directories older than N days.
* **`msv inspect` integration** — surface `last_failure` in the inspector UI (text-only).
* **`--restart --keep-logs`** — flag to skip the archive step (faster restart when forensics aren't needed).
* **Integration with `feat-tui-event-decoupling.md`** — when both specs land, migrate the progress writes to bus events with `stage.start`, `stage.skip`, `stage.complete`, `substage.start`, `substage.complete`, `pipeline.cancelled`, `pipeline.failed` event types.

### Phase 3 — Optional

* **Per-API-call memoisation in `src/api_queue.js`** — Cache successful `messages.create` responses keyed by a hash of `(model, params)` (excluding `metadata`), with persistence under `~/.msv/ideas/<id>/cache/<hash>.json`. On retry within the same idea, return the cached response instead of re-calling Anthropic. This makes the researcher sub-stage individually resumable at the per-tool-call level; not free, because cache invalidation on prompt-template change is tricky. See `specs/feat-api-memoisation.md` (hypothetical).
* **`AbortController` plumbing through `apiQueue.enqueue`** — Allow truly cancelling in-flight calls on SIGINT instead of waiting up to 90s. Requires touching every `messages.create` call site to pass `signal`. Modest mechanical change; not needed in Phase 1.
* **Best-effort process lock** — If real users report two-process races, add a `.lock` file written with `flag: 'wx'` at run start and removed at end; surface a clear "appears to be running already" error and a `rm <lockPath>` recovery instruction.

---

## 15. Open Questions

1. **Should budget counters reset on `--restart`?** Proposed: yes — the budget tracks cost of producing the current `index.json` state; restarting resets that state, so counters should reset too. Implementation: zero them out inside `performRestart`. Alternative: keep them cumulative across attempts (so a user who restarts 3 times sees their actual spend). Spec assumes "reset"; revisit if user disagrees.
2. **What if `progress.current_stage` and the contents of `idea.investigation` disagree?** E.g. `progress.current_stage === '7_synthesis'` but `inv.coordinator_decisions.initial === null`. Proposed: trust the pointer, log a warning. Alternative: detect and demote to fresh. This is a "should-never-happen" case; either choice is fine. Spec assumes "trust pointer + warn"; reconsider if real-world corruption appears.
3. **Do we need to extend `msv list` to show `last_failure.reason`?** Tempting (gives an at-a-glance view of which ideas need attention). Not in Phase 1 scope; Phase 2 candidate.
4. **Should `runPerspectiveDiscovery` and other agents that themselves do multi-turn API calls expose sub-progress for resumption?** No — see §6 Non-Goals. Discovery is one macro stage; if it fails mid-multi-turn, we re-run the whole thing on resume. Acceptable cost (~5 calls).
5. **Is `'5_cross_pollination'` a single atomic stage for resumption, or per-reactor-pair?** Proposed: single atomic stage in Phase 1. Cross-pollination has fewer calls than working groups and is structurally simpler; the cost of full re-run on resume is modest. Per-pair checkpointing is a Phase 2 candidate if real data shows it matters.
6. **Should `--restart` also be allowed with `--all`?** Today's prevention is `--restart not allowed with --all`. The alternative ("restart every pending idea") is dangerous and unlikely intended; the current restriction is safer. Open to changing if real usage shows otherwise.

**Resolved (decisions captured in spec body, not open):**

* `terminated_by` set on a WG entry → `progress.working_groups[<id>] = 'complete'` on resume; do not re-run. See §8.2.
* No `schema_version` bump; presence of `inv.progress` is the discriminator. See §8.10.
* No process-level lock file in Phase 1. See §6 Non-Goals.
* Budget violations classified as `'internal_error'` in Phase 1 (no typed `BudgetExceededError`). See §8.6.

---

## 16. Code Sites Touched

For implementer reference. Each item is a single file with a specific kind of change.

| File                              | Kind        | Why                                                                                              |
| --------------------------------- | ----------- | ------------------------------------------------------------------------------------------------ |
| `src/resume.js`                   | new         | `planResume` planner. Pure module.                                                               |
| `src/failure.js`                  | new         | `CancellationError`, `classifyError`, `sanitiseMessage`, `actionableMessage`.                    |
| `src/storage.js`                  | modify      | `freshInvestigation` adds `progress`/`last_failure`; `normalizeLoadedIdea` ensures keys exist on legacy ideas; new `ideaWriteMutex`. |
| `src/commands/run.js`             | modify      | `parseRunSelection` learns `--restart`; `runRunCommand` calls `planResume` and installs SIGINT; `runPipeline` adds skip-guards on each of 7 stages; `runOne` classifies + persists `last_failure`; helper `checkpoint(idea, cancellationToken)`. |
| `src/working_group.js`            | modify      | `runWorkingGroup` accepts `previousResult`, `wgProgressValue`, `onCheckpoint`, `cancellationToken`; each sub-stage gains a skip-guard and a checkpoint call. |
| `specs/architecture.md`           | modify      | Edit the "Data on disk" section to remove the "No resumability" claim and reference this spec.   |
| `test/mocks/anthropic.js`         | new         | Mock SDK client with programmable failure injection. The only new test fixture file.             |
| `test/resume.test.js`             | new         | §10.1 cases.                                                                                     |
| `test/failure.test.js`            | new         | §10.2 cases.                                                                                     |
| `test/working_group.test.js`      | extend      | §10.3 cases appended to existing file.                                                           |
| `test/storage.test.js`            | extend      | §10.4 mutex case appended to existing file.                                                      |
| `test/integration_resume.test.js` | new         | §10.5 end-to-end cases.                                                                          |

No changes to `src/api_queue.js`, `src/anthropic.js`, `src/forum.js`, `src/agents/*` in Phase 1. (Phase 3 would touch `src/api_queue.js`.)

---

## 17. References

* `specs/architecture.md` "Data on disk" (line 555) — current "no resumability" stance.
* `specs/question-machine.md` — v5 working-group six-sub-stage definitions whose boundaries this spec uses as checkpoint anchors.
* `specs/feat-tui-event-decoupling.md` — parallel work on `runPipeline`. Coordination strategy described in §6.
* `src/commands/run.js:333-342` — current `runOne` catch behaviour we're extending.
* `src/working_group.js:179-620` — sub-stage implementations whose boundaries become checkpoints.
* `src/api_queue.js:9-94` — existing in-call retry/backoff behaviour. Resume picks up where this gives up.
* `src/storage.js:75-90` — `atomicWriteText` we continue to rely on (no change).
* Node.js process signals — <https://nodejs.org/api/process.html#signal-events>.
* Node.js `fs.rename` atomicity — <https://nodejs.org/api/fs.html#fspromisesrenameoldpath-newpath>.
* Anthropic SDK error shape — <https://github.com/anthropics/anthropic-sdk-typescript#error-handling>.
* Idempotency and at-least-once semantics in workflow engines (background reading) — Temporal docs on "non-determinism on replay" and "side-effect markers". This spec achieves similar guarantees without a workflow engine because the pipeline's only side effect outside `index.json` writes is calls to Anthropic, and resume re-runs sub-stages whole rather than mid-call.
