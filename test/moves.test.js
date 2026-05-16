const test = require('node:test');
const assert = require('node:assert/strict');

const {
  CALCIFICATION_REBUT_THRESHOLD,
  CONCESSION_FLOOR,
  PAIR_MOVE_BUDGET,
  checkCalcification,
  classifyClaimConcession,
  computeConfidenceAfterDebate,
  detectConcessionTermination,
  extractSurvivingClaims,
  moveId,
  validateMoveList,
  validateMoveShape,
  validateDebateMove,
} = require('../src/moves');

test('moveId pads sequence', () => {
  assert.equal(moveId('sq_001', 1), 'm_sq_001_0001');
  assert.equal(moveId('sq_010', 42), 'm_sq_010_0042');
});

test('validateMoveShape accepts a well-formed Claim', () => {
  const result = validateMoveShape({
    type: 'Claim',
    content: 'A good claim',
    evidence_basis: 'prior knowledge of the domain',
    confidence: 7,
    references_move_id: null,
  });
  assert.equal(result.valid, true);
});

test('validateMoveShape rejects reaction with non-reaction type', () => {
  const result = validateMoveShape(
    {
      type: 'Support',
      content: 'support',
      evidence_basis: 'reasoning',
      confidence: 6,
    },
    { reactionOnly: true }
  );
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((e) => e.includes('Invalid type')));
});

test('validateMoveShape catches all common errors', () => {
  const result = validateMoveShape({
    type: 'Claim',
    content: '',
    evidence_basis: '',
    confidence: 11,
  });
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((e) => e.includes('content must be a non-empty string')));
  assert.ok(result.errors.some((e) => e.includes('evidence_basis must be a non-empty string')));
  assert.ok(result.errors.some((e) => e.includes('confidence must be a number between 0 and 10')));
});

test('validateMoveList aggregates per-index errors', () => {
  const result = validateMoveList([
    { type: 'Claim', content: 'ok', evidence_basis: 'reasoning', confidence: 8 },
    { type: 'Claim', content: '', evidence_basis: 'reasoning', confidence: -1 },
  ]);
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((e) => e.startsWith('[1]')));
});

function makeMove(overrides) {
  return {
    move_id: 'placeholder',
    by_persona_id: 'a',
    type: 'Claim',
    content: 'placeholder',
    evidence_basis: 'reasoning',
    confidence: 5,
    references_move_id: null,
    timestamp: new Date().toISOString(),
    ...overrides,
  };
}

test('checkCalcification fires when a high-confidence Rebut goes unaddressed for 2 turns', () => {
  const history = [
    makeMove({ move_id: 'm1', by_persona_id: 'a', type: 'Claim', confidence: 6 }),
    makeMove({
      move_id: 'm2',
      by_persona_id: 'b',
      type: 'Rebut',
      confidence: 9,
      references_move_id: 'm1',
    }),
    makeMove({ move_id: 'm3', by_persona_id: 'a', type: 'Claim', confidence: 6 }),
    makeMove({ move_id: 'm4', by_persona_id: 'b', type: 'Support', confidence: 5, references_move_id: 'm2' }),
    makeMove({ move_id: 'm5', by_persona_id: 'a', type: 'Claim', confidence: 5 }),
  ];
  const result = checkCalcification(history, 'a');
  assert.equal(result.fired, true);
  assert.equal(result.rebut.move_id, 'm2');
});

test('checkCalcification does not fire when persona already conceded the Rebut', () => {
  const history = [
    makeMove({ move_id: 'm1', by_persona_id: 'a', type: 'Claim', confidence: 6 }),
    makeMove({
      move_id: 'm2',
      by_persona_id: 'b',
      type: 'Rebut',
      confidence: 9,
      references_move_id: 'm1',
    }),
    makeMove({
      move_id: 'm3',
      by_persona_id: 'a',
      type: 'Concede',
      confidence: 6,
      references_move_id: 'm2',
    }),
    makeMove({ move_id: 'm4', by_persona_id: 'a', type: 'Claim', confidence: 5 }),
  ];
  const result = checkCalcification(history, 'a');
  assert.equal(result.fired, false);
});

test('checkCalcification does not fire when persona counter-Rebutted the unaddressed Rebut', () => {
  const history = [
    makeMove({ move_id: 'm1', by_persona_id: 'a', type: 'Claim', confidence: 6 }),
    makeMove({
      move_id: 'm2',
      by_persona_id: 'b',
      type: 'Rebut',
      confidence: 9,
      references_move_id: 'm1',
    }),
    makeMove({
      move_id: 'm3',
      by_persona_id: 'a',
      type: 'Rebut',
      confidence: 7,
      references_move_id: 'm2',
    }),
    makeMove({ move_id: 'm4', by_persona_id: 'a', type: 'Claim', confidence: 5 }),
  ];
  const result = checkCalcification(history, 'a');
  assert.equal(result.fired, false);
});

test('checkCalcification does not fire when only one persona turn has elapsed after the Rebut', () => {
  const history = [
    makeMove({ move_id: 'm1', by_persona_id: 'a', type: 'Claim', confidence: 6 }),
    makeMove({
      move_id: 'm2',
      by_persona_id: 'b',
      type: 'Rebut',
      confidence: 9,
      references_move_id: 'm1',
    }),
    makeMove({ move_id: 'm3', by_persona_id: 'a', type: 'Claim', confidence: 5 }),
  ];
  const result = checkCalcification(history, 'a');
  assert.equal(result.fired, false);
});

test('checkCalcification does not fire when the Rebut confidence is below threshold', () => {
  const history = [
    makeMove({ move_id: 'm1', by_persona_id: 'a', type: 'Claim', confidence: 6 }),
    makeMove({
      move_id: 'm2',
      by_persona_id: 'b',
      type: 'Rebut',
      confidence: 7, // one below CALCIFICATION_REBUT_THRESHOLD
      references_move_id: 'm1',
    }),
    makeMove({ move_id: 'm3', by_persona_id: 'a', type: 'Claim', confidence: 5 }),
    makeMove({ move_id: 'm4', by_persona_id: 'b', type: 'Support', confidence: 5, references_move_id: 'm2' }),
    makeMove({ move_id: 'm5', by_persona_id: 'a', type: 'Claim', confidence: 5 }),
  ];
  const result = checkCalcification(history, 'a');
  assert.equal(result.fired, false);
});

test('classifyClaimConcession marks full, partial, and none correctly', () => {
  const claim = makeMove({ move_id: 'c1', type: 'Claim', confidence: 7 });
  const support = makeMove({
    move_id: 's1',
    type: 'Support',
    references_move_id: 'c1',
    confidence: 6,
  });

  const fullMoves = [claim, makeMove({ move_id: 'x1', type: 'Concede', references_move_id: 'c1' })];
  assert.equal(classifyClaimConcession(claim, fullMoves).status, 'full');

  const partialMoves = [
    claim,
    support,
    makeMove({ move_id: 'x2', type: 'Concede', references_move_id: 's1' }),
  ];
  assert.equal(classifyClaimConcession(claim, partialMoves).status, 'partial');

  const noneMoves = [claim, support];
  assert.equal(classifyClaimConcession(claim, noneMoves).status, 'none');
});

test('computeConfidenceAfterDebate clamps to [0, 10] and caps direct supports at 3', () => {
  const claim = makeMove({ move_id: 'c1', type: 'Claim', confidence: 9 });
  const supports = [1, 2, 3, 4].map((n) =>
    makeMove({
      move_id: `s${n}`,
      type: 'Support',
      references_move_id: 'c1',
      confidence: 5,
    })
  );
  // base 9 + 0.5 * min(4, 3) = 10.5, clamped to 10
  const high = computeConfidenceAfterDebate(claim, [claim, ...supports]);
  assert.equal(high.confidence, 10);
  assert.equal(high.directSupports, 4);

  // base 0 + partial concession -1, clamped to 0
  const zeroClaim = makeMove({ move_id: 'c2', type: 'Claim', confidence: 0 });
  const zeroSupport = makeMove({
    move_id: 's5',
    type: 'Support',
    references_move_id: 'c2',
    confidence: 3,
  });
  const concedeSupport = makeMove({
    move_id: 'x5',
    type: 'Concede',
    references_move_id: 's5',
  });
  const low = computeConfidenceAfterDebate(zeroClaim, [zeroClaim, zeroSupport, concedeSupport]);
  // 0 + 0.5 - 1 = -0.5, clamped to 0
  assert.equal(low.confidence, 0);
  assert.equal(low.status, 'partial');
});

test('computeConfidenceAfterDebate applies Support and partial-concession adjustments', () => {
  const claim = makeMove({ move_id: 'c1', type: 'Claim', confidence: 6 });
  const support1 = makeMove({
    move_id: 's1',
    type: 'Support',
    references_move_id: 'c1',
    confidence: 5,
  });
  const support2 = makeMove({
    move_id: 's2',
    type: 'Support',
    references_move_id: 'c1',
    confidence: 5,
  });
  const concede = makeMove({
    move_id: 'x1',
    type: 'Concede',
    references_move_id: 's1',
  });

  const result = computeConfidenceAfterDebate(claim, [claim, support1, support2, concede]);
  // base 6 + 0.5 * 2 supports = 7, minus 1 (partial) = 6
  assert.equal(result.confidence, 6);
  assert.equal(result.status, 'partial');
});

test('extractSurvivingClaims excludes fully conceded claims', () => {
  const claim1 = makeMove({ move_id: 'c1', type: 'Claim', confidence: 7 });
  const claim2 = makeMove({ move_id: 'c2', type: 'Claim', confidence: 6 });
  const concede = makeMove({
    move_id: 'x1',
    type: 'Concede',
    references_move_id: 'c1',
  });
  const surviving = extractSurvivingClaims([claim1, claim2, concede]);
  assert.equal(surviving.length, 1);
  assert.equal(surviving[0].originating_move_id, 'c2');
});

test('detectConcessionTermination requires concession floor', () => {
  const a = makeMove({ move_id: 'm1', by_persona_id: 'a', type: 'Concede' });
  const b = makeMove({ move_id: 'm2', by_persona_id: 'b', type: 'Concede' });
  assert.equal(detectConcessionTermination([a, b]), false);
  const moves = [
    makeMove({ move_id: 'm0a', by_persona_id: 'a', type: 'Claim' }),
    makeMove({ move_id: 'm0b', by_persona_id: 'b', type: 'Claim' }),
    a,
    b,
  ];
  assert.equal(moves.length >= CONCESSION_FLOOR, true);
  assert.equal(detectConcessionTermination(moves), true);
});

test('PAIR_MOVE_BUDGET and CALCIFICATION_REBUT_THRESHOLD match spec', () => {
  assert.equal(PAIR_MOVE_BUDGET, 12);
  assert.equal(CALCIFICATION_REBUT_THRESHOLD, 8);
  assert.equal(CONCESSION_FLOOR, 4);
});

// --- validateDebateMove (v5) ---

function makeDebateClaim(overrides = {}) {
  return {
    type: 'Claim',
    content: 'Test claim',
    evidence_basis: 'Some basis',
    confidence: 7,
    references_move_id: null,
    evidence_refs: [{ observation_id: 'o_001' }, { finding_id: 'f_001' }],
    ...overrides,
  };
}

// Test: a valid debate Claim with required observation_id and finding_id passes validation.
test('validateDebateMove accepts a Claim with valid observation and finding refs', () => {
  const move = makeDebateClaim();
  const scope = {
    observations: [{ observation_id: 'o_001' }],
    findings: [{ finding_id: 'f_001' }],
  };
  const result = validateDebateMove(move, scope);
  assert.ok(result.valid, `Should be valid but errors: ${result.errors.join('; ')}`);
});

// Test: a Claim without any evidence_refs is rejected — v5 requires both obs + finding.
test('validateDebateMove rejects Claim missing evidence_refs entirely', () => {
  const move = makeDebateClaim({ evidence_refs: undefined });
  const scope = {
    observations: [{ observation_id: 'o_001' }],
    findings: [{ finding_id: 'f_001' }],
  };
  const result = validateDebateMove(move, scope);
  assert.ok(!result.valid);
  assert.ok(result.errors.some((e) => e.includes('observation_id')));
  assert.ok(result.errors.some((e) => e.includes('finding_id')));
});

// Test: a Claim with an observation_id but no finding_id is rejected.
test('validateDebateMove rejects Claim with observation but no finding ref', () => {
  const move = makeDebateClaim({ evidence_refs: [{ observation_id: 'o_001' }] });
  const scope = {
    observations: [{ observation_id: 'o_001' }],
    findings: [{ finding_id: 'f_001' }],
  };
  const result = validateDebateMove(move, scope);
  assert.ok(!result.valid);
  assert.ok(result.errors.some((e) => e.includes('finding_id')));
});

// Test: a reference to an observation_id not in scope is rejected.
test('validateDebateMove rejects refs that do not resolve in pair scope', () => {
  const move = makeDebateClaim({
    evidence_refs: [{ observation_id: 'o_UNKNOWN' }, { finding_id: 'f_001' }],
  });
  const scope = {
    observations: [{ observation_id: 'o_001' }],
    findings: [{ finding_id: 'f_001' }],
  };
  const result = validateDebateMove(move, scope);
  assert.ok(!result.valid);
  assert.ok(result.errors.some((e) => e.includes('o_UNKNOWN')));
});

// Test: Support/Rebut/Question/Concede moves are not subject to the evidence_refs rule.
test('validateDebateMove accepts Support move without evidence_refs', () => {
  const move = {
    type: 'Support',
    content: 'I agree',
    evidence_basis: 'Prior knowledge',
    confidence: 5,
    references_move_id: 'm_001',
  };
  const scope = { observations: [], findings: [] };
  const result = validateDebateMove(move, scope);
  assert.ok(result.valid, `Should be valid but errors: ${result.errors.join('; ')}`);
});

// Test: a combined-ref entry { observation_id, finding_id } satisfies both checks.
// This is a likely LLM output shape — the validator must accept it without confusion.
test('validateDebateMove accepts a single combined { observation_id, finding_id } ref', () => {
  const move = makeDebateClaim({
    evidence_refs: [{ observation_id: 'o_001', finding_id: 'f_001' }],
  });
  const scope = {
    observations: [{ observation_id: 'o_001' }],
    findings: [{ finding_id: 'f_001' }],
  };
  const result = validateDebateMove(move, scope);
  assert.ok(result.valid, `Should be valid but errors: ${result.errors.join('; ')}`);
});

// Test: duplicate refs do not produce duplicate errors — they should be tolerated.
test('validateDebateMove tolerates duplicate refs', () => {
  const move = makeDebateClaim({
    evidence_refs: [
      { observation_id: 'o_001' },
      { observation_id: 'o_001' },
      { finding_id: 'f_001' },
    ],
  });
  const scope = {
    observations: [{ observation_id: 'o_001' }],
    findings: [{ finding_id: 'f_001' }],
  };
  const result = validateDebateMove(move, scope);
  assert.ok(result.valid);
});
