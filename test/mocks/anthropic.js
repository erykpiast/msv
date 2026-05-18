'use strict';

// Minimal mock Anthropic client for integration tests.
//
// Supports all tool calls the pipeline makes. Returns the smallest valid
// response for each tool so the pipeline can complete without real API calls.
// Programmable failure injection lets tests simulate specific error scenarios.

const { WallClockCapError } = require('../../src/failure');

const TOOL_INPUTS = {
  emit_personas: {
    candidate_personas: [
      {
        id: 'p_001',
        name: 'Mock Researcher',
        role: 'Researcher',
        background: 'Academic background',
        stance: 'Neutral',
        tradition: 'Empirical',
        description: 'A test persona.',
        research_lens: 'Empirical analysis',
      },
      {
        id: 'p_002',
        name: 'Mock Practitioner',
        role: 'Practitioner',
        background: 'Industry background',
        stance: 'Pragmatic',
        tradition: 'Applied',
        description: 'A practitioner persona.',
        research_lens: 'Applied analysis',
      },
    ],
  },
  emit_territories: {
    territories: [
      {
        name: 'Territory Alpha',
        description: 'First test territory.',
        rationale: 'Testing coverage.',
        assigned_pair: ['skeptic', 'builder'],
      },
      {
        name: 'Territory Beta',
        description: 'Second test territory.',
        rationale: 'Testing parallelism.',
        assigned_pair: ['skeptic', 'builder'],
      },
    ],
  },
  emit_candidate_questions: {
    candidate_questions: [
      { question: 'Mock question 1?', predicted_confidence: 7 },
      { question: 'Mock question 2?', predicted_confidence: 6 },
    ],
  },
  emit_adversarial_marks: { marks: [] },
  emit_alignment_move: {
    type: 'Accept',
    candidate_id: null,
    content: 'Accepted.',
    is_final: true,
  },
  emit_researcher_report: {
    outcome: 'findings',
    findings: [
      {
        finding_id: 'f_mock_001',
        content: 'Mock finding content.',
        confidence: 7,
        cited_source_urls: [],
      },
    ],
    search_trace: [],
  },
  emit_observations: {
    observations: [
      {
        content: 'Mock observation.',
        cited_finding_ids: ['f_mock_001'],
      },
    ],
  },
  // emit_move returns null to terminate debate/reaction loops immediately.
  // runDebateMove returns toolUse.input (which will be null); calling code
  // checks `if (!move) break;` so the loop exits on the first turn.
  emit_move: null,
  // emit_reaction: returning an object without references_claim_id means the
  // reaction is skipped by the cross-pollination aggregation loop.
  emit_reaction: {
    by_persona_id: 'skeptic',
    type: 'Question',
    content: 'Mock reaction.',
    confidence: 5,
    evidence_basis: 'Mock evidence.',
  },
  emit_synthesis: {
    report: 'Mock synthesis report. '.repeat(12),
    headline_findings: [
      'Mock finding one.',
      'Mock finding two.',
      'Mock finding three.',
    ],
    open_tensions: ['Mock tension.'],
    question_landscape: [],
    dead_end_summary: null,
  },
  emit_contradiction_judgement: {
    contradicts: false,
    reason: 'No contradiction in test data.',
  },
};

const MOCK_USAGE = {
  input_tokens: 10,
  output_tokens: 10,
  cache_read_input_tokens: 0,
  cache_creation_input_tokens: 0,
};

function makeResponse(toolName) {
  if (!Object.prototype.hasOwnProperty.call(TOOL_INPUTS, toolName)) {
    // Unknown tool: return end_turn with no tool use — safe fallback.
    return {
      content: [{ type: 'text', text: 'OK' }],
      stop_reason: 'end_turn',
      usage: MOCK_USAGE,
    };
  }
  const input = TOOL_INPUTS[toolName];
  if (input === null) {
    // null input → stop_reason end_turn so loops terminate (the calling code
    // checks `if (!move) break;` or `if (!reaction) continue;`).
    return {
      content: [{ type: 'text', text: 'Done.' }],
      stop_reason: 'end_turn',
      usage: MOCK_USAGE,
    };
  }
  return {
    content: [{ type: 'tool_use', id: `mock_${toolName}_${Date.now()}`, name: toolName, input }],
    stop_reason: 'tool_use',
    usage: MOCK_USAGE,
  };
}

// Tools that production code legitimately calls without setting tool_choice.
// The researcher is the only such case today: it lets the model alternate
// between web_search and emit_researcher_report. Extend this list rather than
// adding new fallbacks.
const KNOWN_UNFORCED_TOOLS = ['emit_researcher_report'];

// When forceTool is absent, detect the intended tool from the tools list.
// Throws if no tool can be identified — failing loudly is preferable to the
// mock silently routing to a wrong response.
function detectTool(params) {
  const forced = params.tool_choice?.name;
  if (forced) return forced;
  const toolNames = (params.tools || []).map((t) => t.name);
  const match = KNOWN_UNFORCED_TOOLS.find((t) => toolNames.includes(t));
  if (match) return match;
  throw new Error(
    `Mock: cannot identify tool — no tool_choice.name and tools=[${toolNames.join(', ')}] matched no known unforced tools. ` +
      'Either add an entry to KNOWN_UNFORCED_TOOLS or make the production caller pass tool_choice.'
  );
}

// Failure spec: { tool, afterCalls, status }
// tool: the tool_choice.name that triggers the failure
// afterCalls: fire when the (cumulative) call index reaches this count
// status: HTTP status code to attach to the thrown error
function shouldFail(failSpec, toolName, totalCalls) {
  if (!failSpec || !failSpec.tool) return false;
  if (toolName !== failSpec.tool) return false;
  const after = failSpec.afterCalls ?? 0;
  return totalCalls > after;
}

function buildFailError(failSpec, toolName, callIndex) {
  if (failSpec.useWallClockMessage) {
    // WallClockCapError is classified as 'anthropic_unavailable' by failure.js
    // and is NOT retried by api_queue (no .status, no .code), so tests stay fast.
    // Using the production class keeps the contract type-checked rather than
    // regex-matched.
    return new WallClockCapError(
      `Mock wall-clock cap for tool=${toolName} at call #${callIndex}`,
      { cause: new Error(`Mock underlying failure for tool=${toolName}`) }
    );
  }
  const err = new Error(`Mock failure injected for tool=${toolName} at call #${callIndex}`);
  err.status = failSpec.status ?? 500;
  return err;
}

/**
 * @param {object} [options]
 * @param {{ tool: string, afterCalls?: number, status?: number }} [options.fail]
 *   Inject a failure when calls to `tool` exceed `afterCalls` (default 0 = first call).
 * @returns {object} Mock Anthropic client shaped like the SDK's Anthropic instance.
 */
function createMockClient(options = {}) {
  let totalCalls = 0;
  const callLog = [];
  let failSpec = options.fail || null;

  const client = {
    /** Total API call count (create + stream combined). */
    callCount() {
      return totalCalls;
    },
    /** Remove the injected failure so subsequent calls succeed. */
    unfail() {
      failSpec = null;
    },
    /**
     * Returns a map of toolName → call count for calls since the given index.
     * Useful for verifying that skipped stages made zero calls.
     */
    callsByStageSince(before) {
      return callLog.slice(before).reduce((acc, { tool }) => {
        acc[tool] = (acc[tool] || 0) + 1;
        return acc;
      }, {});
    },
    messages: {
      async create(params) {
        totalCalls += 1;
        const tool = detectTool(params);
        callLog.push({ tool, index: totalCalls });

        if (shouldFail(failSpec, tool, totalCalls)) {
          throw buildFailError(failSpec, tool, totalCalls);
        }

        return makeResponse(tool);
      },

      // discovery.js uses client.messages.stream (streaming API).
      stream(params) {
        let blockListeners = [];
        const tool = detectTool(params);

        return {
          on(event, listener) {
            if (event === 'contentBlock') blockListeners.push(listener);
            return this;
          },
          async finalMessage() {
            totalCalls += 1;
            callLog.push({ tool, index: totalCalls });

            if (shouldFail(failSpec, tool, totalCalls)) {
              throw buildFailError(failSpec, tool, totalCalls);
            }

            const input = TOOL_INPUTS[tool];
            if (input == null) {
              throw new Error(`Mock stream(): tool=${tool} has no input fixture (input=${input}).`);
            }
            const block = {
              type: 'tool_use',
              id: `mock_stream_${tool}_${Date.now()}`,
              name: tool,
              input,
            };
            // Trigger any registered contentBlock listeners (used by discovery for
            // streaming-progress callbacks).
            blockListeners.forEach((l) => l(block));

            return {
              content: [block],
              stop_reason: 'tool_use',
              usage: MOCK_USAGE,
            };
          },
        };
      },
    },
  };

  return client;
}

module.exports = { createMockClient };
