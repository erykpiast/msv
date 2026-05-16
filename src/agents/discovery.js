const { runStructuredCall, webSearchTool } = require('../anthropic');
const { PERSPECTIVE_DISCOVERY } = require('./prompts');
const { appendLog } = require('../storage');

const EMIT_PERSONAS_TOOL = {
  name: 'emit_personas',
  description:
    'Emit the candidate persona roster (10–12 personas) and the web searches you ran.',
  input_schema: {
    type: 'object',
    required: ['search_queries', 'candidate_personas'],
    additionalProperties: false,
    properties: {
      search_queries: {
        type: 'array',
        items: { type: 'string' },
        minItems: 1,
        description: 'The web search queries you ran during discovery.',
      },
      candidate_personas: {
        type: 'array',
        minItems: 3,
        maxItems: 14,
        items: {
          type: 'object',
          required: ['name', 'tradition', 'stance', 'description'],
          additionalProperties: false,
          properties: {
            name: { type: 'string', minLength: 1, maxLength: 30 },
            tradition: { type: 'string', minLength: 1 },
            stance: { type: 'string', minLength: 1 },
            description: { type: 'string', minLength: 1 },
          },
        },
      },
    },
  },
};

async function runPerspectiveDiscovery({ client, idea, model, budget }) {
  const rawCapture = idea.raw_capture;

  await appendLog(idea.id, 'discovery', {
    kind: 'request',
    payload: { topic: rawCapture },
  });

  const { response, toolUse, usage } = await runStructuredCall({
    client,
    system: PERSPECTIVE_DISCOVERY,
    model,
    budget,
    maxTokens: 4000,
    messages: [
      {
        role: 'user',
        content: `Topic to investigate:\n\n${rawCapture}\n\nRun your discovery web searches, then emit the candidate persona roster via the emit_personas tool.`,
      },
    ],
    tools: [webSearchTool({ maxUses: 5 }), EMIT_PERSONAS_TOOL],
    forceTool: 'emit_personas',
  });

  const payload = toolUse.input;
  const candidatePersonas = (payload.candidate_personas || []).map((persona, index) => ({
    id: `p_${String(index + 1).padStart(3, '0')}`,
    name: persona.name,
    tradition: persona.tradition,
    stance: persona.stance,
    description: persona.description,
  }));

  await appendLog(idea.id, 'discovery', {
    kind: 'response',
    payload: {
      stop_reason: response.stop_reason,
      usage,
      candidate_count: candidatePersonas.length,
      search_query_count: (payload.search_queries || []).length,
    },
  });

  return {
    search_queries: payload.search_queries || [],
    candidate_personas: candidatePersonas,
    usage,
  };
}

module.exports = {
  runPerspectiveDiscovery,
};
