const test = require('node:test');
const assert = require('node:assert/strict');

const { applyReactionEffect, buildBaseNodes, contradictionKey } = require('../src/forum');

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
