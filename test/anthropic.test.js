const test = require('node:test');
const assert = require('node:assert/strict');
const { extractWebSearches } = require('../src/anthropic');

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
