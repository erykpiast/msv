const Anthropic = require('@anthropic-ai/sdk');
const apiQueue = require('./api_queue');
const { MODEL, SYNTHESIZER_MODEL } = require('./models');

function createClient() {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    throw new Error('ANTHROPIC_API_KEY is required');
  }
  const Ctor = Anthropic.default || Anthropic;
  return new Ctor({ apiKey, maxRetries: 0 });
}

// withRetries kept for backward compat during v4 → v5 transition; new code
// routes through apiQueue.enqueue() instead.
async function withRetries(fn) {
  return apiQueue.enqueue(fn);
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

function extractWebSearches(response) {
  const blocks = response?.content || [];
  const searches = [];
  let pending = null;
  for (const block of blocks) {
    if (block.type === 'server_tool_use' && block.name === 'web_search') {
      if (pending) searches.push(pending);
      pending = { query: block.input?.query || '', results: [] };
    } else if (block.type === 'web_search_tool_result' && pending) {
      const content = Array.isArray(block.content) ? block.content : [];
      pending.results = content
        .filter((r) => r.type === 'web_search_result')
        .map((r) => ({
          title: r.title || '',
          url: r.url || '',
          page_age: r.page_age ?? null,
        }));
    }
  }
  if (pending) searches.push(pending);
  return searches;
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
  model = MODEL,
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

  const response = await apiQueue.enqueue(() => client.messages.create(params));
  const usage = tokenUsage(response);
  if (budget) {
    budget.used_executor_calls = (budget.used_executor_calls || 0) + 1;
    budget.used_total_tokens = (budget.used_total_tokens || 0) + usage.total;
  }

  const web_searches = extractWebSearches(response);

  if (forceTool) {
    const toolUse = extractToolUse(response, forceTool);
    if (!toolUse) {
      throw new Error(
        `Expected forced tool call \`${forceTool}\`; got stop_reason=${response.stop_reason}`
      );
    }
    return { response, toolUse, usage, web_searches };
  }

  return { response, usage, web_searches };
}

function webFetchTool({ maxUses = 6 } = {}) {
  return {
    type: 'web_fetch_20250910',
    name: 'web_fetch',
    max_uses: maxUses,
  };
}

module.exports = {
  MODEL,
  SYNTHESIZER_MODEL,
  createClient,
  withRetries,
  webSearchTool,
  webFetchTool,
  extractToolUse,
  extractWebSearches,
  tokenUsage,
  runStructuredCall,
  getStats: apiQueue.getStats,
};
