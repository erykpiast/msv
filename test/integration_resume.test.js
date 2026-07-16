'use strict';

// Integration tests for the investigation resumption feature.
//
// Tests in this file exercise runOne / runPipeline end-to-end using the mock
// Anthropic client (test/mocks/anthropic.js) and real disk I/O under a
// temporary MSV_ROOT directory.
//
// What is covered here that unit tests cannot:
//   1. runPipeline correctly skips completed stages when resuming (§8.4 skip-guards).
//   2. Anthropic-side failure mid-pipeline produces a typed last_failure record on disk.
//   3. A run that failed can resume from where it left off and reach 'ready'.

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');

const test = require('node:test');
const assert = require('node:assert/strict');

const { createMockClient } = require('./mocks/anthropic');
const { createIdea, writeIdea, readIdea, ideaDir, setRootForTesting } = require('../src/storage');
const { runOne } = require('../src/commands/run');

// storage.js reads process.env.MSV_ROOT into a module-level constant exactly
// once. Two test files setting the env var would race on whichever required
// storage.js first, so we use setRootForTesting() to reconfigure the root at
// runtime — isolated from any other test file.
const TEST_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'msv-integration-resume-'));
setRootForTesting(TEST_ROOT);

test.after(async () => {
  await fsp.rm(TEST_ROOT, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// Build minimal idea with stages 1–6 pre-populated so the pipeline can
// safely skip to stage 7 (synthesis) without calling the API.
function buildResumableIdea(overrides = {}) {
  const idea = createIdea('Integration test topic');

  // Inline progress directly so we can control current_stage.
  idea.status = 'investigating';
  idea.investigation.started_at = new Date().toISOString();

  // Minimal stage 1 output (discovery).
  idea.investigation.perspective_discovery = {
    search_queries: [{ query: 'test query', results: [], error: null }],
    candidate_personas: [
      {
        id: 'p_001',
        name: 'Mock Researcher',
        role: 'Researcher',
        background: 'Academic',
        stance: 'Neutral',
        tradition: 'Empirical',
        description: 'Test.',
        research_lens: 'Empirical',
      },
    ],
    selected_persona_ids: ['p_001'],
    fixed_personas: ['skeptic', 'builder'],
  };

  // Stage 3 output (coordinator). No working-group territories means stage 4
  // has nothing to run and the pipeline moves straight to stage 5.
  idea.investigation.coordinator_decisions = {
    initial: {
      decided_at: new Date().toISOString(),
      territories: [],
    },
  };

  // Stage 4 output — empty since no territories were decomposed.
  idea.investigation.pair_debates = [];

  // Stage 5 output (cross-pollination) — empty since no surviving claims.
  idea.investigation.cross_pollination = [];

  // Stage 6 output (forum) — empty since no claims/debates.
  idea.investigation.forum = {
    constructed_at: new Date().toISOString(),
    nodes: [],
    dead_end_questions: [],
  };

  // Apply investigation overrides as a shallow merge onto the pre-populated
  // object so callers can replace specific fields without wiping the defaults.
  // Top-level overrides (status, id, etc.) merge after.
  const { investigation: investigationOverrides, ...topLevelOverrides } = overrides;
  if (investigationOverrides) {
    Object.assign(idea.investigation, investigationOverrides);
  }
  Object.assign(idea, topLevelOverrides);

  return idea;
}

// ---------------------------------------------------------------------------
// 1. Stage skip: runPipeline correctly skips stages before current_stage
// ---------------------------------------------------------------------------

// Test: the skip-guards in runPipeline prevent any API call for stages whose
// output is already present. Starting at stage 7, only synthesis should call
// the mock client. If a guard were missing, the client would receive an
// unexpected call (for a tool it's not set up for) and would either throw or
// return a wrong response, causing the test to fail.
test('runPipeline skips stages 1–6 when resuming at stage 7 (synthesis)', async () => {
  const idea = buildResumableIdea();
  idea.investigation.progress = {
    current_stage: '7_synthesis',
    working_groups: {},
  };

  await writeIdea(idea);

  const client = createMockClient();
  const callsBefore = client.callCount();

  const result = await runOne(idea, client, { cancellationToken: { requested: false } });

  assert.equal(result.ok, true,
    `run should succeed; got: ${result.error?.message ?? JSON.stringify(result)}`);

  const final = await readIdea(idea.id);
  assert.equal(final.status, 'ready');
  assert.equal(final.investigation.last_failure, null);
  assert.ok(final.investigation.synthesis, 'synthesis must be populated');
  assert.ok(final.investigation.synthesis.report, 'synthesis.report must be present');
  // `sections` is required by the synthesizer schema (minItems: 2). Asserting
  // here catches a regression that removes it from the prompt or mock without
  // having to deserialize the full structured payload.
  assert.ok(Array.isArray(final.investigation.synthesis.sections),
    'synthesis.sections must be an array');
  assert.ok(final.investigation.synthesis.sections.length >= 2,
    `synthesis.sections must have at least 2 entries; got ${final.investigation.synthesis.sections.length}`);

  // Only synthesis should have called the API. A per-tool breakdown surfaces
  // any unexpected stage call by tool name — far more diagnostic than a count.
  const breakdown = client.callsByStageSince(callsBefore);
  const unexpected = Object.keys(breakdown).filter((t) => t !== 'emit_synthesis');
  assert.deepEqual(unexpected, [],
    `unexpected tool calls when resuming at stage 7: ${JSON.stringify(breakdown)}`);
  assert.ok((breakdown.emit_synthesis ?? 0) >= 1,
    `synthesis must have been called; got: ${JSON.stringify(breakdown)}`);
});

// ---------------------------------------------------------------------------
// 1b. Truncated synthesis: partial persisted, stage not advanced, resumable
// ---------------------------------------------------------------------------

test('truncated synthesizer response leaves stage at 7_synthesis, persists partial synthesis, and is resumable', async () => {
  const idea = buildResumableIdea();
  idea.investigation.progress = {
    current_stage: '7_synthesis',
    working_groups: {},
  };
  await writeIdea(idea);

  const client = createMockClient({ truncateSynthesis: true });

  const result = await runOne(idea, client, { cancellationToken: { requested: false } });
  assert.equal(result.ok, true,
    `run should report ok even on a truncated synthesis; got: ${JSON.stringify(result)}`);

  const afterTruncation = await readIdea(idea.id);
  assert.equal(afterTruncation.investigation.synthesis.truncated, true);
  assert.equal(afterTruncation.investigation.progress.current_stage, '7_synthesis',
    'stage must not advance to complete on a truncated synthesis');
  assert.notEqual(afterTruncation.status, 'ready');
  assert.ok(afterTruncation.investigation.last_failure, 'last_failure must be populated');
  assert.equal(afterTruncation.investigation.last_failure.stage, '7_synthesis');
  // Partial data survives even though the trailing fields were cut off.
  assert.ok(Array.isArray(afterTruncation.investigation.synthesis.headline_findings));
  assert.equal(afterTruncation.investigation.synthesis.key_references, null);
  assert.equal(afterTruncation.investigation.synthesis.next_pass_proposals, null);

  // Resuming re-enters only stage 7 and this time completes normally.
  const reloaded = await readIdea(idea.id);
  const resumedClient = createMockClient();
  const callsBefore = resumedClient.callCount();
  const resumeResult = await runOne(reloaded, resumedClient, { cancellationToken: { requested: false } });
  assert.equal(resumeResult.ok, true);

  const final = await readIdea(idea.id);
  assert.equal(final.status, 'ready');
  assert.equal(final.investigation.last_failure, null);
  assert.equal(final.investigation.synthesis.truncated, false);

  const breakdown = resumedClient.callsByStageSince(callsBefore);
  const unexpected = Object.keys(breakdown).filter((t) => t !== 'emit_synthesis');
  assert.deepEqual(unexpected, [],
    `resume should only re-run synthesis; got: ${JSON.stringify(breakdown)}`);
});

// ---------------------------------------------------------------------------
// 2. Failure mid-pipeline persists last_failure with the right shape
// ---------------------------------------------------------------------------

// Test: when runPipeline throws (due to an Anthropic-side 500), runOne catches
// it, classifies it, and persists a typed last_failure record on disk. The
// resume flow reads that record to show an actionable message and pick the
// right mode (resume vs. fresh).
test('Anthropic unavailable during synthesis produces typed last_failure on disk', async () => {
  const idea = buildResumableIdea();
  idea.investigation.progress = {
    current_stage: '7_synthesis',
    working_groups: {},
  };
  idea.investigation.last_failure = null;

  await writeIdea(idea);

  // Throwing WallClockCapError directly: api_queue treats it as non-retryable
  // (no .status, no .code) so the test stays fast, and classifyError maps it
  // to 'anthropic_unavailable' via instanceof — no string-coupling.
  const client = createMockClient({ fail: { tool: 'emit_synthesis', afterCalls: 0, useWallClockMessage: true } });

  const result = await runOne(idea, client, { cancellationToken: { requested: false } });

  assert.equal(result.ok, false,
    `run should have failed; got result=${JSON.stringify(result)}`);

  const saved = await readIdea(idea.id);
  assert.ok(saved.investigation.last_failure, 'last_failure must be persisted');
  assert.equal(saved.investigation.last_failure.reason, 'anthropic_unavailable');
  assert.equal(saved.investigation.last_failure.stage, '7_synthesis');
  assert.ok(saved.investigation.last_failure.occurred_at);
  assert.ok(saved.investigation.last_failure.error_message.length > 0);
  // Status still 'investigating' — the run was not cleanly finished.
  assert.equal(saved.status, 'investigating');
});

// ---------------------------------------------------------------------------
// 3. Failed run resumes to completion
// ---------------------------------------------------------------------------

// Test: an idea left in 'investigating' state with a populated progress pointer
// can be resumed: planResume detects the anchor, runPipeline skips completed
// stages, and the run finishes as 'ready'. This verifies the full resume loop.
test('idea with investigating status resumes and reaches ready', async () => {
  // Step 1: create an idea that "failed" at stage 7 (synthesis not yet run).
  const idea = buildResumableIdea();
  idea.investigation.progress = {
    current_stage: '7_synthesis',
    working_groups: {},
  };
  idea.investigation.last_failure = {
    reason: 'anthropic_unavailable',
    stage: '7_synthesis',
    territory_id: null,
    sub_stage: null,
    error_message: 'Simulated prior failure',
    occurred_at: '2026-01-01T00:00:00.000Z',
  };
  await writeIdea(idea);

  // Step 2: re-read the idea (as runRunCommand would do) and attempt a new run.
  const reloaded = await readIdea(idea.id);
  assert.equal(reloaded.status, 'investigating');
  assert.equal(reloaded.investigation.progress.current_stage, '7_synthesis');

  const client = createMockClient();
  const result = await runOne(reloaded, client, { cancellationToken: { requested: false } });

  assert.equal(result.ok, true,
    `resume should succeed; got: ${result.error?.message ?? JSON.stringify(result)}`);

  const final = await readIdea(idea.id);
  assert.equal(final.status, 'ready');
  assert.equal(final.investigation.last_failure, null,
    'last_failure must be cleared on successful completion');
  assert.ok(final.investigation.synthesis);
  // The resumed run must produce the full structured report, including the
  // schema-required `sections` array. Guards against a regression that drops
  // the field after a resume.
  assert.ok(Array.isArray(final.investigation.synthesis.sections),
    'synthesis.sections must be an array');
  assert.ok(final.investigation.synthesis.sections.length >= 2,
    `synthesis.sections must have at least 2 entries; got ${final.investigation.synthesis.sections.length}`);
});

// ---------------------------------------------------------------------------
// 4. CancellationError from a token produces user_cancelled last_failure
// ---------------------------------------------------------------------------

// Test: when cancellationToken.requested is set to true before the pipeline
// starts, the pipeline exits at the first checkpoint and persists a
// user_cancelled last_failure. Verifies that SIGINT integration (§8.7)
// round-trips through classifyError correctly.
test('pre-set cancellationToken produces user_cancelled last_failure', async () => {
  const idea = buildResumableIdea();
  idea.investigation.progress = {
    current_stage: '7_synthesis',
    working_groups: {},
  };

  await writeIdea(idea);

  const client = createMockClient();
  const cancellationToken = { requested: true };

  const result = await runOne(idea, client, { cancellationToken });

  assert.equal(result.ok, false);

  const saved = await readIdea(idea.id);
  assert.ok(saved.investigation.last_failure);
  assert.equal(saved.investigation.last_failure.reason, 'user_cancelled');
  // The pipeline records the stage that was current at the checkpoint where
  // cancellation fired. With pre-set cancellation and current_stage = '7_synthesis',
  // synthesis runs to completion before the first checkpoint — by that point
  // current_stage has been advanced to 'complete'. Asserting the stage value
  // documents this and guards against a refactor that drops the field.
  assert.equal(saved.investigation.last_failure.stage, 'complete');
});

// ---------------------------------------------------------------------------
// 5. Stage 4 partial resume: completed territories are not re-run
// ---------------------------------------------------------------------------

// Test: an idea interrupted mid-stage-4 resumes at the correct territory
// sub-stage. Territories already marked 'complete' must not trigger new API
// calls; only the in-progress territory (starting from its last checkpoint)
// should run. This verifies the per-territory skip logic in
// runWorkingGroupsConcurrently (§8.5).
test('stage-4 resume skips completed territories and runs only pending ones', async () => {
  const idea = buildResumableIdea();

  // Override coordinator_decisions to have two territories.
  idea.investigation.coordinator_decisions = {
    initial: {
      decided_at: new Date().toISOString(),
      territories: [
        {
          id: 't_001',
          territory_id: 't_001',
          name: 'Territory One',
          description: 'First territory.',
          rationale: '',
          assigned_pair: ['skeptic', 'builder'],
          pair_distinctness_score: 0.5,
        },
        {
          id: 't_002',
          territory_id: 't_002',
          name: 'Territory Two',
          description: 'Second territory.',
          rationale: '',
          assigned_pair: ['skeptic', 'builder'],
          pair_distinctness_score: 0.5,
        },
      ],
    },
  };

  // t_001 is already complete, with a debate result.
  idea.investigation.pair_debates = [
    {
      territory_id: 't_001',
      candidate_questions: [],
      adversarial_marks: [],
      aligned_questions: [],
      researcher_reports: [],
      observations: [],
      moves: [],
      surviving_claims: [],
      terminated_by: 'budget_exhausted',
    },
  ];

  idea.investigation.progress = {
    current_stage: '4_working_groups',
    working_groups: {
      t_001: 'complete',
      t_002: 'pending',
    },
  };

  await writeIdea(idea);

  const client = createMockClient();
  const callsBefore = client.callCount();

  const result = await runOne(idea, client, { cancellationToken: { requested: false } });

  assert.equal(result.ok, true,
    `run should succeed; got: ${result.error?.message ?? JSON.stringify(result)}`);

  const final = await readIdea(idea.id);
  assert.equal(final.status, 'ready');

  // Per-tool breakdown of calls since the run started: t_001 was already
  // complete, so only t_002 should have triggered the working-group sub-stages.
  // Ideation runs runIdeation once per persona (pair of 2), so a single WG
  // produces 2 emit_candidate_questions calls; if t_001 had been re-run we
  // would see 4.
  const breakdown = client.callsByStageSince(callsBefore);
  assert.equal(breakdown.emit_candidate_questions ?? 0, 2,
    `expected 2 ideation calls (one per persona of t_002); got: ${JSON.stringify(breakdown)}`);

  // t_001's pair_debate entry must be preserved with its original distinctive
  // field intact — verifies the entry was not overwritten by a fresh mock run.
  const preserved = final.investigation.pair_debates.find((d) => d.territory_id === 't_001');
  assert.equal(preserved?.terminated_by, 'budget_exhausted',
    't_001 pair_debate must be preserved unchanged (terminated_by lost)');
  assert.ok(
    final.investigation.pair_debates.find((d) => d.territory_id === 't_002'),
    't_002 pair_debate must have been created by the run'
  );
});
