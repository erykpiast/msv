const Anthropic = require('@anthropic-ai/sdk');

const DEFAULT_MODEL = 'claude-sonnet-4-20250514';
const DEFAULT_MAX_RETRIES = 3;

function createClient() {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    throw new Error('ANTHROPIC_API_KEY is required');
  }
  return new Anthropic({ apiKey });
}

async function withRetries(fn, { retries = DEFAULT_MAX_RETRIES } = {}) {
  let lastError;
  for (let attempt = 1; attempt <= retries; attempt += 1) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      if (attempt === retries) {
        break;
      }
      await new Promise((resolve) => {
        setTimeout(resolve, 250 * 2 ** (attempt - 1));
      });
    }
  }
  throw lastError;
}

async function runAgentWithToolLoop({
  client = createClient(),
  system,
  messages,
  tools = [],
  toolHandler,
  model = DEFAULT_MODEL,
  maxTokens = 2400,
  maxTurns = 8,
}) {
  if (!Array.isArray(messages) || messages.length === 0) {
    throw new Error('messages must be a non-empty array');
  }

  const transcript = [...messages];

  for (let turn = 0; turn < maxTurns; turn += 1) {
    const response = await withRetries(() =>
      client.messages.create({
        model,
        system,
        max_tokens: maxTokens,
        messages: transcript,
        tools,
      })
    );

    transcript.push({
      role: 'assistant',
      content: response.content,
    });

    const toolCalls = (response.content || []).filter((item) => item.type === 'tool_use');
    if (toolCalls.length === 0) {
      return { response, transcript };
    }

    if (typeof toolHandler !== 'function') {
      throw new Error('toolHandler is required when model emits tool_use blocks');
    }

    const toolResults = [];
    for (const call of toolCalls) {
      const result = await toolHandler(call);
      toolResults.push({
        type: 'tool_result',
        tool_use_id: call.id,
        content: typeof result === 'string' ? result : JSON.stringify(result),
      });
    }

    transcript.push({
      role: 'user',
      content: toolResults,
    });
  }

  throw new Error('Tool-use loop reached max turns');
}

module.exports = {
  DEFAULT_MODEL,
  createClient,
  withRetries,
  runAgentWithToolLoop,
};
