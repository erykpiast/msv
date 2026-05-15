const { runStructuredCall } = require('../anthropic');
const { COORDINATOR_INITIAL, COORDINATOR_SPAWN } = require('./prompts');
const { appendLog } = require('../storage');
const { pairDistinctnessScore } = require('../diversity');

const SUB_QUESTION_SCHEMA = {
  type: 'object',
  required: ['question', 'rationale', 'assigned_pair'],
  additionalProperties: false,
  properties: {
    question: { type: 'string', minLength: 1 },
    rationale: { type: 'string', minLength: 1 },
    assigned_pair: {
      type: 'array',
      items: { type: 'string' },
      minItems: 2,
      maxItems: 2,
    },
  },
};

const EMIT_INITIAL_TOOL = {
  name: 'emit_initial_decomposition',
  description:
    'Emit 4–6 focused sub-questions, each paired with two persona ids chosen to maximise productive tension.',
  input_schema: {
    type: 'object',
    required: ['sub_questions'],
    additionalProperties: false,
    properties: {
      sub_questions: {
        type: 'array',
        minItems: 3,
        maxItems: 6,
        items: SUB_QUESTION_SCHEMA,
      },
    },
  },
};

const EMIT_SPAWN_TOOL = {
  name: 'emit_spawn_decision',
  description:
    'Emit zero, one, or two additional sub-questions. Each must cite a specific surviving claim that triggered the need.',
  input_schema: {
    type: 'object',
    required: ['sub_questions'],
    additionalProperties: false,
    properties: {
      sub_questions: {
        type: 'array',
        maxItems: 2,
        items: {
          type: 'object',
          required: ['question', 'rationale', 'assigned_pair', 'triggered_by_claim_id'],
          additionalProperties: false,
          properties: {
            question: { type: 'string', minLength: 1 },
            rationale: { type: 'string', minLength: 1 },
            assigned_pair: {
              type: 'array',
              items: { type: 'string' },
              minItems: 2,
              maxItems: 2,
            },
            triggered_by_claim_id: { type: 'string', minLength: 1 },
          },
        },
      },
    },
  },
};

function renderPersonaSummary(personas) {
  return personas
    .map(
      (p) =>
        `- ${p.id} · ${p.name}\n  tradition: ${p.tradition}\n  stance: ${p.stance}`
    )
    .join('\n');
}

function renderPairScores(personas) {
  const rows = [];
  for (let i = 0; i < personas.length; i += 1) {
    for (let j = i + 1; j < personas.length; j += 1) {
      const score = pairDistinctnessScore(personas[i], personas[j]);
      rows.push(`${personas[i].id} × ${personas[j].id} → ${score}`);
    }
  }
  return rows.join('\n');
}

function nextSubQuestionId(existing) {
  const used = new Set(existing.map((sq) => sq.id));
  let n = 1;
  while (used.has(`sq_${String(n).padStart(3, '0')}`)) {
    n += 1;
  }
  return `sq_${String(n).padStart(3, '0')}`;
}

async function runCoordinatorInitial({ client, idea, model, budget, personas }) {
  const personaSummary = renderPersonaSummary(personas);
  const pairScores = renderPairScores(personas);
  const validIds = new Set(personas.map((p) => p.id));

  await appendLog(idea.id, 'coordinator-initial', {
    kind: 'request',
    payload: { persona_ids: personas.map((p) => p.id) },
  });

  const { response, toolUse, usage } = await runStructuredCall({
    client,
    model,
    budget,
    system: COORDINATOR_INITIAL,
    maxTokens: 2400,
    messages: [
      {
        role: 'user',
        content: `Topic: ${idea.raw_capture}\n\nPersona roster:\n${personaSummary}\n\nPair-distinctness scores (higher = more tension):\n${pairScores}\n\nDecompose the topic and assign pairs. Invoke emit_initial_decomposition.`,
      },
    ],
    tools: [EMIT_INITIAL_TOOL],
    forceTool: 'emit_initial_decomposition',
  });

  const subQuestions = toolUse.input.sub_questions
    .map((sq, index) => {
      const cleanedPair = (sq.assigned_pair || []).filter((id) => validIds.has(id));
      if (cleanedPair.length !== 2) {
        return null;
      }
      const score = pairDistinctnessScore(
        personas.find((p) => p.id === cleanedPair[0]),
        personas.find((p) => p.id === cleanedPair[1])
      );
      return {
        id: `sq_${String(index + 1).padStart(3, '0')}`,
        question: sq.question,
        rationale: sq.rationale,
        assigned_pair: cleanedPair,
        pair_distinctness_score: score,
      };
    })
    .filter(Boolean);

  await appendLog(idea.id, 'coordinator-initial', {
    kind: 'response',
    payload: {
      stop_reason: response.stop_reason,
      usage,
      sub_question_count: subQuestions.length,
    },
  });

  return {
    decided_at: new Date().toISOString(),
    sub_questions: subQuestions,
    usage,
  };
}

async function runCoordinatorSpawn({
  client,
  idea,
  model,
  budget,
  personas,
  pairDebates,
  existingSubQuestions,
}) {
  const remainingBudget =
    budget.max_executor_calls - (budget.used_executor_calls || 0);
  const budgetUsedPct =
    (budget.used_executor_calls || 0) / Math.max(1, budget.max_executor_calls);

  if (budgetUsedPct >= 0.8) {
    await appendLog(idea.id, 'coordinator-spawn', {
      kind: 'declined',
      payload: { reason: 'budget_80pct', budget_used_pct: budgetUsedPct },
    });
    return { decided_at: new Date().toISOString(), sub_questions: [], reason: 'budget_cap' };
  }

  const transcriptSummary = pairDebates.map((debate) => ({
    sub_question_id: debate.sub_question_id,
    surviving_claims: debate.surviving_claims,
  }));

  const personaSummary = renderPersonaSummary(personas);

  await appendLog(idea.id, 'coordinator-spawn', {
    kind: 'request',
    payload: {
      remaining_calls: remainingBudget,
      pair_count: pairDebates.length,
    },
  });

  const { response, toolUse, usage } = await runStructuredCall({
    client,
    model,
    budget,
    system: COORDINATOR_SPAWN,
    maxTokens: 1800,
    messages: [
      {
        role: 'user',
        content: `Topic: ${idea.raw_capture}\n\nPersona roster:\n${personaSummary}\n\nSurviving claims from initial round:\n${JSON.stringify(
          transcriptSummary,
          null,
          2
        )}\n\nBudget: ${budget.used_executor_calls}/${budget.max_executor_calls} executor calls used (${(budgetUsedPct * 100).toFixed(0)}%).\n\nDecide whether to spawn 0, 1, or 2 additional sub-questions. Invoke emit_spawn_decision.`,
      },
    ],
    tools: [EMIT_SPAWN_TOOL],
    forceTool: 'emit_spawn_decision',
  });

  const validIds = new Set(personas.map((p) => p.id));
  const validClaimIds = new Set(
    pairDebates.flatMap((d) => (d.surviving_claims || []).map((c) => c.claim_id))
  );

  const rawSubQuestions = toolUse.input.sub_questions;
  const spawned = [];
  for (const sq of rawSubQuestions) {
    const cleanedPair = (sq.assigned_pair || []).filter((id) => validIds.has(id));
    if (cleanedPair.length !== 2) continue;
    if (!validClaimIds.has(sq.triggered_by_claim_id)) continue;
    const score = pairDistinctnessScore(
      personas.find((p) => p.id === cleanedPair[0]),
      personas.find((p) => p.id === cleanedPair[1])
    );
    spawned.push({
      id: nextSubQuestionId([...existingSubQuestions, ...spawned]),
      question: sq.question,
      rationale: sq.rationale,
      assigned_pair: cleanedPair,
      pair_distinctness_score: score,
      triggered_by_claim_id: sq.triggered_by_claim_id,
    });
  }

  await appendLog(idea.id, 'coordinator-spawn', {
    kind: 'response',
    payload: {
      stop_reason: response.stop_reason,
      usage,
      spawned_count: spawned.length,
    },
  });

  return {
    decided_at: new Date().toISOString(),
    sub_questions: spawned,
    usage,
  };
}

module.exports = {
  runCoordinatorInitial,
  runCoordinatorSpawn,
};
