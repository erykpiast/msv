const test = require('node:test');
const assert = require('node:assert/strict');
const {
  extractWebSearches,
  runStructuredCall,
  runStructuredStreamingCall,
} = require('../src/anthropic');

// Non-streaming mock: exercises runStructuredCall (client.messages.create).
function makeCreateClient(handler) {
  return { messages: { create: async (params, opts) => handler(params, opts) } };
}

// Streaming mock: exercises runStructuredStreamingCall (client.messages.stream().finalMessage()).
function makeStreamClient(handler) {
  return {
    messages: {
      stream(params, opts) {
        return { finalMessage: async () => handler(params, opts) };
      },
    },
  };
}

function baseCallArgs(overrides = {}) {
  return {
    system: 'system prompt',
    messages: [{ role: 'user', content: 'hi' }],
    tools: [{ name: 'emit_thing' }],
    forceTool: 'emit_thing',
    ...overrides,
  };
}

function makeWebSearchResponse(blocks) {
  return { content: blocks };
}

function searchPair(query, content) {
  return [
    { type: 'server_tool_use', name: 'web_search', input: { query } },
    { type: 'web_search_tool_result', content },
  ];
}

test('extractWebSearches pairs server_tool_use with web_search_tool_result blocks', () => {
  const response = {
    content: [
      {
        type: 'server_tool_use',
        name: 'web_search',
        input: { query: 'second brain limits' },
      },
      {
        type: 'web_search_tool_result',
        content: [
          {
            type: 'web_search_result',
            title: 'Tiago Forte critique',
            url: 'https://example.com/critique',
            page_age: '2 years',
            encrypted_content: 'opaque-body',
          },
          {
            type: 'web_search_result',
            title: 'Counter-argument',
            url: 'https://example.com/counter',
          },
        ],
      },
      { type: 'text', text: 'reasoning between searches' },
      {
        type: 'server_tool_use',
        name: 'web_search',
        input: { query: 'zettelkasten review cadence' },
      },
      {
        type: 'web_search_tool_result',
        content: [
          {
            type: 'web_search_result',
            title: 'Andy Matuschak notes',
            url: 'https://example.com/notes',
          },
        ],
      },
    ],
  };
  const searches = extractWebSearches(response);
  assert.equal(searches.length, 2);
  assert.equal(searches[0].query, 'second brain limits');
  assert.equal(searches[0].results.length, 2);
  assert.equal(searches[0].results[0].title, 'Tiago Forte critique');
  assert.equal(searches[0].results[0].url, 'https://example.com/critique');
  // SDK constraint: no snippet, only encrypted_content (which we discard).
  assert.equal(searches[0].results[0].page_age, '2 years');
  assert.ok(!('snippet' in searches[0].results[0]));
  assert.equal(searches[1].query, 'zettelkasten review cadence');
  // Successful pairs report error: null so consumers can distinguish empty-but-valid
  // result sets from API errors.
  assert.equal(searches[0].error, null);
  assert.equal(searches[1].error, null);
});

test('extractWebSearches tolerates missing or partial content', () => {
  assert.deepEqual(extractWebSearches({}), []);
  assert.deepEqual(extractWebSearches({ content: [] }), []);
  assert.deepEqual(
    extractWebSearches({
      content: [{ type: 'text', text: 'no tool calls here' }],
    }),
    []
  );
});

test('extractWebSearches captures web_search_tool_result_error as object content', () => {
  // Anthropic's primary error shape: content is a single error object.
  const response = makeWebSearchResponse(
    searchPair('rate limited query', {
      type: 'web_search_tool_result_error',
      error_code: 'too_many_requests',
    })
  );
  const searches = extractWebSearches(response);
  assert.equal(searches.length, 1);
  assert.equal(searches[0].query, 'rate limited query');
  assert.deepEqual(searches[0].results, []);
  assert.equal(searches[0].error.code, 'too_many_requests');
});

test('extractWebSearches reports error: null on a legitimate zero-hit success', () => {
  // Empty array content is success with no results, distinct from an error.
  const response = makeWebSearchResponse(searchPair('extremely obscure phrase', []));
  const searches = extractWebSearches(response);
  assert.equal(searches.length, 1);
  assert.deepEqual(searches[0].results, []);
  assert.equal(searches[0].error, null);
});

test('extractWebSearches surfaces orphaned server_tool_use with error: unknown', () => {
  // A server_tool_use block with no paired result block: surfaced as an error
  // rather than masquerading as a zero-hit success.
  const response = makeWebSearchResponse([
    { type: 'server_tool_use', name: 'web_search', input: { query: 'dropped' } },
  ]);
  const searches = extractWebSearches(response);
  assert.equal(searches.length, 1);
  assert.equal(searches[0].query, 'dropped');
  assert.equal(searches[0].error.code, 'unknown');
});

test('extractWebSearches flags first orphaned search even when later searches resolve', () => {
  // Two server_tool_use blocks, only the second one has a result.
  const response = makeWebSearchResponse([
    { type: 'server_tool_use', name: 'web_search', input: { query: 'first dropped' } },
    { type: 'server_tool_use', name: 'web_search', input: { query: 'second ok' } },
    {
      type: 'web_search_tool_result',
      content: [{ type: 'web_search_result', title: 'T', url: 'https://x.example' }],
    },
  ]);
  const searches = extractWebSearches(response);
  assert.equal(searches.length, 2);
  assert.equal(searches[0].query, 'first dropped');
  assert.equal(searches[0].error.code, 'unknown');
  assert.equal(searches[1].query, 'second ok');
  assert.equal(searches[1].error, null);
});

test('extractWebSearches captures web_search_tool_result_error nested in array content', () => {
  // Defensive: if a future SDK build wraps the error inside the content array,
  // we still surface it as an error rather than silently dropping it.
  const response = makeWebSearchResponse(
    searchPair('upstream failure', [
      { type: 'web_search_tool_result_error', error_code: 'unavailable' },
    ])
  );
  const searches = extractWebSearches(response);
  assert.equal(searches.length, 1);
  assert.deepEqual(searches[0].results, []);
  assert.equal(searches[0].error.code, 'unavailable');
});

test('extractWebSearches handles mixed success / error / success sequence', () => {
  const response = makeWebSearchResponse([
    ...searchPair('hit one', [
      { type: 'web_search_result', title: 'A', url: 'https://a.example' },
    ]),
    ...searchPair('rate limited', {
      type: 'web_search_tool_result_error',
      error_code: 'too_many_requests',
    }),
    ...searchPair('hit two', [
      { type: 'web_search_result', title: 'B', url: 'https://b.example' },
      { type: 'web_search_result', title: 'C', url: 'https://c.example' },
    ]),
  ]);
  const searches = extractWebSearches(response);
  assert.equal(searches.length, 3);
  assert.equal(searches[0].results.length, 1);
  assert.equal(searches[0].error, null);
  assert.equal(searches[1].results.length, 0);
  assert.equal(searches[1].error.code, 'too_many_requests');
  assert.equal(searches[2].results.length, 2);
  assert.equal(searches[2].error, null);
});

test('extractWebSearches reports unknown error for unrecognized content shapes', () => {
  // Missing content.
  const r1 = extractWebSearches(
    makeWebSearchResponse([
      { type: 'server_tool_use', name: 'web_search', input: { query: 'q1' } },
      { type: 'web_search_tool_result' /* no content */ },
    ])
  );
  assert.equal(r1[0].error.code, 'unknown');
  // Object content with neither error shape nor result array.
  const r2 = extractWebSearches(makeWebSearchResponse(searchPair('q2', { foo: 'bar' })));
  assert.equal(r2[0].error.code, 'unknown');
});

// ---------------------------------------------------------------------------
// runStructuredCall / runStructuredStreamingCall — shared truncation contract
//
// Both transports (create vs stream) must behave identically here: this is
// the whole point of unifying them on runModelCall. Each case below runs
// against both runStructuredCall (non-streaming) and runStructuredStreamingCall
// (streaming) with an otherwise-identical response, to prove neither transport
// silently drops the max_tokens signal or loses partial tool input.
// ---------------------------------------------------------------------------

const TRANSPORTS = [
  { name: 'runStructuredCall (non-streaming)', run: runStructuredCall, makeClient: makeCreateClient },
  { name: 'runStructuredStreamingCall (streaming)', run: runStructuredStreamingCall, makeClient: makeStreamClient },
];

for (const { name, run, makeClient } of TRANSPORTS) {
  test(`${name}: returns truncated: false on a normal tool_use completion`, async () => {
    const client = makeClient(async () => ({
      stop_reason: 'tool_use',
      content: [{ type: 'tool_use', id: 'x', name: 'emit_thing', input: { foo: 'bar' } }],
      usage: { input_tokens: 10, output_tokens: 10 },
    }));
    const result = await run({ client, ...baseCallArgs() });
    assert.equal(result.truncated, false);
    assert.deepEqual(result.toolUse.input, { foo: 'bar' });
  });

  test(`${name}: returns truncated: true and toolUse: null when max_tokens hits before the forced tool block appears`, async () => {
    // The model ran out of output tokens before it could even start the
    // tool_use block — extractToolUse finds nothing. Must not throw; must
    // surface truncated: true so the caller can retry/resume instead of
    // treating this as a contract violation.
    const client = makeClient(async () => ({
      stop_reason: 'max_tokens',
      content: [{ type: 'text', text: 'reasoning that ran out of room...' }],
      usage: { input_tokens: 10, output_tokens: 4000 },
    }));
    const result = await run({ client, ...baseCallArgs() });
    assert.equal(result.truncated, true);
    assert.equal(result.toolUse, null);
  });

  test(`${name}: returns truncated: true alongside a present-but-incomplete toolUse.input`, async () => {
    // The tool_use block appeared, but generation was cut off mid-JSON, so
    // some required fields never got written. truncated: true tells the
    // caller to validate defensively rather than trust the schema.
    const client = makeClient(async () => ({
      stop_reason: 'max_tokens',
      content: [{ type: 'tool_use', id: 'x', name: 'emit_thing', input: { partial: true } }],
      usage: { input_tokens: 10, output_tokens: 4000 },
    }));
    const result = await run({ client, ...baseCallArgs() });
    assert.equal(result.truncated, true);
    assert.deepEqual(result.toolUse.input, { partial: true });
  });

  test(`${name}: still throws when the forced tool is missing for a non-max_tokens reason`, async () => {
    // end_turn (or any other stop_reason) with no forced tool block is a
    // genuine contract violation, not a truncation — must keep throwing.
    const client = makeClient(async () => ({
      stop_reason: 'end_turn',
      content: [{ type: 'text', text: 'I decline.' }],
      usage: { input_tokens: 10, output_tokens: 5 },
    }));
    await assert.rejects(
      () => run({ client, ...baseCallArgs() }),
      /Expected forced tool call `emit_thing`; got stop_reason=end_turn/
    );
  });

  test(`${name}: returns truncated: false and no toolUse when forceTool is absent and stop_reason is end_turn`, async () => {
    const client = makeClient(async () => ({
      stop_reason: 'end_turn',
      content: [{ type: 'text', text: 'done, no tool call needed' }],
      usage: { input_tokens: 10, output_tokens: 5 },
    }));
    const result = await run({ client, ...baseCallArgs({ forceTool: undefined }) });
    assert.equal(result.truncated, false);
    assert.equal(result.toolUse, undefined);
  });

  test(`${name}: increments budget.used_executor_calls and used_total_tokens once per call`, async () => {
    const client = makeClient(async () => ({
      stop_reason: 'tool_use',
      content: [{ type: 'tool_use', id: 'x', name: 'emit_thing', input: {} }],
      usage: { input_tokens: 100, output_tokens: 50 },
    }));
    const budget = {};
    await run({ client, budget, ...baseCallArgs() });
    assert.equal(budget.used_executor_calls, 1);
    assert.equal(budget.used_total_tokens, 150);
  });
}
