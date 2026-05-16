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

  const { response, toolUse, usage, web_searches } = await runStructuredCall({
    client,
    model,
    budget,
    system,
    maxTokens: 1400,
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

  await appendLog(idea.id, logFile, {
    kind: 'response',
    payload: {
      attempt,
      persona_id: persona.id,
      stop_reason: response.stop_reason,
      usage,
      raw_input: toolUse.input,
    },
  });

  return { rawMove: toolUse.input, usage };
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
      },
    });

    feedbackMessages = buildRejectionFeedback(
      attempt,
      'emit_move',
      result.rawMove,
      `Your move was rejected: ${validation.errors.join('; ')}. Emit a corrected move now via emit_move.`
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

    const { response, toolUse, usage } = await runStructuredCall({
      client,
      model,
      budget,
      system,
      maxTokens: 1200,
      messages: [
        { role: 'user', content: userContent },
        ...feedbackMessages,
      ],
      tools: [EMIT_REACTION_TOOL],
      forceTool: 'emit_reaction',
    });

    const raw = toolUse.input;
    const shape = validateMoveShape(raw, { reactionOnly: true });
    const errors = [...shape.errors];
    if (!validIds.has(raw.references_claim_id)) {
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
      payload: { persona_id: persona.id, attempt, errors, raw },
    });

    feedbackMessages = buildRejectionFeedback(
      attempt,
      'emit_reaction',
      raw,
      `Your reaction was rejected: ${errors.join('; ')}. Emit a corrected reaction via emit_reaction.`
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

  const { response, toolUse, usage } = await runStructuredCall({
    client,
    model,
    budget,
    system,
    maxTokens: 3000,
    messages: [
      {
        role: 'user',
        content: `Territory: ${territory.name}\n\nTerritory description: ${territory.description}\n\nTopic: ${idea.raw_capture}\n\nGenerate 4–6 candidate research questions for this territory from your tradition's perspective. Invoke emit_candidate_questions.`,
      },
    ],
    tools: [EMIT_CANDIDATE_QUESTIONS_TOOL],
    forceTool: 'emit_candidate_questions',
  });

  await appendLog(idea.id, logFile, {
    kind: 'response',
    payload: { persona_id: persona.id, stop_reason: response.stop_reason, usage },
  });

  return {
    persona_id: persona.id,
    candidate_questions: toolUse.input.candidate_questions || [],
  };
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

  const { response, toolUse, usage } = await runStructuredCall({
    client,
    model,
    budget,
    system,
    maxTokens: 2000,
    messages: [
      {
        role: 'user',
        content: `Territory: ${territory.name}\n\nThe other persona's candidate questions:\n${questionList}\n\nFor each, mark whether you could answer it from priors. Invoke emit_adversarial_marks.`,
      },
    ],
    tools: [EMIT_ADVERSARIAL_MARKS_TOOL],
    forceTool: 'emit_adversarial_marks',
  });

  await appendLog(idea.id, logFile, {
    kind: 'response',
    payload: { persona_id: persona.id, stop_reason: response.stop_reason, usage },
  });

  return {
    persona_id: persona.id,
    marks: toolUse.input.marks || [],
  };
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

  const { response, toolUse, usage } = await runStructuredCall({
    client,
    model,
    budget,
    system,
    maxTokens: 1200,
    messages: [
      {
        role: 'user',
        content: `Territory: ${territory.name}\n\nCandidate questions with adversarial marks:\n${questionList}\n\nAlignment debate so far:\n${historyText}\n\nEmit your next alignment move via emit_alignment_move.`,
      },
    ],
    tools: [EMIT_ALIGNMENT_MOVE_TOOL],
    forceTool: 'emit_alignment_move',
  });

  await appendLog(idea.id, logFile, {
    kind: 'response',
    payload: { persona_id: persona.id, stop_reason: response.stop_reason, usage },
  });

  return toolUse.input || null;
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

  const { response, toolUse, usage } = await runStructuredCall({
    client,
    model,
    budget,
    system,
    maxTokens: 2000,
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
    payload: { persona_id: persona.id, report_id: report.report_id, stop_reason: response.stop_reason, usage },
  });

  return {
    observations: toolUse.input.observations || [],
  };
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

  const { response, toolUse, usage } = await runStructuredCall({
    client,
    model,
    budget,
    system,
    maxTokens: 1400,
    messages: [{ role: 'user', content: userContent }],
    tools: [EMIT_MOVE_TOOL],
    forceTool: 'emit_move',
  });

  await appendLog(idea.id, logFile, {
    kind: 'response',
    payload: { persona_id: persona.id, stop_reason: response.stop_reason, usage },
  });

  return toolUse.input || null;
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
};
