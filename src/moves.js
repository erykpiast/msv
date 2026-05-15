const MOVE_TYPES = ['Claim', 'Support', 'Rebut', 'Question', 'Concede'];
const REACTION_MOVE_TYPES = ['Rebut', 'Question', 'Concede'];

const PAIR_MOVE_BUDGET = 12;
const CONCESSION_FLOOR = 4;
const CALCIFICATION_REBUT_THRESHOLD = 8;
const CALCIFICATION_UNADDRESSED_TURNS = 2;

const MOVE_JSON_SCHEMA = {
  type: 'object',
  required: ['type', 'content', 'evidence_basis', 'confidence'],
  additionalProperties: false,
  properties: {
    type: {
      type: 'string',
      enum: MOVE_TYPES,
      description: 'One of Claim, Support, Rebut, Question, Concede.',
    },
    content: {
      type: 'string',
      minLength: 1,
      description: 'The argument text, 1–4 sentences.',
    },
    evidence_basis: {
      type: 'string',
      minLength: 1,
      description:
        'A brief articulation of what the confidence rests on — prior knowledge, a search result, a reasoning chain, or speculation. Must be filled before confidence.',
    },
    confidence: {
      type: 'integer',
      minimum: 0,
      maximum: 10,
      description:
        'Integer 0–10. 8+ requires concrete evidence_basis. 3 or below is appropriate for speculation.',
    },
    references_move_id: {
      type: ['string', 'null'],
      description:
        'The move_id of a prior move this one responds to. Null for Claim. Required for Support/Rebut/Question/Concede.',
    },
  },
};

const REACTION_JSON_SCHEMA = {
  type: 'object',
  required: ['type', 'content', 'evidence_basis', 'confidence', 'references_claim_id'],
  additionalProperties: false,
  properties: {
    type: {
      type: 'string',
      enum: REACTION_MOVE_TYPES,
      description: 'One of Rebut, Question, Concede. No new Claims.',
    },
    content: {
      type: 'string',
      minLength: 1,
    },
    evidence_basis: {
      type: 'string',
      minLength: 1,
    },
    confidence: {
      type: 'integer',
      minimum: 0,
      maximum: 10,
    },
    references_claim_id: {
      type: 'string',
      minLength: 1,
      description: 'The claim_id of the surviving claim being reacted to.',
    },
  },
};

function moveId(subQuestionId, sequence) {
  const padded = String(sequence).padStart(4, '0');
  return `m_${subQuestionId}_${padded}`;
}

function isClaimMove(move) {
  return move && move.type === 'Claim';
}

function validateMoveShape(move, { reactionOnly = false } = {}) {
  if (!move || typeof move !== 'object') {
    return { valid: false, errors: ['Move must be an object'] };
  }

  const errors = [];
  const allowed = reactionOnly ? REACTION_MOVE_TYPES : MOVE_TYPES;

  if (!allowed.includes(move.type)) {
    errors.push(`Invalid type: ${JSON.stringify(move.type)}`);
  }
  if (typeof move.content !== 'string' || move.content.trim().length === 0) {
    errors.push('content must be a non-empty string');
  }
  if (typeof move.evidence_basis !== 'string' || move.evidence_basis.trim().length === 0) {
    errors.push('evidence_basis must be a non-empty string');
  }
  if (
    typeof move.confidence !== 'number' ||
    !Number.isFinite(move.confidence) ||
    move.confidence < 0 ||
    move.confidence > 10
  ) {
    errors.push('confidence must be a number between 0 and 10');
  }

  return { valid: errors.length === 0, errors };
}

function validateMoveList(moves, options = {}) {
  if (!Array.isArray(moves)) {
    return { valid: false, errors: ['moves must be an array'] };
  }
  const errors = [];
  moves.forEach((move, index) => {
    const result = validateMoveShape(move, options);
    if (!result.valid) {
      errors.push(`[${index}] ${result.errors.join('; ')}`);
    }
  });
  return { valid: errors.length === 0, errors };
}

function findMoveById(moves, id) {
  return moves.find((m) => m.move_id === id);
}

function checkCalcification(history, activePersonaId) {
  if (!Array.isArray(history) || history.length === 0) {
    return { fired: false };
  }

  let unaddressedRebut = null;
  for (let i = history.length - 1; i >= 0; i -= 1) {
    const move = history[i];
    if (
      move.type === 'Rebut' &&
      move.by_persona_id !== activePersonaId &&
      typeof move.confidence === 'number' &&
      move.confidence >= CALCIFICATION_REBUT_THRESHOLD &&
      move.references_move_id
    ) {
      const target = findMoveById(history, move.references_move_id);
      if (target && target.by_persona_id === activePersonaId) {
        unaddressedRebut = move;
        break;
      }
    }
  }
  if (!unaddressedRebut) {
    return { fired: false };
  }

  const rebutIndex = history.indexOf(unaddressedRebut);
  const personaMovesAfter = history
    .slice(rebutIndex + 1)
    .filter((m) => m.by_persona_id === activePersonaId);

  if (personaMovesAfter.length < CALCIFICATION_UNADDRESSED_TURNS) {
    return { fired: false };
  }

  const addressed = personaMovesAfter.some(
    (m) =>
      (m.type === 'Concede' || m.type === 'Rebut') &&
      m.references_move_id === unaddressedRebut.move_id
  );
  if (addressed) {
    return { fired: false };
  }

  return { fired: true, rebut: unaddressedRebut };
}

function classifyClaimConcession(claim, moves) {
  if (!claim) {
    return { status: 'none', directSupports: 0 };
  }
  const directSupports = moves.filter(
    (m) => m.type === 'Support' && m.references_move_id === claim.move_id
  );
  const fullConcede = moves.find(
    (m) => m.type === 'Concede' && m.references_move_id === claim.move_id
  );
  if (fullConcede) {
    return { status: 'full', directSupports: directSupports.length };
  }
  const partialConcede = moves.some((m) =>
    m.type === 'Concede' && directSupports.some((s) => s.move_id === m.references_move_id)
  );
  return {
    status: partialConcede ? 'partial' : 'none',
    directSupports: directSupports.length,
  };
}

function computeConfidenceAfterDebate(claim, moves) {
  const { status, directSupports } = classifyClaimConcession(claim, moves);
  let conf = Number(claim.confidence) || 0;
  conf += 0.5 * Math.min(directSupports, 3);
  if (status === 'partial') {
    conf -= 1;
  }
  conf = Math.max(0, Math.min(10, conf));
  return { confidence: conf, status, directSupports };
}

function extractSurvivingClaims(moves) {
  const claims = moves.filter(isClaimMove);
  const surviving = [];
  let counter = 0;
  for (const claim of claims) {
    const { confidence, status } = computeConfidenceAfterDebate(claim, moves);
    if (status === 'full') {
      continue;
    }
    counter += 1;
    surviving.push({
      claim_id: `c_${claim.move_id}_${String(counter).padStart(3, '0')}`,
      originating_move_id: claim.move_id,
      content: claim.content,
      confidence_after_debate: Number(confidence.toFixed(2)),
      concession_status: status,
    });
  }
  return surviving;
}

function detectConcessionTermination(moves) {
  if (moves.length < CONCESSION_FLOOR) {
    return false;
  }
  // Find last move authored by each persona; if both are Concede on the *other*
  // persona's most recent meaningful move, terminate.
  const personas = [...new Set(moves.map((m) => m.by_persona_id))];
  if (personas.length !== 2) {
    return false;
  }
  for (const persona of personas) {
    const personaMoves = moves.filter((m) => m.by_persona_id === persona);
    const lastMove = personaMoves[personaMoves.length - 1];
    if (!lastMove || lastMove.type !== 'Concede') {
      return false;
    }
  }
  return true;
}

module.exports = {
  MOVE_TYPES,
  REACTION_MOVE_TYPES,
  PAIR_MOVE_BUDGET,
  CONCESSION_FLOOR,
  CALCIFICATION_REBUT_THRESHOLD,
  CALCIFICATION_UNADDRESSED_TURNS,
  MOVE_JSON_SCHEMA,
  REACTION_JSON_SCHEMA,
  moveId,
  validateMoveShape,
  validateMoveList,
  findMoveById,
  checkCalcification,
  classifyClaimConcession,
  computeConfidenceAfterDebate,
  extractSurvivingClaims,
  detectConcessionTermination,
};
