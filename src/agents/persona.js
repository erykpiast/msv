const { runStructuredCall } = require('../anthropic');
const {
  PERSONA_DEBATE,
  PERSONA_OPENING_OVERLAY,
  PERSONA_IDEATION,
  PERSONA_ADVERSARIAL,
  ALIGNMENT_DEBATE,
  PERSONA_OBSERVATION,
  CROSS_POLLINATION,
} = require('./prompts');
const {
  MOVE_JSON_SCHEMA,
  REACTION_JSON_SCHEMA,
  IDEATION_JSON_SCHEMA,
  ADVERSARIAL_MARK_JSON_SCHEMA,
  ALIGNMENT_JSON_SCHEMA,
  ALIGNMENT_MOVE_TYPES,
  OBSERVATION_JSON_SCHEMA,
  PAIR_MOVE_BUDGET,
  moveId,
  validateMoveShape,
  validateDebateMove,
  findMoveById,
  checkCalcification,
  extractSurvivingClaims,
  detectConcessionTermination,
} = require('../moves');
const { appendLog } = require('../storage');

const EMIT_MOVE_TOOL = {
  name: 'emit_move',
  description:
    'Emit your move as JSON. Always invoke this tool — never respond with free-form text.',
  input_schema: MOVE_JSON_SCHEMA,
};

const EMIT_REACTION_TOOL = {
  name: 'emit_reaction',
  description: 'Emit your single reaction to a claim from another working group.',
  input_schema: REACTION_JSON_SCHEMA,
};

function buildSystemPrompt(basePrompt, persona, overlays = []) {
  const parts = [basePrompt, '\n---\n', `Your role: ${persona.name}`];
  if (persona.tradition) parts.push(`Tradition: ${persona.tradition}`);
  if (persona.stance) parts.push(`Stance: ${persona.stance}`);
  parts.push(`Role description: ${persona.description}`);
  for (const overlay of overlays) {
    if (overlay) parts.push(`\n---\n${overlay}`);
  }
  return parts.join('\n');
}

function summarizeHistoryForPrompt(history) {
  if (!history.length) {
    return '(no prior moves)';
  }
  return history
    .map(
      (m) =>
        `${m.move_id} [${m.by_persona_id} · ${m.type} · conf=${m.confidence}${
          m.references_move_id ? ` · refs ${m.references_move_id}` : ''
        }] ${m.content}`
    )
    .join('\n');
}

// Builds the "your previous response was cut off" clause appended to rejection
// feedback when max_tokens truncation is the likely cause of the rejection.
// `detail` names what got cut off and how to recover (varies per call site);
// returns '' when not truncated so it drops cleanly out of the surrounding
// error template. Shared by every emit_* retry site in this file.
function truncationNote(truncated, detail) {
  return truncated ? ` Your previous response was cut off (max_tokens) before ${detail}.` : '';
}

function buildRejectionFeedback(attempt, toolName, rawInput, errorText) {
  const id = `rejected-${toolName}-${attempt}`;
  return [
    {
      role: 'assistant',
      content: [
        {
          type: 'tool_use',
          id,
          name: toolName,
          input: rawInput,
        },
      ],
    },
    {
      role: 'user',
      content: [
        {
          type: 'tool_result',
          tool_use_id: id,
          content: errorText,
          is_error: true,
        },
      ],
    },
  ];
}

function validateContextualMove(rawMove, { history, constrainedRebut, allowedTypes }) {
  const shape = validateMoveShape(rawMove);
  if (!shape.valid) {
    return shape;
  }
  const errors = [];
  if (allowedTypes && !allowedTypes.includes(rawMove.type)) {
    errors.push(
      `Move type ${rawMove.type} not allowed this turn (required: ${allowedTypes.join(' or ')})`
    );
  }
  if (constrainedRebut && rawMove.references_move_id !== constrainedRebut.move_id) {
    errors.push(
      `Calcification requires references_move_id=${constrainedRebut.move_id}, got ${rawMove.references_move_id}`
    );
  }
  if (rawMove.type === 'Claim' && rawMove.references_move_id) {
    errors.push('Claim must not set references_move_id');
  }
  if (rawMove.type !== 'Claim' && !rawMove.references_move_id) {
    errors.push(`${rawMove.type} requires references_move_id`);
  }
  if (rawMove.references_move_id) {
    const target = findMoveById(history, rawMove.references_move_id);
    if (!target) {
      errors.push(`references_move_id ${rawMove.references_move_id} not found in transcript`);
    }
  }
  return { valid: errors.length === 0, errors };
}

async function emitOneMove({
  client,
  idea,
  model,
  budget,
  persona,
  subQuestion,
  history,
  isOpening,
  allowedTypes,
  constrainedRebut,
  logFile,
  attempt,
  feedbackMessages,
}) {
  const overlays = [];
  if (isOpening) overlays.push(PERSONA_OPENING_OVERLAY);
  const system = buildSystemPrompt(PERSONA_DEBATE, persona, overlays);

  const userBlocks = [
    `Sub-question: ${subQuestion.question}`,
    `Sub-question id: ${subQuestion.id}`,
    `Your persona id: ${persona.id}`,
    '',
    'Prior moves in this debate (chronological):',
    summarizeHistoryForPrompt(history),
  ];
  if (allowedTypes) {
    userBlocks.push('', `Allowed move types this turn: ${allowedTypes.join(', ')}`);
  }
  if (constrainedRebut) {
    userBlocks.push(
      '',
      `Calcification trigger: you must either Concede or counter-Rebut the prior Rebut ${constrainedRebut.move_id}: "${constrainedRebut.content}".`
    );
  }
  userBlocks.push('', 'Emit your move via emit_move now.');

  const messages = [
    { role: 'user', content: userBlocks.join('\n') },
    ...feedbackMessages,
  ];

  const { response, toolUse, usage, web_searches, truncated } = await runStructuredCall({
    client,
    model,
    budget,
    thinking: { type: 'adaptive' },
    system,
    // 1400 -> 2400 (+71%): same emit_move tool/schema as runDebateMove; bumped
    // in step with it rather than guessing an unrelated number.
    maxTokens: 2400,
    messages,
    tools: [EMIT_MOVE_TOOL],
    forceTool: 'emit_move',
  });

  for (const search of web_searches || []) {
    await appendLog(idea.id, logFile, {
      kind: 'web_search',
      payload: { persona_id: persona.id, ...search },
    });
  }

  // toolUse is null when generation was cut off (max_tokens) before the forced
  // tool_use block ever appeared. Fall back to null rather than throwing on
  // `.input` — the caller's validateContextualMove already rejects a null move
  // and drives the existing retry-with-feedback loop.
  const rawMove = toolUse ? toolUse.input : null;

  await appendLog(idea.id, logFile, {
    kind: 'response',
    payload: {
      attempt,
      persona_id: persona.id,
      stop_reason: response.stop_reason,
      usage,
      truncated,
      raw_input: rawMove,
    },
  });

  return { rawMove, usage, truncated };
}

async function emitPersonaMove({
  client,
  idea,
  model,
  budget,
  persona,
  subQuestion,
  history,
  sequence,
  isOpening,
  logFile,
}) {
  const calcification = isOpening ? { fired: false } : checkCalcification(history, persona.id);
  const constrainedRebut = calcification.fired ? calcification.rebut : null;
  const effectiveAllowedTypes = isOpening
    ? ['Claim']
    : constrainedRebut
    ? ['Concede', 'Rebut']
    : null;

  await appendLog(idea.id, logFile, {
    kind: 'request',
    payload: {
      sequence,
      persona_id: persona.id,
      is_opening: !!isOpening,
      calcified: !!constrainedRebut,
      constrained_rebut_id: constrainedRebut?.move_id || null,
    },
  });

  let feedbackMessages = [];
  let lastRawMove = null;

  for (let attempt = 1; attempt <= 2; attempt += 1) {
    const result = await emitOneMove({
      client,
      idea,
      model,
      budget,
      persona,
      subQuestion,
      history,
      isOpening,
      allowedTypes: effectiveAllowedTypes,
      constrainedRebut,
      logFile,
      attempt,
      feedbackMessages,
    });
    lastRawMove = result.rawMove;
    const validation = validateContextualMove(result.rawMove, {
      history,
      constrainedRebut,
      allowedTypes: effectiveAllowedTypes,
    });
    if (validation.valid) {
      const move = {
        move_id: moveId(subQuestion.id, sequence),
        by_persona_id: persona.id,
        type: result.rawMove.type,
        content: result.rawMove.content,
        evidence_basis: result.rawMove.evidence_basis,
        confidence: Number(result.rawMove.confidence),
        references_move_id: result.rawMove.references_move_id || null,
        timestamp: new Date().toISOString(),
      };
      return { move, synthesized: false };
    }

    await appendLog(idea.id, 'parse-errors', {
      kind: 'rejected_move',
      payload: {
        sub_question_id: subQuestion.id,
        persona_id: persona.id,
        attempt,
        errors: validation.errors,
        raw_move: result.rawMove,
        truncated: !!result.truncated,
      },
    });

    // When max_tokens truncation is the likely cause (either the tool_use block
    // never appeared, or it appeared but validation failed for missing fields),
    // tell the model explicitly so the retry has a shot at fitting under budget.
    const note = truncationNote(result.truncated, 'a complete move was emitted — be more concise this time');
    feedbackMessages = buildRejectionFeedback(
      attempt,
      'emit_move',
      result.rawMove || {},
      `Your move was rejected: ${validation.errors.join('; ')}.${note} Emit a corrected move now via emit_move.`
    );
  }

  if (constrainedRebut) {
    const synthesized = {
      move_id: moveId(subQuestion.id, sequence),
      by_persona_id: persona.id,
      type: 'Concede',
      content:
        'Synthesized Concede: the calcification rule triggered after two re-prompts. The unaddressed Rebut stands.',
      evidence_basis: 'calcification rule triggered after two re-prompts',
      confidence: 5,
      references_move_id: constrainedRebut.move_id,
      timestamp: new Date().toISOString(),
      synthesized: true,
    };
    await appendLog(idea.id, logFile, {
      kind: 'synthesized_move',
      payload: { move: synthesized, last_raw_move: lastRawMove },
    });
    return { move: synthesized, synthesized: true };
  }

  throw new Error(
    `Persona ${persona.id} produced invalid moves twice on ${subQuestion.id}: ${JSON.stringify(lastRawMove)}`
  );
}

async function runPairDebate({ client, idea, model, budget, subQuestion, personas }) {
  if (personas.length !== 2) {
    throw new Error(`Pair debate requires exactly 2 personas, got ${personas.length}`);
  }
  const logFile = `pair-${subQuestion.id}`;
  const history = [];
  let terminatedBy = null;

  // Parallel opening Claims — each persona sees the sub-question, not the other's
  // opening yet. Sequence numbers are pre-assigned so log entries carry the final
  // move_id rather than placeholders that would later be rewritten.
  const openingResults = await Promise.all(
    personas.map((persona, index) =>
      emitPersonaMove({
        client,
        idea,
        model,
        budget,
        persona,
        subQuestion,
        history: [],
        sequence: index + 1,
        isOpening: true,
        logFile,
      })
    )
  );
  let sequence = openingResults.length;
  for (const result of openingResults) {
    history.push(result.move);
  }

  let activeIndex = 0;
  while (history.length < PAIR_MOVE_BUDGET) {
    if (detectConcessionTermination(history)) {
      terminatedBy = 'concession';
      break;
    }
    const persona = personas[activeIndex];
    sequence += 1;
    const result = await emitPersonaMove({
      client,
      idea,
      model,
      budget,
      persona,
      subQuestion,
      history,
      sequence,
      isOpening: false,
      logFile,
    });
    history.push(result.move);
    activeIndex = (activeIndex + 1) % personas.length;
  }
  if (!terminatedBy) {
    terminatedBy = history.length >= PAIR_MOVE_BUDGET ? 'move_budget' : 'unknown';
  }

  const survivingClaims = extractSurvivingClaims(history);
  return {
    sub_question_id: subQuestion.id,
    moves: history,
    surviving_claims: survivingClaims,
    terminated_by: terminatedBy,
  };
}

async function runCrossPollinationReaction({
  client,
  idea,
  model,
  budget,
  persona,
  reactingPair,
  targetClaims,
  targetSubQuestion,
  // v5 additions
  targetAlignedQuestions = [],
  targetFindings = [],
  targetTerritory = null,
  bus,
}) {
  const system = buildSystemPrompt(CROSS_POLLINATION, persona);

  const claimList = targetClaims
    .map(
      (c) =>
        `- ${c.claim_id} (conf ${c.confidence_after_debate}, concession ${c.concession_status}): ${c.content}`
    )
    .join('\n');

  const validIds = new Set(targetClaims.map((c) => c.claim_id));

  const alignedQList = targetAlignedQuestions.length > 0
    ? targetAlignedQuestions.map((aq) => `- [${aq.origin}] ${aq.question}`).join('\n')
    : '(not available)';

  const citationGraph = targetFindings.length > 0
    ? targetFindings
        .map((f) => `- ${f.finding_id}: ${f.summary} (${f.source_url})`)
        .join('\n')
    : '(not available)';

  const targetDesc = targetTerritory
    ? `territory "${targetTerritory}"`
    : targetSubQuestion?.id
    ? `sub-question ${targetSubQuestion.id}`
    : 'another working group';

  await appendLog(idea.id, 'cross-pollination', {
    kind: 'request',
    payload: {
      persona_id: persona.id,
      target: targetDesc,
      claim_count: targetClaims.length,
    },
  });

  let feedbackMessages = [];
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    const userContent = [
      `Target ${targetDesc}`,
      targetSubQuestion?.question ? `Question investigated: ${targetSubQuestion.question}` : '',
      '',
      `Aligned questions that territory investigated:\n${alignedQList}`,
      '',
      `Citation graph (findings cited in surviving claims):\n${citationGraph}`,
      '',
      `Surviving claims to react to:\n${claimList}`,
      '',
      'Pick the single claim where your tradition adds the most value and emit one reaction via emit_reaction.',
    ].filter(Boolean).join('\n');

    const { response, toolUse, usage, truncated } = await runStructuredCall({
      client,
      model,
      budget,
      thinking: { type: 'adaptive' },
      system,
      // 1200 -> 2000 (+67%): no confirmed-truncation log data for this site,
      // but same shape of risk as runAlignmentMove; conservative bump.
      maxTokens: 2000,
      messages: [
        { role: 'user', content: userContent },
        ...feedbackMessages,
      ],
      tools: [EMIT_REACTION_TOOL],
      forceTool: 'emit_reaction',
    });

    // toolUse is null when max_tokens cut generation off before the forced
    // tool_use block appeared; treat as a rejected reaction rather than crash.
    const raw = toolUse ? toolUse.input : null;
    const shape = validateMoveShape(raw, { reactionOnly: true });
    const errors = [...shape.errors];
    if (raw && !validIds.has(raw.references_claim_id)) {
      errors.push(`references_claim_id ${raw.references_claim_id} not in target claim set`);
    }
    if (errors.length === 0) {
      await appendLog(idea.id, 'cross-pollination', {
        kind: 'response',
        payload: { stop_reason: response.stop_reason, usage, persona_id: persona.id },
      });
      if (bus) bus.emit('cross_pollination.reaction', {
        persona_id: persona.id,
        reactor_territory: reactingPair?.territory_id || null,
        target_territory: targetTerritory || targetSubQuestion?.id || null,
        type: raw.type,
        references_claim_id: raw.references_claim_id,
        confidence: Number(raw.confidence),
      });
      return {
        by_persona_id: persona.id,
        type: raw.type,
        content: raw.content,
        evidence_basis: raw.evidence_basis,
        confidence: Number(raw.confidence),
        references_claim_id: raw.references_claim_id,
      };
    }

    await appendLog(idea.id, 'parse-errors', {
      kind: 'rejected_reaction',
      payload: { persona_id: persona.id, attempt, errors, raw, truncated: !!truncated },
    });

    const note = truncationNote(truncated, 'a complete reaction was emitted — be more concise this time');
    feedbackMessages = buildRejectionFeedback(
      attempt,
      'emit_reaction',
      raw || {},
      `Your reaction was rejected: ${errors.join('; ')}.${note} Emit a corrected reaction via emit_reaction.`
    );
  }

  // Synthesized Question — the safest fallback because Question doesn't move
  // aggregate_confidence; the downstream synthesizer just flags has_open_question.
  const fallbackClaim = targetClaims[0];
  return {
    by_persona_id: persona.id,
    type: 'Question',
    content:
      'Synthesized Question: cross-pollination reaction could not be produced after two re-prompts; flagging the highest-confidence claim for the synthesizer.',
    evidence_basis: 'cross-pollination synthesis fallback after two re-prompts',
    confidence: 4,
    references_claim_id: fallbackClaim.claim_id,
    synthesized: true,
  };
}

// ---------------------------------------------------------------------------
// v5 Working Group sub-stage functions
// ---------------------------------------------------------------------------

const EMIT_CANDIDATE_QUESTIONS_TOOL = {
  name: 'emit_candidate_questions',
  description: 'Emit your candidate research questions for this territory.',
  input_schema: {
    type: 'object',
    required: ['candidate_questions'],
    additionalProperties: false,
    properties: {
      candidate_questions: {
        type: 'array',
        minItems: 2,
        maxItems: 8,
        items: IDEATION_JSON_SCHEMA,
      },
    },
  },
};

const EMIT_ADVERSARIAL_MARKS_TOOL = {
  name: 'emit_adversarial_marks',
  description: 'Emit your adversarial marks for the other persona\'s candidate questions.',
  input_schema: {
    type: 'object',
    required: ['marks'],
    additionalProperties: false,
    properties: {
      marks: {
        type: 'array',
        items: ADVERSARIAL_MARK_JSON_SCHEMA,
      },
    },
  },
};

const EMIT_ALIGNMENT_MOVE_TOOL = {
  name: 'emit_alignment_move',
  description: 'Emit one alignment move (Propose, Sharpen, Merge, Drop, or Defer).',
  input_schema: ALIGNMENT_JSON_SCHEMA,
};

const EMIT_OBSERVATIONS_TOOL = {
  name: 'emit_observations',
  description: 'Emit your observations on the assigned researcher reports.',
  input_schema: {
    type: 'object',
    required: ['observations'],
    additionalProperties: false,
    properties: {
      observations: {
        type: 'array',
        minItems: 1,
        maxItems: 6,
        items: OBSERVATION_JSON_SCHEMA,
      },
    },
  },
};

async function runIdeation({ client, idea, model, budget, territory, persona }) {
  const territoryId = territory.id || territory.territory_id;
  const logFile = `pair-${territoryId}-ideation`;

  await appendLog(idea.id, logFile, {
    kind: 'request',
    payload: { persona_id: persona.id, territory_id: territoryId },
  });

  const system = buildSystemPrompt(PERSONA_IDEATION, persona);
  const baseUserContent = `Territory: ${territory.name}\n\nTerritory description: ${territory.description}\n\nTopic: ${idea.raw_capture}\n\nGenerate 4–6 candidate research questions for this territory from your tradition's perspective. Invoke emit_candidate_questions.`;

  // No pre-existing retry loop at this call site; this reuses the same
  // buildRejectionFeedback + bounded-attempts mechanism used elsewhere in this
  // file rather than inventing new infra.
  let feedbackMessages = [];
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    const { response, toolUse, usage, truncated } = await runStructuredCall({
      client,
      model,
      budget,
      thinking: { type: 'adaptive' },
      system,
      // 3000 -> 5000 (+67%): array of up to 8 ideation items; no confirmed
      // truncation log for this site, conservative bump per instructions.
      maxTokens: 5000,
      messages: [{ role: 'user', content: baseUserContent }, ...feedbackMessages],
      tools: [EMIT_CANDIDATE_QUESTIONS_TOOL],
      forceTool: 'emit_candidate_questions',
    });

    await appendLog(idea.id, logFile, {
      kind: 'response',
      payload: { persona_id: persona.id, stop_reason: response.stop_reason, usage, truncated },
    });

    const rawInput = toolUse ? toolUse.input : null;
    const candidateQuestions = Array.isArray(rawInput?.candidate_questions)
      ? rawInput.candidate_questions
      : null;
    if (candidateQuestions && candidateQuestions.length > 0) {
      return { persona_id: persona.id, candidate_questions: candidateQuestions };
    }

    await appendLog(idea.id, 'parse-errors', {
      kind: 'rejected_ideation',
      payload: { persona_id: persona.id, attempt, truncated, raw_input: rawInput },
    });

    const note = truncationNote(
      truncated,
      'candidate_questions completed — emit fewer, more concise questions this time'
    );
    feedbackMessages = buildRejectionFeedback(
      attempt,
      'emit_candidate_questions',
      rawInput || {},
      `Your candidate_questions were missing or empty.${note} Emit at least 2 candidate research questions now via emit_candidate_questions.`
    );
  }

  // Two failed attempts: return an empty list rather than propagate a broken
  // partial payload. Downstream (working_group.js) tolerates zero candidates
  // from a persona without crashing.
  return { persona_id: persona.id, candidate_questions: [] };
}

async function runAdversarialMark({
  client,
  idea,
  model,
  budget,
  territory,
  persona,
  candidateQuestions,
}) {
  const territoryId = territory.id || territory.territory_id;
  const logFile = `pair-${territoryId}-adversarial`;

  await appendLog(idea.id, logFile, {
    kind: 'request',
    payload: { persona_id: persona.id, candidate_count: candidateQuestions.length },
  });

  const system = buildSystemPrompt(PERSONA_ADVERSARIAL, persona);
  const questionList = candidateQuestions
    .map((c) => `- ${c.candidate_id}: "${c.question}" (predicted_confidence: ${c.predicted_confidence})`)
    .join('\n');
  const baseUserContent = `Territory: ${territory.name}\n\nThe other persona's candidate questions:\n${questionList}\n\nFor each, mark whether you could answer it from priors. Invoke emit_adversarial_marks.`;

  // No pre-existing retry loop here either; reuse the same bounded-attempts +
  // buildRejectionFeedback mechanism as runIdeation/emitPersonaMove.
  let feedbackMessages = [];
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    const { response, toolUse, usage, truncated } = await runStructuredCall({
      client,
      model,
      budget,
      thinking: { type: 'adaptive' },
      system,
      // 2000 -> 3200 (+60%): no confirmed-truncation data for this site,
      // conservative bump per instructions.
      maxTokens: 3200,
      messages: [{ role: 'user', content: baseUserContent }, ...feedbackMessages],
      tools: [EMIT_ADVERSARIAL_MARKS_TOOL],
      forceTool: 'emit_adversarial_marks',
    });

    await appendLog(idea.id, logFile, {
      kind: 'response',
      payload: { persona_id: persona.id, stop_reason: response.stop_reason, usage, truncated },
    });

    const rawInput = toolUse ? toolUse.input : null;
    // marks may legitimately be an empty array (schema has no minItems), but a
    // truncated/missing tool_use block means we can't trust it was intentional.
    if (rawInput && Array.isArray(rawInput.marks) && !truncated) {
      return { persona_id: persona.id, marks: rawInput.marks };
    }

    await appendLog(idea.id, 'parse-errors', {
      kind: 'rejected_adversarial_marks',
      payload: { persona_id: persona.id, attempt, truncated, raw_input: rawInput },
    });

    const note = truncationNote(truncated, 'marks completed — be more concise this time');
    feedbackMessages = buildRejectionFeedback(
      attempt,
      'emit_adversarial_marks',
      rawInput || {},
      `Your marks were missing or malformed.${note} Emit emit_adversarial_marks again now.`
    );
  }

  // Two failed attempts: candidates remain unmarked, matching the existing
  // partial_failure tolerance in working_group.js's adversarial sub-stage.
  return { persona_id: persona.id, marks: [] };
}

async function runAlignmentMove({
  client,
  idea,
  model,
  budget,
  territory,
  persona,
  candidateQuestions,
  adversarialMarks,
  history,
}) {
  const territoryId = territory.id || territory.territory_id;
  const logFile = `pair-${territoryId}-alignment`;

  const system = buildSystemPrompt(ALIGNMENT_DEBATE, persona);

  const questionList = candidateQuestions
    .map((c) => {
      const marks = adversarialMarks.filter((m) => m.candidate_id === c.candidate_id);
      const markSummary = marks.length > 0
        ? marks.map((m) => `(${m.marker_persona_id}: could_answer=${m.could_answer_from_priors})`).join(' ')
        : '(no marks)';
      return `- ${c.candidate_id} [${c.by_persona_id}] conf=${c.predicted_confidence}: "${c.question}" ${markSummary}`;
    })
    .join('\n');

  const historyText = history.length === 0
    ? '(no prior alignment moves)'
    : history.map((m) => `${m.move_id} [${m.by_persona_id} · ${m.type}]: ${m.content}`).join('\n');

  const baseUserContent = `Territory: ${territory.name}\n\nCandidate questions with adversarial marks:\n${questionList}\n\nAlignment debate so far:\n${historyText}\n\nEmit your next alignment move via emit_alignment_move.`;

  // Confirmed production truncation (t_005 pair-t_005-alignment.jsonl): this
  // persona hit stop_reason=max_tokens at exactly usage.output=1200, the old
  // ceiling. working_group.js's alignment loop does zero validation on the
  // returned move (`if (!move) break;` only) — a truncated-but-present
  // tool_use here used to become a silently-accepted broken move. Retry once
  // on truncation before returning, using the same bounded-attempts +
  // buildRejectionFeedback mechanism as the other call sites in this file.
  let feedbackMessages = [];
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    const { response, toolUse, usage, truncated } = await runStructuredCall({
      client,
      model,
      budget,
      thinking: { type: 'adaptive' },
      system,
      // 1200 -> 2400: doubled, matching coordinator.js's budget for a
      // comparable single-turn structured call. No output-usage headroom data
      // beyond "hit the 1200 ceiling exactly", so this is a judgement call
      // rather than a measured multiplier.
      maxTokens: 2400,
      messages: [{ role: 'user', content: baseUserContent }, ...feedbackMessages],
      tools: [EMIT_ALIGNMENT_MOVE_TOOL],
      forceTool: 'emit_alignment_move',
    });

    await appendLog(idea.id, logFile, {
      kind: 'response',
      payload: { persona_id: persona.id, stop_reason: response.stop_reason, usage, truncated },
    });

    const rawInput = toolUse ? toolUse.input : null;
    const hasRequiredFields =
      rawInput &&
      typeof rawInput.type === 'string' &&
      ALIGNMENT_MOVE_TYPES.includes(rawInput.type) &&
      typeof rawInput.content === 'string' &&
      rawInput.content.trim().length > 0;

    if (hasRequiredFields && !truncated) {
      return rawInput;
    }

    await appendLog(idea.id, 'parse-errors', {
      kind: 'rejected_alignment_move',
      payload: { persona_id: persona.id, attempt, truncated, raw_input: rawInput },
    });

    if (attempt < 2) {
      const note = truncationNote(truncated, 'a complete move was emitted — be more concise this time');
      const errorText = hasRequiredFields
        ? `Your alignment move was cut off before it completed.${note}`
        : `Your alignment move was missing required fields (type, content).${note}`;
      feedbackMessages = buildRejectionFeedback(
        attempt,
        'emit_alignment_move',
        rawInput || {},
        `${errorText} Emit a corrected alignment move now via emit_alignment_move.`
      );
    }
  }

  // Two failed attempts: return null. The caller (working_group.js) already
  // treats a null move as "end this alignment debate early" (`if (!move)
  // break;`) — safe, unlike propagating a truncated/incomplete move as valid.
  return null;
}

async function runObservation({
  client,
  idea,
  model,
  budget,
  territory,
  persona,
  report,
  allReports,
}) {
  const territoryId = territory.id || territory.territory_id;
  const logFile = `pair-${territoryId}-observation`;

  const system = buildSystemPrompt(PERSONA_OBSERVATION, persona);

  const reportSummary = (r) =>
    `Report ${r.report_id} (${r.outcome}): ${r.findings.length} findings\n` +
    r.findings
      .map((f) => `  - ${f.finding_id}: [conf=${f.confidence_in_source}] ${f.summary} (${f.source_url})`)
      .join('\n');

  const allReportText = allReports.map(reportSummary).join('\n\n');
  const assignedReportText = reportSummary(report);

  const { response, toolUse, usage, truncated } = await runStructuredCall({
    client,
    model,
    budget,
    thinking: { type: 'adaptive' },
    system,
    // 2000 -> 3200 (+60%): array of up to 6 observations; no confirmed
    // truncation data for this site, conservative bump per instructions.
    maxTokens: 3200,
    messages: [
      {
        role: 'user',
        content: `Territory: ${territory.name}\n\nAll researcher reports for context:\n${allReportText}\n\nYour assigned report (produce observations for this one):\n${assignedReportText}\n\nEmit your observations via emit_observations.`,
      },
    ],
    tools: [EMIT_OBSERVATIONS_TOOL],
    forceTool: 'emit_observations',
  });

  await appendLog(idea.id, logFile, {
    kind: 'response',
    payload: { persona_id: persona.id, report_id: report.report_id, stop_reason: response.stop_reason, usage, truncated },
  });

  const rawInput = toolUse ? toolUse.input : null;
  const observations = Array.isArray(rawInput?.observations) ? rawInput.observations : null;
  // Don't let a truncated/missing tool_use silently return an empty or
  // partial observations list as if it were a genuine result. working_group.js
  // already retries this call once on a thrown error (Promise.allSettled +
  // single retry, see its observation sub-stage) and synthesizes a fallback
  // observation if the retry also fails — throwing here reuses that existing
  // mechanism instead of building a second one.
  if (truncated || !observations || observations.length === 0) {
    throw new Error(
      `runObservation truncated or malformed for persona ${persona.id} report ${report.report_id} (stop_reason=${response.stop_reason})`
    );
  }

  return { observations };
}

async function runDebateMove({
  client,
  idea,
  model,
  budget,
  territory,
  persona,
  history,
  observations,
  findings,
  isOpening,
  repromptReason,
}) {
  const territoryId = territory.id || territory.territory_id;
  const logFile = `pair-${territoryId}-debate`;

  const overlays = isOpening ? [PERSONA_OPENING_OVERLAY] : [];
  const system = buildSystemPrompt(PERSONA_DEBATE, persona, overlays);

  const findingIndex = findings
    .map((f) => `- ${f.finding_id} [conf=${f.confidence_in_source}]: ${f.summary} (${f.source_url})`)
    .join('\n');

  const obsIndex = observations
    .filter((o) => o.by_persona_id === persona.id)
    .map((o) => `- ${o.observation_id} [report ${o.report_id}]: ${o.content}`)
    .join('\n');

  const historyText = history.length === 0
    ? '(no prior debate moves)'
    : history.map((m) => `${m.move_id} [${m.by_persona_id} · ${m.type} conf=${m.confidence}]: ${m.content}`).join('\n');

  const userContent = [
    `Territory: ${territory.name}`,
    `Topic: ${idea.raw_capture}`,
    '',
    'Your observations:',
    obsIndex || '(none)',
    '',
    'Researcher finding index (all findings in this territory):',
    findingIndex || '(none)',
    '',
    'Prior debate moves:',
    historyText,
    '',
    repromptReason ? `CORRECTION REQUIRED: ${repromptReason}\n` : '',
    'Emit your move via emit_move now.',
  ].join('\n');

  const { response, toolUse, usage, truncated } = await runStructuredCall({
    client,
    model,
    budget,
    thinking: { type: 'adaptive' },
    system,
    // 1400 -> 2400 (+71%): same emit_move tool/schema as emitOneMove; bumped
    // in step with it.
    maxTokens: 2400,
    messages: [{ role: 'user', content: userContent }],
    tools: [EMIT_MOVE_TOOL],
    forceTool: 'emit_move',
  });

  await appendLog(idea.id, logFile, {
    kind: 'response',
    payload: { persona_id: persona.id, stop_reason: response.stop_reason, usage, truncated },
  });

  // toolUse is null when max_tokens cut generation off before the forced
  // tool_use block appeared — return null rather than throw on `.input`.
  // working_group.js's caller already treats a null move as "stop this turn"
  // (opening: filtered via `!settled.value`; sequential turns: `if (!move)
  // break;`), and a truncated-but-present move with missing required fields
  // is already caught by its validateDebateMove -> validateMoveShape check,
  // which drives the existing repromptReason retry-once path there.
  return toolUse ? toolUse.input || null : null;
}

module.exports = {
  runPairDebate,
  runCrossPollinationReaction,
  // v5
  runIdeation,
  runAdversarialMark,
  runAlignmentMove,
  runObservation,
  runDebateMove,
  // Exported for direct unit testing of the truncation/retry handling
  // (emitPersonaMove is otherwise only reachable through runPairDebate's
  // parallel-opening + sequential-turn orchestration).
  emitOneMove,
  emitPersonaMove,
};
