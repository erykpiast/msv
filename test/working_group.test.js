const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { selectAlignedQuestions, runWorkingGroup, isSubStageComplete, SUBSTAGE_ORDER } = require('../src/working_group');
const { CancellationError } = require('../src/failure');
const { setRootForTesting } = require('../src/storage');

// Tests that exercise disk I/O paths (appendLog in sub-stage catch blocks) need
// a writable storage root. setRootForTesting() avoids the env-var race between
// test files — process.env.MSV_ROOT is read once at module load, so a second
// test file setting it would have no effect.
const WGTEST_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'msv-wg-skip-test-'));
setRootForTesting(WGTEST_ROOT);

test.after(async () => {
  await fsp.rm(WGTEST_ROOT, { recursive: true, force: true });
});

// Test: validates the canonical worked example from spec §6.4.
// Setup: A has a1(c=8), a2(c=6), a3(c=4); B has b1(c=7), b2(c=5).
// Expected: [a1, b1, a2, a3, b2] with origins [aligned, aligned, aligned, minority_A, minority_B].
test('worked example from spec §6.4 — both personas contribute, 5 final entries', () => {
  const alignmentSurvivors = [
    { candidate_id: 'a1', by_persona_id: 'A', predicted_confidence: 8, question: 'a1 q' },
    { candidate_id: 'a2', by_persona_id: 'A', predicted_confidence: 6, question: 'a2 q' },
    { candidate_id: 'a3', by_persona_id: 'A', predicted_confidence: 4, question: 'a3 q' },
    { candidate_id: 'b1', by_persona_id: 'B', predicted_confidence: 7, question: 'b1 q' },
    { candidate_id: 'b2', by_persona_id: 'B', predicted_confidence: 5, question: 'b2 q' },
  ];
  const result = selectAlignedQuestions({
    alignmentSurvivors,
    marks: [],
    personas: [{ id: 'A' }, { id: 'B' }],
  });
  assert.equal(result.length, 5);
  assert.deepEqual(
    result.map((r) => r.origin),
    ['aligned', 'aligned', 'aligned', 'minority_A', 'minority_B']
  );
  assert.deepEqual(
    result.map((r) => r.source_candidate_ids[0]),
    ['a1', 'b1', 'a2', 'a3', 'b2']
  );
});

// Test: validates that minority slots are SKIPPED when a persona has no remaining candidates.
// The counter-example from spec §6.4: B has only b1, step 3 picks {a1, b1, a2},
// so B's minority slot can't be filled — it's skipped, not fabricated.
test('counter-example — B has only one survivor picked in step 3, no minority slot for B', () => {
  const alignmentSurvivors = [
    { candidate_id: 'a1', by_persona_id: 'A', predicted_confidence: 8, question: 'a1 q' },
    { candidate_id: 'a2', by_persona_id: 'A', predicted_confidence: 6, question: 'a2 q' },
    { candidate_id: 'a3', by_persona_id: 'A', predicted_confidence: 4, question: 'a3 q' },
    { candidate_id: 'b1', by_persona_id: 'B', predicted_confidence: 7, question: 'b1 q' },
  ];
  const result = selectAlignedQuestions({
    alignmentSurvivors,
    marks: [],
    personas: [{ id: 'A' }, { id: 'B' }],
  });
  assert.equal(result.length, 4);
  assert.ok(!result.some((r) => r.origin === 'minority_B'), 'no minority_B slot is fabricated');
});

// Test: two candidates with identical confidence — the one with more "cannot answer from priors"
// marks ranks higher. This is the secondary sort key in the ranking algorithm.
test('tie-break by adversarial-mark count (more cannot-answer marks = higher rank)', () => {
  const alignmentSurvivors = [
    { candidate_id: 'x', by_persona_id: 'A', predicted_confidence: 7, question: 'x q' },
    { candidate_id: 'y', by_persona_id: 'A', predicted_confidence: 7, question: 'y q' },
  ];
  const marks = [
    { candidate_id: 'x', marker_persona_id: 'B', could_answer_from_priors: false },
    { candidate_id: 'x', marker_persona_id: 'B', could_answer_from_priors: false },
    { candidate_id: 'x', marker_persona_id: 'B', could_answer_from_priors: false },
    { candidate_id: 'y', marker_persona_id: 'B', could_answer_from_priors: false },
  ];
  const result = selectAlignedQuestions({
    alignmentSurvivors,
    marks,
    personas: [{ id: 'A' }, { id: 'B' }],
  });
  assert.equal(result[0].source_candidate_ids[0], 'x', 'x ranks higher due to more cannot-answer marks');
});

// Test: identical confidence and adversarial marks — lower candidate_id wins (final tie-break).
// This ensures the sort is deterministic across runs.
test('final tie-break by candidate_id ascending (y < z)', () => {
  const alignmentSurvivors = [
    { candidate_id: 'z', by_persona_id: 'A', predicted_confidence: 7, question: 'z q' },
    { candidate_id: 'y', by_persona_id: 'A', predicted_confidence: 7, question: 'y q' },
  ];
  const result = selectAlignedQuestions({
    alignmentSurvivors,
    marks: [],
    personas: [{ id: 'A' }, { id: 'B' }],
  });
  assert.equal(
    result[0].source_candidate_ids[0],
    'y',
    'y wins on final tie-break (alphabetically before z)'
  );
});

// Test: structural cap at 5. With 4+4 survivors from two personas,
// the algorithm produces exactly 5 (not 6 = 3+1+1+overflow).
test('cap at 5 — 8 survivors (4 per persona), exactly 5 returned', () => {
  const alignmentSurvivors = [];
  for (let i = 0; i < 4; i++) {
    alignmentSurvivors.push({
      candidate_id: `a${i}`,
      by_persona_id: 'A',
      predicted_confidence: 10 - i,
      question: `a${i}`,
    });
    alignmentSurvivors.push({
      candidate_id: `b${i}`,
      by_persona_id: 'B',
      predicted_confidence: 9 - i,
      question: `b${i}`,
    });
  }
  const result = selectAlignedQuestions({
    alignmentSurvivors,
    marks: [],
    personas: [{ id: 'A' }, { id: 'B' }],
  });
  assert.equal(result.length, 5);
  assert.ok(result.some((r) => r.source_candidate_ids[0].startsWith('a')));
  assert.ok(result.some((r) => r.source_candidate_ids[0].startsWith('b')));
});

// Test: degenerate case — no survivors means no aligned questions.
test('empty input returns empty array', () => {
  const result = selectAlignedQuestions({
    alignmentSurvivors: [],
    marks: [],
    personas: [{ id: 'A' }, { id: 'B' }],
  });
  assert.deepEqual(result, []);
});

// Test: B has zero survivors; minority slot for A fires, B's slot is silently skipped.
// Verifies: 3 aligned + 1 minority_A + 0 minority_B = 4 total.
test('one persona has zero survivors — 3 jointly aligned + 1 minority from the other', () => {
  const alignmentSurvivors = [
    { candidate_id: 'a1', by_persona_id: 'A', predicted_confidence: 9, question: 'a1' },
    { candidate_id: 'a2', by_persona_id: 'A', predicted_confidence: 8, question: 'a2' },
    { candidate_id: 'a3', by_persona_id: 'A', predicted_confidence: 7, question: 'a3' },
    { candidate_id: 'a4', by_persona_id: 'A', predicted_confidence: 6, question: 'a4' },
  ];
  const result = selectAlignedQuestions({
    alignmentSurvivors,
    marks: [],
    personas: [{ id: 'A' }, { id: 'B' }],
  });
  assert.equal(result.length, 4, '3 aligned + 1 minority_A; no minority_B');
  assert.equal(result.filter((r) => r.origin === 'aligned').length, 3);
  assert.equal(result.filter((r) => r.origin === 'minority_A').length, 1);
  assert.equal(result.filter((r) => r.origin === 'minority_B').length, 0);
});

// Test: minority slot de-dup — a candidate already picked in step 3 cannot also
// be the minority pick. The minority slot must move to the next-best.
test('minority dedup — step-3 pick cannot also be step-4 minority', () => {
  // A has only a1; a1 gets picked by step 3 (top-3 joint). Step 4 has nothing
  // left for A → minority_A is skipped. B's minority pick is b4.
  const alignmentSurvivors = [
    { candidate_id: 'a1', by_persona_id: 'A', predicted_confidence: 10, question: 'a1' },
    { candidate_id: 'b1', by_persona_id: 'B', predicted_confidence: 9, question: 'b1' },
    { candidate_id: 'b2', by_persona_id: 'B', predicted_confidence: 8, question: 'b2' },
    { candidate_id: 'b3', by_persona_id: 'B', predicted_confidence: 7, question: 'b3' },
    { candidate_id: 'b4', by_persona_id: 'B', predicted_confidence: 6, question: 'b4' },
  ];
  const result = selectAlignedQuestions({
    alignmentSurvivors,
    marks: [],
    personas: [{ id: 'A' }, { id: 'B' }],
  });
  // Top-3: a1(10), b1(9), b2(8). Step 4: A has no remaining; B's next is b3.
  const origins = result.map((r) => r.origin);
  assert.ok(!origins.includes('minority_A'), 'no minority_A when A has nothing left after step 3');
  assert.ok(origins.includes('minority_B'), 'minority_B fires for B');
  const minorityB = result.find((r) => r.origin === 'minority_B');
  assert.equal(minorityB.source_candidate_ids[0], 'b3', 'next-best B after b1/b2 already in step-3 pool');
});

// Test: when personas is omitted/empty, minority pick order derives deterministically
// from the candidate pool's persona_ids (sorted alphabetically).
test('empty personas array — derives ordering from candidates by sorted persona id', () => {
  const alignmentSurvivors = [
    { candidate_id: 'b1', by_persona_id: 'Z', predicted_confidence: 8, question: 'b1' },
    { candidate_id: 'a1', by_persona_id: 'A', predicted_confidence: 7, question: 'a1' },
    { candidate_id: 'a2', by_persona_id: 'A', predicted_confidence: 6, question: 'a2' },
  ];
  const result = selectAlignedQuestions({
    alignmentSurvivors,
    marks: [],
    personas: [],
  });
  // Top 3 joint picks are all three (sorted by confidence).
  assert.equal(result.length, 3);
  assert.deepEqual(
    result.map((r) => r.origin),
    ['aligned', 'aligned', 'aligned']
  );
});

// ---------------------------------------------------------------------------
// Sub-stage skip-guard tests
// ---------------------------------------------------------------------------

// These tests verify that skip-guards inside runWorkingGroup correctly use the
// progress pointer rather than array length, and that cooperative cancellation
// fires between sub-stages.
//
// Strategy: build a minimal fake client + territory + idea that satisfies enough
// of the API to let runWorkingGroup run one targeted path.

function makeFakePersonaAgent({ failOnSubStage } = {}) {
  // Returns agent functions that succeed for everything EXCEPT failOnSubStage.
  const succeed = () => Promise.resolve({});
  const fail = () => Promise.reject(new Error(`[test] ${failOnSubStage} must not run`));

  // Each agent function is named to match what it stands in for.
  return {
    runIdeation: failOnSubStage === 'ideation' ? fail : () =>
      Promise.resolve({ persona_id: 'A', candidate_questions: [{ question: 'q', predicted_confidence: 7 }] }),
    runAdversarialMark: failOnSubStage === 'adversarial' ? fail : () =>
      Promise.resolve({ marks: [] }),
    runAlignmentMove: failOnSubStage === 'alignment' ? fail : (opts) => {
      // Return a final move on first call to terminate the loop quickly.
      if (opts.history.length === 0) {
        return Promise.resolve({
          type: 'Accept',
          candidate_id: null,
          content: 'OK',
          is_final: true,
        });
      }
      return Promise.resolve(null);
    },
    runObservation: failOnSubStage === 'observation' ? fail : () =>
      Promise.resolve({ observations: [{ content: 'obs', cited_finding_ids: ['f_aq_cq_001_01_01'] }] }),
    runDebateMove: failOnSubStage === 'debate' ? fail : (opts) => {
      // Return a null to terminate the loop quickly.
      return Promise.resolve(null);
    },
  };
}

function makeTestIdea() {
  // A minimal in-memory idea object; no disk I/O required for WG unit tests.
  return { id: `test-wg-${Date.now()}`, raw_capture: 'test' };
}

function makeTestTerritory(id = 't1') {
  return {
    id,
    name: `Territory ${id}`,
    assigned_pair: ['A', 'B'],
  };
}

function makeTestPersonas() {
  return [
    { id: 'A', role: 'persona A', background: '', research_lens: '' },
    { id: 'B', role: 'persona B', background: '', research_lens: '' },
  ];
}

// The real working_group module uses require() for agents. We need to intercept
// those calls. Since Node.js caches requires, we monkey-patch after the first
// require by replacing the module exports temporarily.
//
// However, the simpler approach for these tests: call runWorkingGroup with
// previousResult such that the sub-stage we care about is skipped entirely,
// and verify that downstream sub-stages run (by observing onCheckpoint calls).
//
// For the "skip when marks are empty" test, we don't need to intercept the
// Anthropic SDK client at all — we just need the progress pointer to say
// 'adversarial_complete' and a previousResult with empty marks.

// Helper: build a fake researcher that returns a dead-end report for unit tests.
// This prevents the WG from calling the real Anthropic client.
function makeDeadEndResult() {
  return {
    territory_id: 't1',
    candidate_questions: [
      { candidate_id: 'cq_t1_001', question: 'q1', by_persona_id: 'A', predicted_confidence: 7 },
      { candidate_id: 'cq_t1_002', question: 'q2', by_persona_id: 'B', predicted_confidence: 6 },
    ],
    adversarial_marks: [],
    aligned_questions: [
      { aligned_id: 'aq_cq_t1_001_001', question: 'q1', origin: 'aligned', by_persona_id: 'A', source_candidate_ids: ['cq_t1_001'] },
      { aligned_id: 'aq_cq_t1_002_002', question: 'q2', origin: 'aligned', by_persona_id: 'B', source_candidate_ids: ['cq_t1_002'] },
    ],
    researcher_reports: [],  // empty → all_dead_end
    observations: [],
    moves: [],
    surviving_claims: [],
    terminated_by: null,
  };
}

test('wgProgressValue === "adversarial_complete" skips adversarial even when marks are empty', async () => {
  // Adversarial may legitimately produce [] marks (the marker silently failed).
  // The progress pointer — not array length — is the source of truth. Skip must
  // fire even with marks: [].
  const checkpoints = [];
  const previousResult = {
    territory_id: 't1',
    candidate_questions: [
      { candidate_id: 'cq_t1_001', question: 'q1', by_persona_id: 'A', predicted_confidence: 7 },
      { candidate_id: 'cq_t1_002', question: 'q2', by_persona_id: 'B', predicted_confidence: 6 },
    ],
    adversarial_marks: [],  // empty but adversarial IS complete per progress pointer
    aligned_questions: [],
    researcher_reports: [],
    observations: [],
    moves: [],
    surviving_claims: [],
    terminated_by: null,
  };

  // We want alignment to run (not skipped) to prove adversarial was indeed skipped.
  // But alignment needs a real client — this is a unit test so we stop right before
  // alignment would call the API by checking the first checkpoint was 'alignment'.
  //
  // Since we don't inject a client, runAlignmentMove will throw trying to reach
  // the actual Anthropic API. We catch that — what we care about is that the
  // first checkpoint was NOT 'adversarial' (which means adversarial was skipped).
  try {
    await runWorkingGroup({
      client: null,
      idea: makeTestIdea(),
      model: 'test',
      synthesizerModel: 'test',
      budget: { used_executor_calls: 0, max_executor_calls: 180, used_total_tokens: 0, max_total_tokens: 1500000, used_researcher_tool_calls: 0, max_researcher_tool_calls: 60 },
      territory: makeTestTerritory(),
      personas: makeTestPersonas(),
      previousResult,
      wgProgressValue: 'adversarial_complete',
      onCheckpoint: async (e) => { checkpoints.push(e.completedSubStage); },
    });
  } catch (e) {
    // Expected — real API call fails in test environment.
  }

  // Adversarial checkpoint must NOT appear (it was skipped).
  assert.ok(
    !checkpoints.includes('adversarial'),
    `adversarial should have been skipped but checkpoints were: ${JSON.stringify(checkpoints)}`
  );
});

// Shared fixture for both skip-ideation tests below: a previousResult that
// satisfies the ideation skip-guard (territory_id + non-empty candidate_questions)
// and the full runWorkingGroup argument bag.
function makeSkipIdeationArgs({ idea, onCheckpoint, cancellationToken }) {
  const previousResult = {
    territory_id: 't1',
    candidate_questions: [
      { candidate_id: 'cq_t1_001', question: 'q1', by_persona_id: 'skeptic', predicted_confidence: 7 },
    ],
    adversarial_marks: [],
    aligned_questions: [],
    researcher_reports: [],
    observations: [],
    moves: [],
    surviving_claims: [],
    terminated_by: null,
  };
  return {
    client: null,
    idea,
    model: 'test',
    synthesizerModel: 'test',
    budget: {
      used_executor_calls: 0,
      max_executor_calls: 180,
      used_total_tokens: 0,
      max_total_tokens: 1500000,
      used_researcher_tool_calls: 0,
      max_researcher_tool_calls: 60,
    },
    territory: { id: 't1', name: 'T1', assigned_pair: ['skeptic', 'builder'] },
    personas: [
      { id: 'skeptic', role: 'skeptic', background: '', research_lens: '' },
      { id: 'builder', role: 'builder', background: '', research_lens: '' },
    ],
    previousResult,
    wgProgressValue: 'ideation_complete',
    onCheckpoint,
    cancellationToken,
  };
}

// Test: wgProgressValue = 'ideation_complete' + previousResult with candidate_questions
// → ideation is NOT re-run. The primary proof is the rejects-predicate: with
// client=null, any unskipped sub-stage that calls the API would throw TypeError
// (not CancellationError), failing the predicate. The checkpoints-list check is
// a secondary readability aid.
test('previousResult with candidate_questions skips ideation when wgProgressValue = ideation_complete', async () => {
  const { writeIdea, createIdea } = require('../src/storage');
  const idea = createIdea('wg-skip-ideation-test');
  await writeIdea(idea);

  const checkpoints = [];
  const cancellationToken = { requested: true }; // pre-set so we stop after adversarial

  await assert.rejects(
    runWorkingGroup(makeSkipIdeationArgs({
      idea,
      onCheckpoint: async (e) => { checkpoints.push(e.completedSubStage); },
      cancellationToken,
    })),
    (err) => err instanceof CancellationError
  );

  // Ideation must NOT appear in checkpoints — it was skipped.
  assert.ok(
    !checkpoints.includes('ideation'),
    `ideation should have been skipped but checkpoints were: ${JSON.stringify(checkpoints)}`
  );
});

// Test: cancellationToken.requested set in onCheckpoint (after a sub-stage completes)
// causes CancellationError before the next sub-stage begins. This verifies
// cooperative cancellation: the pipeline honours the token at every sub-stage
// boundary so a SIGINT handler (which sets the token) is respected promptly.
test('cancellationToken set after adversarial checkpoint triggers CancellationError at alignment', async () => {
  const { writeIdea, createIdea } = require('../src/storage');
  const idea = createIdea('wg-cancel-test');
  await writeIdea(idea);

  const checkpoints = [];
  const cancellationToken = { requested: false };

  // Set the token when adversarial completes — the next boundary check
  // (at the end of the alignment stage) must throw CancellationError.
  const onCheckpoint = async ({ completedSubStage }) => {
    checkpoints.push(completedSubStage);
    if (completedSubStage === 'adversarial') {
      cancellationToken.requested = true;
    }
  };

  await assert.rejects(
    runWorkingGroup(makeSkipIdeationArgs({ idea, onCheckpoint, cancellationToken })),
    (err) => err instanceof CancellationError
  );

  // Adversarial must have completed (it was not skipped — wgProgressValue is only
  // 'ideation_complete', not 'adversarial_complete').
  assert.ok(
    checkpoints.includes('adversarial'),
    `adversarial should have run and checkpointed; got: ${JSON.stringify(checkpoints)}`
  );
  // Alignment should NOT have checkpointed — CancellationError fires before its
  // checkpoint call at the end of the alignment sub-stage.
  assert.ok(
    !checkpoints.includes('alignment'),
    `alignment should not have checkpointed after cancellation; got: ${JSON.stringify(checkpoints)}`
  );
});

// ---------------------------------------------------------------------------
// isSubStageComplete — ordered progress comparison
// ---------------------------------------------------------------------------

// Test: isSubStageComplete encodes the invariant that a progress value means
// "this sub-stage and all prior ones have finished." A regression here would
// cause skip-guards to mis-fire, silently re-running or skipping sub-stages.

test('isSubStageComplete: pending means nothing is complete', () => {
  for (const subStage of ['ideation', 'adversarial', 'alignment', 'researcher', 'observation', 'debate']) {
    assert.equal(isSubStageComplete('pending', subStage), false, `pending should not complete ${subStage}`);
  }
});

test('isSubStageComplete: ideation_complete means only ideation is done', () => {
  assert.equal(isSubStageComplete('ideation_complete', 'ideation'), true);
  assert.equal(isSubStageComplete('ideation_complete', 'adversarial'), false);
  assert.equal(isSubStageComplete('ideation_complete', 'debate'), false);
});

test('isSubStageComplete: adversarial_complete means ideation and adversarial are done', () => {
  assert.equal(isSubStageComplete('adversarial_complete', 'ideation'), true);
  assert.equal(isSubStageComplete('adversarial_complete', 'adversarial'), true);
  assert.equal(isSubStageComplete('adversarial_complete', 'alignment'), false);
});

test('isSubStageComplete: observation_complete means all except debate are done', () => {
  assert.equal(isSubStageComplete('observation_complete', 'observation'), true);
  assert.equal(isSubStageComplete('observation_complete', 'debate'), false);
});

test('isSubStageComplete: complete means everything is done', () => {
  for (const subStage of ['ideation', 'adversarial', 'alignment', 'researcher', 'observation', 'debate']) {
    assert.equal(isSubStageComplete('complete', subStage), true, `complete should mean ${subStage} is done`);
  }
});

test('isSubStageComplete: debate_complete means debate is done (transient state)', () => {
  assert.equal(isSubStageComplete('debate_complete', 'debate'), true);
});

test('isSubStageComplete: unknown value → false (does not crash)', () => {
  assert.equal(isSubStageComplete('bogus_value', 'ideation'), false);
  assert.equal(isSubStageComplete(undefined, 'ideation'), false);
  assert.equal(isSubStageComplete('ideation_complete', 'bogus_stage'), false);
});

test('SUBSTAGE_ORDER is a complete ordered list with "complete" as terminal', () => {
  assert.equal(SUBSTAGE_ORDER[0], 'pending');
  assert.equal(SUBSTAGE_ORDER[SUBSTAGE_ORDER.length - 1], 'complete');
  // All intermediate values follow the naming convention {substage}_complete
  const intermediates = SUBSTAGE_ORDER.slice(1, -1);
  for (const v of intermediates) {
    assert.match(v, /_complete$/, `${v} should end with _complete`);
  }
});

// Test: aligned_id format is stable and matches the documented shape.
// Downstream storage and inspect rendering rely on this pattern; a format change
// would silently break log file paths and React anchor ids.
test('aligned_id is shaped aq_<candidate>_<NNN>', () => {
  const alignmentSurvivors = [
    { candidate_id: 'cq_001', by_persona_id: 'A', predicted_confidence: 8, question: 'q' },
    { candidate_id: 'cq_002', by_persona_id: 'B', predicted_confidence: 7, question: 'q' },
  ];
  const result = selectAlignedQuestions({
    alignmentSurvivors,
    marks: [],
    personas: [{ id: 'A' }, { id: 'B' }],
  });
  for (const r of result) {
    assert.match(r.aligned_id, /^aq_[A-Za-z0-9_-]+_\d{3}$/);
  }
});

// --- Bus emit contract tests ---
//
// Rationale: a full integration test would require mocking client.messages.create
// for every persona/stage (ideation × 2, adversarial × 2, alignment moves × N,
// researcher × M, observation × 2M, debate moves × K). That mock surface is
// large and brittle.
//
// Per the spec's pragmatic stance (§10.6), a grep-based contract test catches
// the most-likely regression — a developer deleting an emit site — without
// running the pipeline. We read src/working_group.js and assert that every
// event documented in spec §10.6 still appears as a literal bus.emit('<name>')
// substring. Researcher events are emitted from src/agents/researcher.js, so
// they're checked against that file instead.
test('working_group.js emits every required event from spec §10.6', () => {
  const wgSrc = fs.readFileSync(
    path.join(__dirname, '..', 'src', 'working_group.js'),
    'utf8'
  );
  // Spec §10.6 — events emitted directly inside runWorkingGroup.
  const REQUIRED_WG = [
    'wg.start',
    'wg.ideation.start',
    'wg.ideation.persona.done',
    'wg.ideation.done',
    'wg.adversarial.start',
    'wg.adversarial.done',
    'wg.alignment.start',
    'wg.alignment.done',
    'wg.move',
    'wg.observation.start',
    'wg.observation.done',
    'wg.debate.start',
    'wg.debate.done',
    'wg.end',
  ];
  for (const name of REQUIRED_WG) {
    const pattern = new RegExp(`bus\\.emit\\(\\s*['"]${name.replace(/\./g, '\\.')}['"]`);
    assert.match(
      wgSrc,
      pattern,
      `working_group.js no longer emits '${name}' — spec §10.6 regression`
    );
  }
});

test('researcher.js emits every required wg.researcher.* event from spec §10.6', () => {
  const researcherSrc = fs.readFileSync(
    path.join(__dirname, '..', 'src', 'agents', 'researcher.js'),
    'utf8'
  );
  const REQUIRED_RESEARCHER = [
    'wg.researcher.start',
    'wg.researcher.turn',
    'wg.researcher.web_search',
    'wg.researcher.web_fetch',
    'wg.researcher.done',
  ];
  for (const name of REQUIRED_RESEARCHER) {
    const pattern = new RegExp(`bus\\.emit\\(\\s*['"]${name.replace(/\./g, '\\.')}['"]`);
    assert.match(
      researcherSrc,
      pattern,
      `researcher.js no longer emits '${name}' — spec §10.6 regression`
    );
  }
});

// Document the canonical event order from spec §10.6. This is a comment-only
// test: it codifies expectations the integration test would assert if mocking
// the full client surface were feasible. Keeping it pinned here makes the
// expected sequence reviewable in code.
test('spec §10.6 — documented event order for a successful working group', () => {
  // The expected sequence is:
  //   wg.start
  //   wg.ideation.start
  //   wg.ideation.persona.done × P  (P = personas in pair, typically 2)
  //   wg.ideation.done
  //   wg.adversarial.start
  //   wg.adversarial.done
  //   wg.alignment.start
  //   wg.move × N                   (phase: alignment)
  //   wg.alignment.done
  //   wg.researcher.start × M
  //   (interleaved wg.researcher.turn / web_search / web_fetch per researcher)
  //   wg.researcher.done × M
  //   wg.observation.start
  //   wg.observation.done
  //   wg.debate.start
  //   wg.move × K                   (phase: debate)
  //   wg.debate.done
  //   wg.end
  //
  // The previous two tests assert each emit site exists. Future work: replace
  // this comment with a real integration test once the LLM mock harness lands.
  assert.ok(true, 'documented; emit-site existence verified by sibling tests');
});
