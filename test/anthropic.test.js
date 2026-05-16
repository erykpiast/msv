const test = require('node:test');
const assert = require('node:assert/strict');
const { extractWebSearches } = require('../src/anthropic');

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
