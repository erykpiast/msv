const test = require('node:test');
const assert = require('node:assert/strict');

const { applyReactionEffect, buildBaseNodes, buildDeadEndQuestions, contradictionKey } = require('../src/forum');

test('buildBaseNodes seeds nodes from surviving claims with full initial state', () => {
  const debates = [
    {
      sub_question_id: 'sq_001',
      surviving_claims: [
        {
          claim_id: 'c_m_sq_001_0001_001',
          content: 'Claim A',
          confidence_after_debate: 7,
          concession_status: 'none',
        },
      ],
    },
    {
      sub_question_id: 'sq_002',
      surviving_claims: [
        {
          claim_id: 'c_m_sq_002_0001_001',
          content: 'Claim B',
          confidence_after_debate: 5,
          concession_status: 'partial',
        },
      ],
    },
  ];
  const map = buildBaseNodes(debates);
  const nodes = [...map.values()];
  assert.equal(nodes.length, 2);
  const nodeA = nodes.find((n) => n.content === 'Claim A');
  assert.equal(nodeA.working_group_id, 'sq_001');
  assert.equal(nodeA.aggregate_confidence, 7);
  assert.equal(nodeA.has_open_question, false);
  // Initial state per spec §5.6: rank assigned by aggregateForum, reactions empty.
  assert.equal(nodeA.survival_rank, null);
  assert.deepEqual(nodeA.reactions, []);
  assert.equal(nodeA.contradiction_with_node_id, null);
  // node_id is sequential with 3-digit padding
  assert.match(nodeA.node_id, /^n_\d{3}$/);
});

test('applyReactionEffect drops confidence by 2 on strong Rebut (conf >= 6)', () => {
  const node = { aggregate_confidence: 7, has_open_question: false };
  applyReactionEffect(node, { type: 'Rebut', confidence: 8 });
  assert.equal(node.aggregate_confidence, 5);
});

test('applyReactionEffect treats Rebut at exactly conf=6 as strong (-2)', () => {
  const node = { aggregate_confidence: 7, has_open_question: false };
  applyReactionEffect(node, { type: 'Rebut', confidence: 6 });
  assert.equal(node.aggregate_confidence, 5);
});

test('applyReactionEffect treats Rebut at conf=5 as weak (-0.5)', () => {
  const node = { aggregate_confidence: 7, has_open_question: false };
  applyReactionEffect(node, { type: 'Rebut', confidence: 5 });
  assert.equal(node.aggregate_confidence, 6.5);
});

test('applyReactionEffect drops confidence less on weak Rebut', () => {
  const node = { aggregate_confidence: 7, has_open_question: false };
  applyReactionEffect(node, { type: 'Rebut', confidence: 4 });
  assert.equal(node.aggregate_confidence, 6.5);
});

test('applyReactionEffect flags has_open_question on Question without confidence change', () => {
  const node = { aggregate_confidence: 6, has_open_question: false };
  applyReactionEffect(node, { type: 'Question', confidence: 7 });
  assert.equal(node.aggregate_confidence, 6);
  assert.equal(node.has_open_question, true);
});

test('applyReactionEffect adds 1 on Concede and clamps to 10', () => {
  const node = { aggregate_confidence: 9.5, has_open_question: false };
  applyReactionEffect(node, { type: 'Concede', confidence: 5 });
  assert.equal(node.aggregate_confidence, 10);
});

test('applyReactionEffect clamps to 0 on strong Rebut against weak claim', () => {
  const node = { aggregate_confidence: 1, has_open_question: false };
  applyReactionEffect(node, { type: 'Rebut', confidence: 8 });
  assert.equal(node.aggregate_confidence, 0);
});

test('contradictionKey is order-independent', () => {
  const a = { claim_id: 'c_one' };
  const b = { claim_id: 'c_two' };
  assert.equal(contradictionKey(a, b), contradictionKey(b, a));
});

// --- buildDeadEndQuestions (v5) ---

// Test: researcher-level dead_end outcome is propagated to dead_end_questions.
// This ensures the forum reflects research that returned no usable findings.
test('buildDeadEndQuestions includes researcher dead-ends', () => {
  const pairDebates = [
    {
      territory_id: 't_001',
      terminated_by: 'mutual_concession',
      aligned_questions: [
        { aligned_id: 'aq_001', question: 'What?', origin: 'aligned', source_candidate_ids: ['cq_001'] },
        { aligned_id: 'aq_002', question: 'How?', origin: 'aligned', source_candidate_ids: ['cq_002'] },
      ],
      researcher_reports: [
        { aligned_id: 'aq_001', outcome: 'useful', search_trace: ['q1', 'q2'] },
        { aligned_id: 'aq_002', outcome: 'dead_end', search_trace: ['q3'] },
      ],
    },
  ];
  const result = buildDeadEndQuestions(pairDebates);
  assert.equal(result.length, 1, 'only the dead_end report produces a dead_end_question entry');
  assert.equal(result[0].aligned_id, 'aq_002');
  assert.equal(result[0].territory_id, 't_001');
  assert.ok(result[0].outcome_summary.includes('dead_end'));
});

// Test: pair-level abort (all_dead_end) propagates all aligned questions as dead ends.
test('buildDeadEndQuestions includes all aligned questions when pair aborts with all_dead_end', () => {
  const pairDebates = [
    {
      territory_id: 't_002',
      terminated_by: 'all_dead_end',
      aligned_questions: [
        { aligned_id: 'aq_010', question: 'Q1', origin: 'aligned', source_candidate_ids: ['cq_010'] },
        { aligned_id: 'aq_011', question: 'Q2', origin: 'minority_p1', source_candidate_ids: ['cq_011'] },
      ],
      researcher_reports: [],
    },
  ];
  const result = buildDeadEndQuestions(pairDebates);
  assert.equal(result.length, 2, 'both aligned questions become dead ends on pair abort');
  const ids = result.map((d) => d.aligned_id);
  assert.ok(ids.includes('aq_010'));
  assert.ok(ids.includes('aq_011'));
  assert.ok(result.every((d) => d.outcome_summary.includes('all_dead_end')));
});

// Test: v4 pairs (no territory_id) are skipped — dead-end processing only applies to v5.
test('buildDeadEndQuestions skips v4 pairs without territory_id', () => {
  const pairDebates = [
    {
      sub_question_id: 'sq_001', // v4 shape — no territory_id
      terminated_by: 'move_budget',
      surviving_claims: [],
      researcher_reports: [{ outcome: 'dead_end' }],
    },
  ];
  const result = buildDeadEndQuestions(pairDebates);
  assert.equal(result.length, 0, 'v4 pairs should produce no dead_end_questions');
});

// Test: useful and partial researcher outcomes do not appear in dead_end_questions.
test('buildDeadEndQuestions excludes useful and partial outcomes', () => {
  const pairDebates = [
    {
      territory_id: 't_003',
      terminated_by: 'mutual_concession',
      aligned_questions: [
        { aligned_id: 'aq_020', question: 'A', origin: 'aligned', source_candidate_ids: ['cq_020'] },
        { aligned_id: 'aq_021', question: 'B', origin: 'aligned', source_candidate_ids: ['cq_021'] },
      ],
      researcher_reports: [
        { aligned_id: 'aq_020', outcome: 'useful', search_trace: [] },
        { aligned_id: 'aq_021', outcome: 'partial', search_trace: [] },
      ],
    },
  ];
  const result = buildDeadEndQuestions(pairDebates);
  assert.equal(result.length, 0, 'useful and partial outcomes are not dead ends');
});

// Test: ideation_failure and alignment_failure pair-level aborts also propagate to dead ends.
test('buildDeadEndQuestions includes all aligned questions when pair aborts with ideation_failure', () => {
  const pairDebates = [
    {
      territory_id: 't_004',
      terminated_by: 'ideation_failure',
      aligned_questions: [
        { aligned_id: 'aq_030', question: 'Q', origin: 'aligned', source_candidate_ids: ['cq_030'] },
      ],
      researcher_reports: [],
    },
  ];
  const result = buildDeadEndQuestions(pairDebates);
  assert.equal(result.length, 1);
  assert.ok(result[0].outcome_summary.includes('ideation_failure'));
});

test('buildDeadEndQuestions includes all aligned questions when pair aborts with alignment_failure', () => {
  const pairDebates = [
    {
      territory_id: 't_005',
      terminated_by: 'alignment_failure',
      aligned_questions: [
        { aligned_id: 'aq_040', question: 'Q', origin: 'aligned', source_candidate_ids: ['cq_040'] },
      ],
      researcher_reports: [],
    },
  ];
  const result = buildDeadEndQuestions(pairDebates);
  assert.equal(result.length, 1);
  assert.ok(result[0].outcome_summary.includes('alignment_failure'));
});

// Test: a researcher report referencing an aligned_id that doesn't resolve in
// the pair shouldn't crash — the dead-end entry should still be emitted.
test('buildDeadEndQuestions tolerates dangling aligned_id refs in researcher reports', () => {
  const pairDebates = [
    {
      territory_id: 't_006',
      terminated_by: 'mutual_concession',
      aligned_questions: [
        { aligned_id: 'aq_050', question: 'A', origin: 'aligned', source_candidate_ids: ['cq_050'] },
      ],
      researcher_reports: [
        { aligned_id: 'aq_PHANTOM', outcome: 'dead_end', search_trace: [] },
      ],
    },
  ];
  const result = buildDeadEndQuestions(pairDebates);
  assert.equal(result.length, 1);
  assert.equal(result[0].aligned_id, 'aq_PHANTOM');
});
