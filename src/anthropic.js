const Anthropic = require('@anthropic-ai/sdk');

const DEFAULT_MODEL = 'claude-sonnet-4-6';
const DEFAULT_MAX_RETRIES = 3;
const RETRY_BACKOFF_MS = 1000;

function createClient() {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    throw new Error('ANTHROPIC_API_KEY is required');
  }
  const Ctor = Anthropic.default || Anthropic;
  return new Ctor({ apiKey });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function withRetries(fn, { retries = DEFAULT_MAX_RETRIES } = {}) {
  let lastError;
  for (let attempt = 1; attempt <= retries; attempt += 1) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      const status = error?.status || error?.response?.status;
      const retryable = !status || status === 429 || (status >= 500 && status < 600);
      if (!retryable || attempt === retries) {
        break;
      }
      const wait = RETRY_BACKOFF_MS * 2 ** (attempt - 1);
      await sleep(wait);
    }
  }
  throw lastError;
}

function webSearchTool({ maxUses = 3 } = {}) {
  return {
    type: 'web_search_20250305',
    name: 'web_search',
    max_uses: maxUses,
  };
}

function extractToolUse(response, toolName) {
  const blocks = response?.content || [];
  return blocks.find((block) => block.type === 'tool_use' && block.name === toolName) || null;
}

function tokenUsage(response) {
  const usage = response?.usage || {};
  const input = (usage.input_tokens || 0) + (usage.cache_read_input_tokens || 0);
  const output = usage.output_tokens || 0;
  return { input, output, total: input + output };
}

/**
 * Run a single call that may use server-side tools (web_search) and is required
 * to terminate by invoking a single forced client tool. The loop drives the
 * web-search/server-tool resolution that the API handles internally — server
 * tools don't need client handling; we just keep stepping until the model emits
 * the forced tool call or hits stop_reason: end_turn.
 *
 * If `forceTool` is provided, we set tool_choice to force that tool. The first
 * occurrence of that tool's input is returned. Server tools (web_search) are
 * still permitted; the API resolves them transparently.
 */
async function runStructuredCall({
  client,
  system,
  messages,
  tools = [],
  forceTool,
  model = DEFAULT_MODEL,
  maxTokens = 2400,
  budget,
}) {
  if (!client) throw new Error('client is required');
  if (!Array.isArray(messages) || messages.length === 0) {
    throw new Error('messages must be a non-empty array');
  }

  const params = {
    model,
    system,
    max_tokens: maxTokens,
    messages,
    tools,
  };
  if (forceTool) {
    params.tool_choice = { type: 'tool', name: forceTool };
  }

  const response = await withRetries(() => client.messages.create(params));
  const usage = tokenUsage(response);
  if (budget) {
    budget.used_executor_calls = (budget.used_executor_calls || 0) + 1;
    budget.used_total_tokens = (budget.used_total_tokens || 0) + usage.total;
  }

  if (forceTool) {
    const toolUse = extractToolUse(response, forceTool);
    if (!toolUse) {
      throw new Error(
        `Expected forced tool call \`${forceTool}\`; got stop_reason=${response.stop_reason}`
      );
    }
    return { response, toolUse, usage };
  }

  return { response, usage };
}

module.exports = {
  DEFAULT_MODEL,
  createClient,
  withRetries,
  webSearchTool,
  extractToolUse,
  tokenUsage,
  runStructuredCall,
};
