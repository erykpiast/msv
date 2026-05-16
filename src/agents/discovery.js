const {
  webSearchTool,
  extractWebSearches,
  extractToolUse,
  tokenUsage,
} = require('../anthropic');
const apiQueue = require('../api_queue');
const { PERSPECTIVE_DISCOVERY } = require('./prompts');
const { appendLog } = require('../storage');

const DISCOVERY_SEARCH_BUDGET = 3;
const DISCOVERY_MAX_TOKENS = 8000;

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

// Stream a messages.create with progress callback for incremental visibility.
// Returns the final assembled Message (same shape as non-stream create).
async function streamWithProgress(client, params, onContentBlock) {
  const stream = client.messages.stream(params);
  if (onContentBlock) {
    stream.on('contentBlock', onContentBlock);
  }
  return await stream.finalMessage();
}

// Two-call flow: first call lets the model use web_search (a server tool that
// resolves within the same response) and optionally emit personas. If it
// didn't emit, a second call forces emit_personas with the prior context.
// Forcing emit_personas from the first turn blocks web_search entirely and
// frequently yields empty persona rosters.
async function runPerspectiveDiscovery({ client, idea, model, budget, onProgress }) {
  const rawCapture = idea.raw_capture;

  await appendLog(idea.id, 'discovery', {
    kind: 'request',
    payload: { topic: rawCapture },
  });

  const tools = [webSearchTool({ maxUses: DISCOVERY_SEARCH_BUDGET }), EMIT_PERSONAS_TOOL];
  const messages = [
    {
      role: 'user',
      content: `Topic to investigate:\n\n${rawCapture}\n\nRun your discovery web searches first, then emit the candidate persona roster via the emit_personas tool.`,
    },
  ];

  const firstResponse = await apiQueue.enqueue(() =>
    streamWithProgress(
      client,
      {
        model,
        system: PERSPECTIVE_DISCOVERY,
        max_tokens: DISCOVERY_MAX_TOKENS,
        messages,
        tools,
      },
      (block) => {
        if (!onProgress) return;
        if (block.type === 'server_tool_use' && block.name === 'web_search') {
          onProgress(`web_search: ${block.input?.query || '(no query)'}`);
        } else if (block.type === 'web_search_tool_result') {
          const count = Array.isArray(block.content) ? block.content.length : 0;
          onProgress(`web_search returned ${count} results`);
        } else if (block.type === 'tool_use' && block.name === 'emit_personas') {
          const n = (block.input?.candidate_personas || []).length;
          onProgress(`emit_personas (${n} candidates)`);
        }
      }
    )
  );
  const firstUsage = tokenUsage(firstResponse);
  if (budget) {
    budget.used_executor_calls = (budget.used_executor_calls || 0) + 1;
    budget.used_total_tokens = (budget.used_total_tokens || 0) + firstUsage.total;
  }

  const firstSearches = extractWebSearches(firstResponse);
  for (const search of firstSearches) {
    await appendLog(idea.id, 'discovery', { kind: 'web_search', payload: search });
  }
  await appendLog(idea.id, 'discovery', {
    kind: 'turn',
    payload: {
      turn_index: 0,
      stop_reason: firstResponse.stop_reason,
      usage: firstUsage,
      server_tool_calls: firstSearches.length,
      forced: false,
    },
  });

  // Treat a tool_use block as a successful emit only if it actually carries
  // personas. Anthropic returns a partial tool_use block when the model hits
  // max_tokens mid-emit (input cut off), which would otherwise look like a
  // valid empty roster and skip the retry.
  const firstEmit = extractToolUse(firstResponse, 'emit_personas');
  const firstEmitPersonas = Array.isArray(firstEmit?.input?.candidate_personas)
    ? firstEmit.input.candidate_personas
    : [];
  let toolUse = firstEmitPersonas.length > 0 ? firstEmit : null;
  let finalResponse = firstResponse;
  let finalUsage = firstUsage;

  if (!toolUse) {
    // Drop any client tool_use blocks (e.g. partial emit_personas from
    // max_tokens) — they require a paired tool_result in the next user
    // message, which we don't have. Server tools resolve inline so their
    // server_tool_use / web_search_tool_result pairs stay intact.
    const cleanedContent = (firstResponse.content || []).filter(
      (block) => !(block.type === 'tool_use' && block.name === 'emit_personas')
    );
    if (cleanedContent.length > 0) {
      messages.push({ role: 'assistant', content: cleanedContent });
    }
    messages.push({
      role: 'user',
      content:
        'Now emit the candidate persona roster via the emit_personas tool, based on what you learned from your searches.',
    });

    const secondResponse = await apiQueue.enqueue(() =>
      streamWithProgress(
        client,
        {
          model,
          system: PERSPECTIVE_DISCOVERY,
          max_tokens: DISCOVERY_MAX_TOKENS,
          messages,
          tools: [EMIT_PERSONAS_TOOL],
          tool_choice: { type: 'tool', name: 'emit_personas' },
        },
        (block) => {
          if (!onProgress) return;
          if (block.type === 'tool_use' && block.name === 'emit_personas') {
            const n = (block.input?.candidate_personas || []).length;
            onProgress(`emit_personas retry (${n} candidates)`);
          }
        }
      )
    );
    const secondUsage = tokenUsage(secondResponse);
    if (budget) {
      budget.used_executor_calls = (budget.used_executor_calls || 0) + 1;
      budget.used_total_tokens = (budget.used_total_tokens || 0) + secondUsage.total;
    }
    await appendLog(idea.id, 'discovery', {
      kind: 'turn',
      payload: {
        turn_index: 1,
        stop_reason: secondResponse.stop_reason,
        usage: secondUsage,
        server_tool_calls: 0,
        forced: true,
      },
    });
    toolUse = extractToolUse(secondResponse, 'emit_personas');
    finalResponse = secondResponse;
    finalUsage = secondUsage;
  }

  if (!toolUse) {
    throw new Error(
      `Perspective discovery did not emit personas; final stop_reason=${finalResponse?.stop_reason}`
    );
  }

  const payload = toolUse.input || {};
  const rawPersonas = Array.isArray(payload.candidate_personas) ? payload.candidate_personas : [];
  const candidatePersonas = rawPersonas.map((persona, index) => ({
    id: `p_${String(index + 1).padStart(3, '0')}`,
    name: persona.name,
    tradition: persona.tradition,
    stance: persona.stance,
    description: persona.description,
  }));

  await appendLog(idea.id, 'discovery', {
    kind: 'response',
    payload: {
      stop_reason: finalResponse?.stop_reason,
      usage: finalUsage,
      candidate_count: candidatePersonas.length,
      search_query_count: (payload.search_queries || []).length,
      web_searches_run: firstSearches.length,
    },
  });

  if (candidatePersonas.length === 0) {
    throw new Error('Perspective discovery emitted zero candidate personas');
  }

  return {
    search_queries: payload.search_queries || [],
    candidate_personas: candidatePersonas,
    usage: finalUsage,
  };
}

module.exports = {
  runPerspectiveDiscovery,
};
