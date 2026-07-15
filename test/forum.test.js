const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// Redirect ~/.msv to a temp dir so appendLog calls (from judgeContradiction)
// don't touch the real filesystem.
const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'forum-test-'));
process.env.MSV_ROOT = path.join(tmpHome, '.msv');
fs.mkdirSync(path.join(process.env.MSV_ROOT, 'ideas', 'i_test', 'logs'), { recursive: true });

const {
  applyReactionEffect,
  buildBaseNodes,
  buildDeadEndQuestions,
  contradictionKey,
  judgeContradiction,
} = require('../src/forum');

// Minimal mock Anthropic client: `handler` receives the raw params passed to
// messages.create and returns the mock response. Mirrors the pattern used in
// test/nicknamer.test.js's makeClient.
function makeClient(handler) {
  let callCount = 0;
  return {
    callCount: () => callCount,
    messages: {
      create: async (params) => {
        callCount += 1;
        return handler(params, callCount);
      },
    },
  };
}

function makeNodePair() {
  const a = { node_id: 'n_001', working_group_id: 't_001', aggregate_confidence: 7, content: 'Claim A' };
  const b = { node_id: 'n_002', working_group_id: 't_002', aggregate_confidence: 5, content: 'Claim B' };
  return { a, b };
}

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
// --- Bus emit contract test ---
//
// aggregateForum is LLM-driven (judgeContradiction calls client.messages.create
// per pair). A full integration test would require mocking that surface for
// every pair × every contradiction. Per the spec's pragmatic stance, a
// grep-based contract test catches the most-likely regression — a developer
// deleting one of the required emit sites — without running the pipeline.
test('forum.js emits forum.contradiction.judged and forum.done', () => {
  const forumSrc = fs.readFileSync(
    path.join(__dirname, '..', 'src', 'forum.js'),
    'utf8'
  );
  assert.match(
    forumSrc,
    /bus\.emit\(\s*['"]forum\.contradiction\.judged['"]/,
    `forum.js no longer emits 'forum.contradiction.judged' — spec §10.6 regression`
  );
  assert.match(
    forumSrc,
    /bus\.emit\(\s*['"]forum\.done['"]/,
    `forum.js no longer emits 'forum.done' — spec §10.6 regression`
  );
});

// --- judgeContradiction truncation handling ---

test('judgeContradiction passes maxTokens=1200 to the API call', async () => {
  let capturedMaxTokens;
  const client = makeClient((params) => {
    capturedMaxTokens = params.max_tokens;
    return {
      stop_reason: 'tool_use',
      content: [
        {
          type: 'tool_use',
          id: 'mock_1',
          name: 'emit_contradiction_judgement',
          input: { contradicts: true, reason: 'They disagree on scope.' },
        },
      ],
      usage: { input_tokens: 10, output_tokens: 10 },
    };
  });
  const { a, b } = makeNodePair();
  const result = await judgeContradiction({ client, model: 'mock-model', budget: null, idea: { id: 'i_test' }, a, b });
  assert.equal(capturedMaxTokens, 1200);
  assert.equal(result.contradicts, true);
  assert.equal(result.reason, 'They disagree on scope.');
});

test('judgeContradiction retries once and recovers when the first call is truncated with toolUse: null', async () => {
  const client = makeClient((params, callCount) => {
    if (callCount === 1) {
      // Simulates max_tokens hit before the forced tool_use block ever
      // appeared: runModelCall returns toolUse: null in this case.
      return {
        stop_reason: 'max_tokens',
        content: [{ type: 'text', text: 'thinking...' }],
        usage: { input_tokens: 10, output_tokens: 10 },
      };
    }
    return {
      stop_reason: 'tool_use',
      content: [
        {
          type: 'tool_use',
          id: 'mock_2',
          name: 'emit_contradiction_judgement',
          input: { contradicts: false, reason: 'No real conflict.' },
        },
      ],
      usage: { input_tokens: 10, output_tokens: 10 },
    };
  });
  const { a, b } = makeNodePair();
  const result = await judgeContradiction({ client, model: 'mock-model', budget: null, idea: { id: 'i_test' }, a, b });
  assert.equal(client.callCount(), 2, 'expected exactly one retry after the truncated first call');
  assert.equal(result.contradicts, false);
  assert.equal(result.reason, 'No real conflict.');
});

test('judgeContradiction falls back to contradicts:false when both attempts are truncated (toolUse: null)', async () => {
  const client = makeClient(() => ({
    stop_reason: 'max_tokens',
    content: [{ type: 'text', text: 'thinking...' }],
    usage: { input_tokens: 10, output_tokens: 10 },
  }));
  const { a, b } = makeNodePair();
  const result = await judgeContradiction({ client, model: 'mock-model', budget: null, idea: { id: 'i_test' }, a, b });
  assert.equal(client.callCount(), 2, 'expected one retry, then a fallback without a third call');
  assert.equal(result.contradicts, false, 'must not silently propagate a broken judgement as a genuine verdict');
  assert.match(result.reason, /truncated/i);
});

test('judgeContradiction falls back to contradicts:false when toolUse.input is missing required fields due to truncation', async () => {
  const client = makeClient(() => ({
    stop_reason: 'max_tokens',
    content: [
      {
        type: 'tool_use',
        id: 'mock_3',
        name: 'emit_contradiction_judgement',
        // Cut off mid-JSON: `contradicts` landed but `reason` never did.
        input: { contradicts: true },
      },
    ],
    usage: { input_tokens: 10, output_tokens: 10 },
  }));
  const { a, b } = makeNodePair();
  const result = await judgeContradiction({ client, model: 'mock-model', budget: null, idea: { id: 'i_test' }, a, b });
  assert.equal(client.callCount(), 2, 'expected one retry before falling back');
  assert.equal(result.contradicts, false, 'must not trust a partially-truncated input as a genuine contradiction');
  assert.match(result.reason, /truncated/i);
});

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
