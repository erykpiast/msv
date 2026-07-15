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

// Returns true when the tool call is unusable because it was cut off mid-JSON:
// either the forced tool never made it into the response (toolUse === null),
// or it did appear but its required `territories` array is missing/malformed
// — the same "truncated but present" case researcher.js's normalizeReport
// guards against for `findings`.
function isUnrecoverableTruncation({ toolUse, truncated }) {
  if (!truncated) return false;
  if (!toolUse) return true;
  return !Array.isArray(toolUse.input && toolUse.input.territories);
}

async function runCoordinatorInitial({ client, idea, model, budget, personas, bus }) {
  const personaSummary = renderPersonaSummary(personas);
  const pairScores = renderPairScores(personas);
  const validIds = new Set(personas.map((p) => p.id));

  await appendLog(idea.id, 'coordinator', {
    kind: 'request',
    payload: { persona_ids: personas.map((p) => p.id) },
  });

  const messages = [
    {
      role: 'user',
      content: `Topic: ${idea.raw_capture}\n\nPersona roster:\n${personaSummary}\n\nPair-distinctness scores (higher = more tension):\n${pairScores}\n\nDecompose the topic into 4–5 broad territories and assign persona pairs. Invoke emit_territories.`,
    },
  ];

  const callArgs = {
    client,
    model,
    budget,
    thinking: { type: 'adaptive' },
    system: COORDINATOR_TERRITORIES,
    // Bumped from 2400. This call forces a single small structured emit (3-5
    // territories, each a short kebab-case name + 1-2 sentence description +
    // a 2-id pair — nowhere near researcher.js's findings arrays), but it
    // shares the same adaptive-thinking + forced-tool shape that caused
    // silent truncation at persona.js's 1200-token ceiling in production:
    // adaptive thinking competes with the final JSON for the same max_tokens
    // budget, so a tight ceiling can starve the emit even when the emitted
    // payload itself is small. 4000 gives that thinking headroom room without
    // reaching for researcher/synthesizer-sized ceilings this schema doesn't need.
    maxTokens: 4000,
    messages,
    tools: [EMIT_TERRITORIES_TOOL],
    forceTool: 'emit_territories',
  };

  let result = await runStructuredCall(callArgs);

  // Recoverable max_tokens truncation: give the model exactly one more shot
  // at a shorter, complete emit before treating this early, high-leverage
  // decision as lost. This is a cheap, single-shot call (unlike researcher's
  // multi-turn loop), so a retry here is low-cost; if it also truncates or
  // comes back malformed, we fall through and let the error propagate to
  // run.js, which already classifies/checkpoints thrown errors for resume
  // (see src/commands/run.js's per-idea try/catch) rather than silently
  // continuing with partial/garbage territories.
  if (isUnrecoverableTruncation(result)) {
    await appendLog(idea.id, 'coordinator', {
      kind: 'truncation_retry',
      payload: {
        stop_reason: result.response.stop_reason,
        reason: result.toolUse ? 'territories_missing_or_malformed' : 'tool_use_missing',
      },
    });
    const retryMessages = [
      ...messages,
      { role: 'assistant', content: (result.response.content || []) },
      {
        role: 'user',
        content:
          'Your previous emit_territories call was cut off by the max_tokens limit before it could finish. Re-emit it now via emit_territories — keep it to 3-4 territories with concise descriptions so it fits within budget this time.',
      },
    ];
    result = await runStructuredCall({ ...callArgs, messages: retryMessages });
  }

  const { response, toolUse, usage } = result;

  if (isUnrecoverableTruncation(result)) {
    throw new Error(
      `Coordinator emit_territories truncated after retry; got stop_reason=${response.stop_reason}`
    );
  }

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
  isUnrecoverableTruncation,
};
