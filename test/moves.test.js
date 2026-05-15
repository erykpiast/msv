const test = require('node:test');
const assert = require('node:assert/strict');

const { validateMove } = require('../src/moves');

test('validateMove accepts valid debate move', () => {
  const result = validateMove({
    move_type: 'Claim',
    content: 'A good claim',
    evidence_basis: 'first_principles_reasoning',
    confidence: 7,
  });

  assert.equal(result.valid, true);
  assert.deepEqual(result.errors, []);
});

test('validateMove enforces reaction-only move restrictions', () => {
  const result = validateMove(
    {
      move_type: 'Support',
      content: 'I support this',
      evidence_basis: 'expert_consensus',
      confidence: 6,
    },
    { reactionOnly: true }
  );

  assert.equal(result.valid, false);
  assert.ok(result.errors.some((error) => error.includes('Invalid move_type')));
});
