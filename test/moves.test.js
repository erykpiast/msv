const test = require('node:test');
const assert = require('node:assert/strict');

const { validateMove, validateMoveList } = require('../src/moves');

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

test('validateMove rejects malformed moves with edge-case errors', () => {
  const result = validateMove({
    move_type: 'Claim',
    content: '',
    evidence_basis: 'unknown_basis',
    confidence: 11,
    unexpected: true,
  });

  assert.equal(result.valid, false);
  assert.ok(result.errors.some((error) => error.includes('content must be a non-empty string')));
  assert.ok(result.errors.some((error) => error.includes('Invalid evidence_basis')));
  assert.ok(result.errors.some((error) => error.includes('confidence must be a number between 0 and 10')));
  assert.ok(result.errors.some((error) => error.includes('Unexpected fields')));
});

test('validateMoveList validates arrays and aggregates indexed errors', () => {
  const result = validateMoveList([
    {
      move_type: 'Claim',
      content: 'valid',
      evidence_basis: 'expert_consensus',
      confidence: 8,
    },
    {
      move_type: 'Support',
      content: '',
      evidence_basis: 'invalid',
      confidence: -1,
    },
  ]);

  assert.equal(result.valid, false);
  assert.ok(result.errors.length > 0);
  assert.ok(result.errors.some((error) => error.startsWith('[1]')));
});
