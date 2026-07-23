'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// Redirect ~/.msv to a per-process temp dir so appendLog calls inside
// runCoordinatorInitial don't pollute the developer's real ideas directory.
// Must happen before requiring storage / coordinator.
const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'coordinator-test-'));
process.env.MSV_ROOT = path.join(tmpHome, '.msv');
fs.mkdirSync(path.join(process.env.MSV_ROOT, 'ideas', 'i_test', 'logs'), { recursive: true });

const {
  runCoordinatorInitial,
  isUnrecoverableTruncation,
  emitTerritoriesTool,
} = require('../src/agents/coordinator');
const { readLog } = require('../src/storage');

const IDEA = { id: 'i_test', raw_capture: 'Some topic to decompose.' };

const PERSONAS = [
  { id: 'p_001', name: 'Alice', tradition: 'pragmatist', stance: 'skeptical' },
  { id: 'p_002', name: 'Bob', tradition: 'idealist', stance: 'optimistic' },
  { id: 'p_003', name: 'Cara', tradition: 'empiricist', stance: 'cautious' },
];

// Non-streaming mock, matching test/anthropic.test.js's convention: exercises
// runStructuredCall (client.messages.create).
function makeCreateClient(handler) {
  let call = 0;
  return {
    messages: {
      create: async (params, opts) => {
        call += 1;
        return handler(params, opts, call);
      },
    },
  };
}

function territoryInput(overrides = {}) {
  return {
    name: 'territory-a',
    description: 'A territory description.',
    rationale: 'because reasons',
    assigned_pair: ['p_001', 'p_002'],
    ...overrides,
  };
}

function wellFormedResponse() {
  return {
    stop_reason: 'tool_use',
    content: [
      {
        type: 'tool_use',
        name: 'emit_territories',
        id: 'tu_1',
        input: { territories: [territoryInput(), territoryInput({ name: 'territory-b', assigned_pair: ['p_002', 'p_003'] })] },
      },
    ],
    usage: { input_tokens: 10, output_tokens: 20 },
  };
}

test('isUnrecoverableTruncation: false when not truncated', () => {
  assert.equal(isUnrecoverableTruncation({ toolUse: null, truncated: false }), false);
  assert.equal(isUnrecoverableTruncation({ toolUse: { input: {} }, truncated: false }), false);
});

test('isUnrecoverableTruncation: true when truncated and toolUse is null', () => {
  assert.equal(isUnrecoverableTruncation({ toolUse: null, truncated: true }), true);
});

test('isUnrecoverableTruncation: true when truncated and territories missing/malformed', () => {
  assert.equal(
    isUnrecoverableTruncation({ toolUse: { input: {} }, truncated: true }),
    true
  );
  assert.equal(
    isUnrecoverableTruncation({ toolUse: { input: { territories: 'not-an-array' } }, truncated: true }),
    true
  );
});

test('isUnrecoverableTruncation: false when truncated but territories is a (possibly partial) array', () => {
  assert.equal(
    isUnrecoverableTruncation({ toolUse: { input: { territories: [] } }, truncated: true }),
    false
  );
});

test('runCoordinatorInitial: happy path returns territories and passes maxTokens: 4000', async () => {
  const seenMaxTokens = [];
  const client = makeCreateClient((params) => {
    seenMaxTokens.push(params.max_tokens);
    return wellFormedResponse();
  });

  const result = await runCoordinatorInitial({
    client,
    idea: IDEA,
    model: 'test-model',
    budget: {},
    personas: PERSONAS,
    bus: null,
  });

  assert.equal(seenMaxTokens.length, 1, 'should not retry on a clean response');
  assert.equal(seenMaxTokens[0], 4000);
  assert.equal(result.territories.length, 2);
  assert.equal(result.territories[0].name, 'territory-a');
  assert.deepEqual(result.territories[0].assigned_pair, ['p_001', 'p_002']);
});

test('runCoordinatorInitial: toolUse null + max_tokens truncation retries once then succeeds', async () => {
  const client = makeCreateClient((params, opts, call) => {
    if (call === 1) {
      // Forced tool never appeared before generation was cut off.
      return { stop_reason: 'max_tokens', content: [], usage: { input_tokens: 5, output_tokens: 4000 } };
    }
    return wellFormedResponse();
  });

  const result = await runCoordinatorInitial({
    client,
    idea: IDEA,
    model: 'test-model',
    budget: {},
    personas: PERSONAS,
    bus: null,
  });

  assert.equal(result.territories.length, 2);

  const entries = await readLog('i_test', 'coordinator');
  const retryLog = entries.find((e) => e.kind === 'truncation_retry');
  assert.ok(retryLog, 'truncation_retry must be logged');
  assert.equal(retryLog.payload.reason, 'tool_use_missing');
});

test('runCoordinatorInitial: tool_use present but territories malformed by truncation retries then succeeds', async () => {
  const client = makeCreateClient((params, opts, call) => {
    if (call === 1) {
      return {
        stop_reason: 'max_tokens',
        content: [
          {
            type: 'tool_use',
            name: 'emit_territories',
            id: 'tu_partial',
            input: { territories: 'truncated mid-json, not really an array' },
          },
        ],
        usage: { input_tokens: 5, output_tokens: 4000 },
      };
    }
    return wellFormedResponse();
  });

  const result = await runCoordinatorInitial({
    client,
    idea: IDEA,
    model: 'test-model',
    budget: {},
    personas: PERSONAS,
    bus: null,
  });

  assert.equal(result.territories.length, 2);

  const entries = await readLog('i_test', 'coordinator');
  const retryLog = entries
    .filter((e) => e.kind === 'truncation_retry')
    .find((e) => e.payload.reason === 'territories_missing_or_malformed');
  assert.ok(retryLog, 'truncation_retry with territories_missing_or_malformed must be logged');
});

test('runCoordinatorInitial: truncation on both attempts throws instead of propagating null/garbage state', async () => {
  const client = makeCreateClient(() => ({
    stop_reason: 'max_tokens',
    content: [],
    usage: { input_tokens: 5, output_tokens: 4000 },
  }));

  await assert.rejects(
    () =>
      runCoordinatorInitial({
        client,
        idea: IDEA,
        model: 'test-model',
        budget: {},
        personas: PERSONAS,
        bus: null,
      }),
    /truncated after retry/
  );
});

test('emitTerritoriesTool: schema range is built from the target count', () => {
  assert.deepEqual(
    { min: emitTerritoriesTool(5).input_schema.properties.territories.minItems,
      max: emitTerritoriesTool(5).input_schema.properties.territories.maxItems },
    { min: 4, max: 6 }
  );
  assert.deepEqual(
    { min: emitTerritoriesTool(3).input_schema.properties.territories.minItems,
      max: emitTerritoriesTool(3).input_schema.properties.territories.maxItems },
    { min: 2, max: 4 }
  );
  assert.deepEqual(
    { min: emitTerritoriesTool(10).input_schema.properties.territories.minItems,
      max: emitTerritoriesTool(10).input_schema.properties.territories.maxItems },
    { min: 9, max: 11 }
  );
});

test('runCoordinatorInitial: targetTerritoryCount drives the emit_territories schema and prompt', async () => {
  const seenSchemas = [];
  const seenSystems = [];
  const client = makeCreateClient((params) => {
    seenSchemas.push(params.tools[0].input_schema.properties.territories);
    seenSystems.push(params.system);
    return wellFormedResponse();
  });

  await runCoordinatorInitial({
    client,
    idea: IDEA,
    model: 'test-model',
    budget: {},
    personas: PERSONAS,
    bus: null,
    targetTerritoryCount: 10,
  });

  assert.equal(seenSchemas[0].minItems, 9);
  assert.equal(seenSchemas[0].maxItems, 11);
  assert.match(seenSystems[0], /approximately 10/);
});

test('runCoordinatorInitial: fixed personas are marked universal in the roster so they can anchor extra territories', async () => {
  const seenMessages = [];
  const client = makeCreateClient((params) => {
    seenMessages.push(params.messages);
    return wellFormedResponse();
  });

  await runCoordinatorInitial({
    client,
    idea: IDEA,
    model: 'test-model',
    budget: {},
    personas: [
      { id: 'p_001', name: 'Alice', tradition: 'pragmatist', stance: 'skeptical' },
      { id: 'skeptic', name: 'Skeptic', tradition: 'critical', stance: 'steel-manned', fixed: true },
    ],
    bus: null,
  });

  const userMsg = seenMessages[0].find((m) => m.role === 'user').content;
  assert.match(userMsg, /Skeptic \(universal/);
  assert.doesNotMatch(userMsg, /Alice \(universal/);
});

test('runCoordinatorInitial: non-truncated missing forced tool still throws (existing contract, unchanged)', async () => {
  const client = makeCreateClient(() => ({
    stop_reason: 'end_turn',
    content: [{ type: 'text', text: 'no tool call here' }],
    usage: { input_tokens: 5, output_tokens: 5 },
  }));

  await assert.rejects(() =>
    runCoordinatorInitial({
      client,
      idea: IDEA,
      model: 'test-model',
      budget: {},
      personas: PERSONAS,
      bus: null,
    })
  );
});
