'use strict';

const { runStructuredCall } = require('../anthropic');
const { COORDINATOR_TERRITORIES } = require('./prompts');
const { appendLog } = require('../storage');
const { pairDistinctnessScore } = require('../diversity');

const TERRITORY_SCHEMA = {
  type: 'object',
  required: ['name', 'description', 'assigned_pair'],
  additionalProperties: false,
  properties: {
    name: {
      type: 'string',
      minLength: 1,
      maxLength: 20,
      description: 'Short kebab-case label, e.g. "cognitive-load".',
    },
    description: {
      type: 'string',
      minLength: 1,
      description: '1–2 sentences explaining what terrain this covers.',
    },
    rationale: { type: 'string' },
    assigned_pair: {
      type: 'array',
      items: { type: 'string' },
      minItems: 2,
      maxItems: 2,
    },
  },
};

const EMIT_TERRITORIES_TOOL = {
  name: 'emit_territories',
  description: 'Emit 4–5 broad intellectual territories, each paired with two persona ids.',
  input_schema: {
    type: 'object',
    required: ['territories'],
    additionalProperties: false,
    properties: {
      territories: {
        type: 'array',
        minItems: 3,
        maxItems: 5,
        items: TERRITORY_SCHEMA,
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

async function runCoordinatorInitial({ client, idea, model, budget, personas, bus }) {
  const personaSummary = renderPersonaSummary(personas);
  const pairScores = renderPairScores(personas);
  const validIds = new Set(personas.map((p) => p.id));

  await appendLog(idea.id, 'coordinator', {
    kind: 'request',
    payload: { persona_ids: personas.map((p) => p.id) },
  });

  const { response, toolUse, usage } = await runStructuredCall({
    client,
    model,
    budget,
    thinking: { type: 'adaptive' },
    system: COORDINATOR_TERRITORIES,
    maxTokens: 2400,
    messages: [
      {
        role: 'user',
        content: `Topic: ${idea.raw_capture}\n\nPersona roster:\n${personaSummary}\n\nPair-distinctness scores (higher = more tension):\n${pairScores}\n\nDecompose the topic into 4–5 broad territories and assign persona pairs. Invoke emit_territories.`,
      },
    ],
    tools: [EMIT_TERRITORIES_TOOL],
    forceTool: 'emit_territories',
  });

  const territories = (toolUse.input.territories || [])
    .map((t, index) => {
      const cleanedPair = (t.assigned_pair || []).filter((id) => validIds.has(id));
      if (cleanedPair.length !== 2) return null;
      const score = pairDistinctnessScore(
        personas.find((p) => p.id === cleanedPair[0]),
        personas.find((p) => p.id === cleanedPair[1])
      );
      return {
        id: `t_${String(index + 1).padStart(3, '0')}`,
        territory_id: `t_${String(index + 1).padStart(3, '0')}`,
        name: t.name,
        description: t.description,
        rationale: t.rationale || '',
        assigned_pair: cleanedPair,
        pair_distinctness_score: score,
      };
    })
    .filter(Boolean);

  await appendLog(idea.id, 'coordinator', {
    kind: 'response',
    payload: {
      stop_reason: response.stop_reason,
      usage,
      territory_count: territories.length,
    },
  });

  if (bus) bus.emit('coordinator.territories.emitted', {
    count: territories.length,
    names: territories.map((t) => t.name || t.id || t.territory_id),
  });

  return {
    decided_at: new Date().toISOString(),
    territories,
    usage,
  };
}

module.exports = {
  runCoordinatorInitial,
};
