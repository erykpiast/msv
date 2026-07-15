const Anthropic = require('@anthropic-ai/sdk');
const apiQueue = require('./api_queue');
const { MODEL, SYNTHESIZER_MODEL } = require('./models');

// Explicit per-request timeout for the SDK. The SDK default is 10 minutes,
// which lets a single stalled call wedge the working-groups Promise.allSettled
// for ages (observed in production: one orphaned promise pinned the pipeline
// for 15+ minutes with 0% CPU and zero open sockets). 60s comfortably covers
// real model latency including web_search; anything longer is almost certainly
// a hang the queue-level watchdog should then surface. Heavier single calls
// (synthesizer over the full forum) pass an explicit timeoutMs to runStructuredCall.
const SDK_REQUEST_TIMEOUT_MS = 60_000;
// Slack between SDK timeout and the queue-level backstop, mirroring the
// PER_ATTEMPT_TIMEOUT_MS = 75_000 default in api_queue.js (60s + 15s).
const ATTEMPT_BACKSTOP_BUFFER_MS = 15_000;
// Retry budget added on top of a single attempt's timeout. Deliberately much
// larger than ATTEMPT_BACKSTOP_BUFFER_MS: this bounds total time spent
// retrying, not how long we tolerate a single hung request, so it can be
// generous without making a genuinely stuck call look "fine" for longer.
// Sized off a production incident where 6 concurrent working-group calls all
// stalled together for ~208s (a correlated upstream/network event, not
// independent bad luck) and the old 30_000 margin (giving 90s total at the
// 60s default) bought exactly one retry — nowhere near enough to ride it out.
// At the 60s default this now yields 300s total; scales with longer
// explicit timeoutMs (coordinator/researcher/synthesizer) too.
const WALL_CLOCK_RETRY_BUDGET_MS = 240_000;

function createClient() {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    throw new Error('ANTHROPIC_API_KEY is required');
  }
  const Ctor = Anthropic.default || Anthropic;
  return new Ctor({ apiKey, maxRetries: 0, timeout: SDK_REQUEST_TIMEOUT_MS });
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

// Detect an error payload in a web_search_tool_result block. Anthropic's
// web_search_20250305 returns `content` as either an array of web_search_result
// items (success) OR an object { type: 'web_search_tool_result_error',
// error_code: ... }. Some SDK builds may also nest the error inside the array.
function isWebSearchErrorContent(content) {
  if (content && !Array.isArray(content) && content.type === 'web_search_tool_result_error') {
    return true;
  }
  if (Array.isArray(content)) {
    return content.some((c) => c?.type === 'web_search_tool_result_error');
  }
  return false;
}

function parseWebSearchToolResult(content) {
  if (content && !Array.isArray(content) && content.type === 'web_search_tool_result_error') {
    return { results: [], error: { code: content.error_code ?? null } };
  }
  if (Array.isArray(content)) {
    const errorEntry = content.find((c) => c?.type === 'web_search_tool_result_error');
    if (errorEntry) {
      return { results: [], error: { code: errorEntry.error_code ?? null } };
    }
    const results = content
      .filter((r) => r.type === 'web_search_result')
      .map((r) => ({
        title: r.title || '',
        url: r.url || '',
        page_age: r.page_age ?? null,
      }));
    return { results, error: null };
  }
  return { results: [], error: { code: 'unknown' } };
}

function extractWebSearches(response) {
  const blocks = response?.content || [];
  const searches = [];
  let pending = null;
  let pendingResolved = false;
  const flushPending = () => {
    if (!pending) return;
    // Server_tool_use with no paired result block: surface as an error rather
    // than masquerading as a zero-hit success (which is how the original
    // bimodal-0/10 masking bug looked).
    if (!pendingResolved) pending.error = { code: 'unknown' };
    searches.push(pending);
  };
  for (const block of blocks) {
    if (block.type === 'server_tool_use' && block.name === 'web_search') {
      flushPending();
      pending = { query: block.input?.query || '', results: [], error: null };
      pendingResolved = false;
    } else if (block.type === 'web_search_tool_result' && pending) {
      const parsed = parseWebSearchToolResult(block.content);
      pending.results = parsed.results;
      pending.error = parsed.error;
      pendingResolved = true;
    }
  }
  flushPending();
  return searches;
}

// --- web_search retry service -----------------------------------------------
//
// web_search is a server-side tool: the search runs inside Anthropic's API
// call, not on our machine. Transport-level failures (429, 5xx, network) are
// already retried by apiQueue. But search-engine errors (too_many_requests,
// unavailable, ...) arrive as content blocks inside an HTTP-200 response and
// are invisible to apiQueue. This helper re-issues the WHOLE turn when a
// response carries a retryable web_search error.

const WEB_SEARCH_RETRYABLE_CODES = new Set(['too_many_requests', 'unavailable', 'unknown']);
const DEFAULT_WEB_SEARCH_RETRY_ATTEMPTS = 3;
const WEB_SEARCH_RETRY_BASE_MS = 2_000;
// Real Anthropic rate-limit windows are typically 30-60s; backoff has to span
// that or retries are guaranteed to hit the same rate-limit window.
const WEB_SEARCH_RETRY_MAX_MS = 30_000;

function isRetryableWebSearchError(err) {
  return !!err && WEB_SEARCH_RETRYABLE_CODES.has(err.code);
}

function summarizeSearches(searches) {
  let success = 0;
  let retryable = 0;
  let nonRetryable = 0;
  for (const s of searches) {
    if (!s.error) success += 1;
    else if (isRetryableWebSearchError(s.error)) retryable += 1;
    else nonRetryable += 1;
  }
  return {
    search_count: searches.length,
    success_count: success,
    retryable_error_count: retryable,
    non_retryable_error_count: nonRetryable,
  };
}

async function runWithWebSearchRetry({
  doCall,
  maxAttempts = DEFAULT_WEB_SEARCH_RETRY_ATTEMPTS,
  baseBackoffMs = WEB_SEARCH_RETRY_BASE_MS,
  maxBackoffMs = WEB_SEARCH_RETRY_MAX_MS,
  onAttempt,
  sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
  random = Math.random,
} = {}) {
  if (typeof doCall !== 'function') throw new Error('doCall is required');
  let response;
  let searches = [];
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    // Transport-level rejections from doCall (i.e. apiQueue gave up on 429s,
    // 5xx, or network errors) propagate to the caller intentionally.
    response = await doCall();
    searches = extractWebSearches(response);
    const summary = summarizeSearches(searches);
    if (onAttempt) {
      await onAttempt({ attempt, maxAttempts, response, summary });
    }
    // Retry only when EVERY search failed retryably. If anything succeeded, the
    // model has partial research context — better to fall through to whatever
    // the caller's fallback path is (e.g. discovery's forced-emit Turn 2) than
    // burn another full turn that will likely hit the same rate-limit window.
    const shouldRetry =
      summary.retryable_error_count > 0 &&
      summary.success_count === 0 &&
      attempt < maxAttempts;
    if (!shouldRetry) {
      return {
        response,
        attempts: attempt,
        searches,
        residual_errors: searches.filter((s) => s.error),
      };
    }
    const base = Math.min(baseBackoffMs * 2 ** (attempt - 1), maxBackoffMs);
    const jittered = base * (0.75 + random() * 0.5);
    await sleep(jittered);
  }
  // Unreachable: the loop always returns. Throw rather than return a half-
  // formed object so any future refactor that breaks the invariant fails loud.
  throw new Error('runWithWebSearchRetry: loop exited without returning');
}

function tokenUsage(response) {
  const usage = response?.usage || {};
  const input = (usage.input_tokens || 0) + (usage.cache_read_input_tokens || 0);
  const output = usage.output_tokens || 0;
  return { input, output, total: input + output };
}

/**
 * Shared core for runStructuredCall / runStructuredStreamingCall. Runs a call
 * that may use server-side tools (web_search) and is optionally required to
 * terminate by invoking a single forced client tool. Server tools don't need
 * client handling; the API resolves them transparently.
 *
 * Every call site gets the same truncation contract, regardless of transport:
 *   - `truncated` is true whenever stop_reason === 'max_tokens'.
 *   - If `forceTool` was set and the tool never appeared in the response
 *     because generation was cut off first, `toolUse` is null rather than
 *     throwing — a max_tokens cutoff is a partial result, not a contract
 *     violation, and callers should treat it as first-class, resumable/
 *     retryable state (checkpoint what's there, retry, or fall back)
 *     instead of the pipeline silently losing the work already done.
 *   - `toolUse` can also be non-null but truncated: the tool_use block
 *     appeared but its `input` may be missing fields the model ran out of
 *     room to emit. `truncated` tells the caller to validate defensively
 *     rather than trust the schema blindly (see researcher.js's
 *     normalizeReport for the pattern).
 *   - Any other missing-tool stop_reason (e.g. end_turn) is still a genuine
 *     contract violation and throws.
 *
 * Do NOT pass `budget` if this call is wrapped in `runWithWebSearchRetry` and
 * the caller's `onAttempt` already increments the budget — that would double-
 * count tokens and executor calls.
 */
async function runModelCall({
  client,
  system,
  messages,
  tools = [],
  forceTool,
  model = MODEL,
  maxTokens = 2400,
  budget,
  timeoutMs = SDK_REQUEST_TIMEOUT_MS,
  thinking,
  effort,
  streaming = false,
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
  if (thinking) {
    params.thinking = thinking;
  }
  if (effort) {
    params.output_config = { ...(params.output_config || {}), effort };
  }
  if (forceTool) {
    params.tool_choice = { type: 'tool', name: forceTool };
  }

  // Per-request SDK timeout overrides the client default. The queue-level
  // per-attempt backstop and wall-clock cap track it so a longer SDK timeout
  // isn't strangled by a shorter queue cap.
  const perAttemptTimeoutMs = timeoutMs + ATTEMPT_BACKSTOP_BUFFER_MS;
  const wallClockMaxMs = timeoutMs + WALL_CLOCK_RETRY_BUDGET_MS;
  const response = await apiQueue.enqueue(
    (signal) =>
      streaming
        ? client.messages.stream(params, { timeout: timeoutMs, signal }).finalMessage()
        : client.messages.create(params, { timeout: timeoutMs, signal }),
    { perAttemptTimeoutMs, wallClockMaxMs }
  );
  const usage = tokenUsage(response);
  if (budget) {
    budget.used_executor_calls = (budget.used_executor_calls || 0) + 1;
    budget.used_total_tokens = (budget.used_total_tokens || 0) + usage.total;
  }

  const web_searches = extractWebSearches(response);
  const truncated = response.stop_reason === 'max_tokens';

  if (forceTool) {
    const toolUse = extractToolUse(response, forceTool);
    if (!toolUse) {
      if (truncated) {
        return { response, toolUse: null, usage, web_searches, truncated };
      }
      throw new Error(
        `Expected forced tool call \`${forceTool}\`; got stop_reason=${response.stop_reason}`
      );
    }
    return { response, toolUse, usage, web_searches, truncated };
  }

  return { response, usage, web_searches, truncated };
}

/**
 * Non-streaming structured call. Default for research/debate/working-group
 * calls whose max_tokens ceiling comfortably fits under the non-streaming
 * SDK's completion timeout. See runModelCall for the shared truncation
 * contract (`truncated`, nullable `toolUse`).
 */
async function runStructuredCall(opts) {
  return runModelCall({ ...opts, streaming: false });
}

/**
 * Streaming counterpart to runStructuredCall, for calls that need genuine
 * max_tokens headroom (the non-streaming SDK path times out well before a
 * large adaptive-thinking + structured-output response can complete). Same
 * contract and params as runStructuredCall; swap freely between the two.
 */
async function runStructuredStreamingCall(opts) {
  return runModelCall({ ...opts, streaming: true });
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
  parseWebSearchToolResult,
  isWebSearchErrorContent,
  isRetryableWebSearchError,
  runWithWebSearchRetry,
  tokenUsage,
  runModelCall,
  runStructuredCall,
  runStructuredStreamingCall,
  getStats: apiQueue.getStats,
};
