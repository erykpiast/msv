const MOVE_TYPES = ['Claim', 'Support', 'Rebut', 'Question', 'Concede'];
const REACTION_MOVE_TYPES = ['Rebut', 'Question', 'Concede'];
const EVIDENCE_BASIS = [
  'first_principles_reasoning',
  'historical_case',
  'empirical_study',
  'expert_consensus',
  'web_source',
  'anecdotal',
];

const MOVE_SCHEMA = {
  type: 'object',
  required: ['move_type', 'content', 'evidence_basis', 'confidence'],
  additionalProperties: false,
  properties: {
    move_type: {
      type: 'string',
      enum: MOVE_TYPES,
    },
    content: {
      type: 'string',
      minLength: 1,
    },
    evidence_basis: {
      type: 'string',
      enum: EVIDENCE_BASIS,
    },
    confidence: {
      type: 'number',
      minimum: 0,
      maximum: 10,
    },
  },
};

function validateMove(move, { reactionOnly = false } = {}) {
  if (!move || typeof move !== 'object') {
    return { valid: false, errors: ['Move must be an object'] };
  }

  const errors = [];
  for (const key of MOVE_SCHEMA.required) {
    if (!(key in move)) {
      errors.push(`Missing required field: ${key}`);
    }
  }

  const moveTypes = reactionOnly ? REACTION_MOVE_TYPES : MOVE_TYPES;
  if (!moveTypes.includes(move.move_type)) {
    errors.push(`Invalid move_type: ${move.move_type}`);
  }

  if (typeof move.content !== 'string' || move.content.trim().length === 0) {
    errors.push('content must be a non-empty string');
  }

  if (!EVIDENCE_BASIS.includes(move.evidence_basis)) {
    errors.push(`Invalid evidence_basis: ${move.evidence_basis}`);
  }

  if (typeof move.confidence !== 'number' || move.confidence < 0 || move.confidence > 10) {
    errors.push('confidence must be a number between 0 and 10');
  }

  const extraKeys = Object.keys(move).filter((key) => !Object.prototype.hasOwnProperty.call(MOVE_SCHEMA.properties, key));
  if (extraKeys.length > 0) {
    errors.push(`Unexpected fields: ${extraKeys.join(', ')}`);
  }

  return {
    valid: errors.length === 0,
    errors,
  };
}

function validateMoveList(moves, options = {}) {
  if (!Array.isArray(moves)) {
    return { valid: false, errors: ['moves must be an array'] };
  }

  const errors = [];
  moves.forEach((move, index) => {
    const result = validateMove(move, options);
    if (!result.valid) {
      errors.push(`[${index}] ${result.errors.join('; ')}`);
    }
  });

  return {
    valid: errors.length === 0,
    errors,
  };
}

module.exports = {
  MOVE_TYPES,
  REACTION_MOVE_TYPES,
  EVIDENCE_BASIS,
  MOVE_SCHEMA,
  validateMove,
  validateMoveList,
};
