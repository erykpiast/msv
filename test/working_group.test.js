const { test } = require('node:test');
const assert = require('node:assert/strict');
const { selectAlignedQuestions } = require('../src/working_group');

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
