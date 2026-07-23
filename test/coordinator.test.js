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
  assignPersonaPairs,
} = require('../src/agents/coordinator');
const { readLog } = require('../src/storage');

const IDEA = { id: 'i_test', raw_capture: 'Some topic to decompose.' };

const PERSONAS = [
  { id: 'p_001', name: 'Alice', tradition: 'pragmatist', stance: 'skeptical' },
  { id: 'p_002', name: 'Bob', tradition: 'idealist', stance: 'optimistic' },
  { id: 'p_003', name: 'Cara', tradition: 'empiricist', stance: 'cautious' },
];

// A pool large enough that the T <= P clamp never binds when tests want to
// exercise a specific targetTerritoryCount unclamped.
const LARGE_PERSONA_POOL = Array.from({ length: 12 }, (_, i) => ({
  id: `p_${String(i + 1).padStart(3, '0')}`,
  name: `Persona ${i + 1}`,
  tradition: 'tradition',
  stance: 'stance',
}));

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
    recommended_personas: ['p_001', 'p_002', 'p_003'],
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
        input: {
          territories: [
            territoryInput(),
            territoryInput({ name: 'territory-b', recommended_personas: ['p_002', 'p_003', 'p_001'] }),
          ],
        },
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
    personas: LARGE_PERSONA_POOL,
    bus: null,
    targetTerritoryCount: 10,
  });

  assert.equal(seenSchemas[0].minItems, 9);
  assert.equal(seenSchemas[0].maxItems, 11);
  assert.match(seenSystems[0], /approximately 10/);
});

test('runCoordinatorInitial: targetTerritoryCount is no longer clamped by the persona pool size', async () => {
  // The capacity clamp is gone: assignPersonaPairs can staff any T from any
  // roster (reusing personas past the soft cap when it must), so a target of
  // 10 against a 3-persona pool drives the schema and prompt to 10 unchanged.
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
    personas: PERSONAS, // only 3 personas
    bus: null,
    targetTerritoryCount: 10,
  });

  assert.equal(seenSchemas[0].minItems, 9);
  assert.equal(seenSchemas[0].maxItems, 11);
  assert.match(seenSystems[0], /approximately 10/);

  const entries = await readLog('i_test', 'coordinator');
  const requestLogs = entries.filter((e) => e.kind === 'request');
  const requestLog = requestLogs[requestLogs.length - 1];
  assert.equal(requestLog.payload.target_territory_count, 10);
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

test('emitTerritoriesTool: recommended_personas bounds scale with the roster size', () => {
  const recommended = (personaCount) =>
    emitTerritoriesTool(5, personaCount).input_schema.properties.territories.items.properties
      .recommended_personas;

  // A roster large enough for a real ranking: at least 3, up to the whole roster.
  assert.deepEqual(
    { min: recommended(7).minItems, max: recommended(7).maxItems },
    { min: 3, max: 7 }
  );
  // A tiny roster can't be asked for 3 names — floor at 2 (enough to seed a pair).
  assert.deepEqual(
    { min: recommended(2).minItems, max: recommended(2).maxItems },
    { min: 2, max: 2 }
  );
});

const NAMED = (ids) => ({ recommended_personas: ids });

test('assignPersonaPairs: picks the top two recommendations when nobody is capped', () => {
  const personas = [{ id: 'p_001' }, { id: 'p_002' }, { id: 'p_003' }];
  const [t] = assignPersonaPairs([NAMED(['p_001', 'p_002', 'p_003'])], personas);
  assert.deepEqual(t.assigned_pair, ['p_001', 'p_002']);
});

test('assignPersonaPairs: skips a topic-specific persona already at the soft cap', () => {
  const personas = [{ id: 'p_001' }, { id: 'p_002' }, { id: 'p_003' }, { id: 'p_004' }];
  const out = assignPersonaPairs(
    [
      NAMED(['p_001', 'p_002', 'p_003']), // -> p_001, p_002   (usage p_001=1, p_002=1)
      NAMED(['p_001', 'p_003', 'p_004']), // -> p_001, p_003   (usage p_001=2, p_003=1)
      NAMED(['p_001', 'p_002', 'p_004']), // p_001 now capped -> skipped
    ],
    personas
  );
  assert.deepEqual(out[0].assigned_pair, ['p_001', 'p_002']);
  assert.deepEqual(out[1].assigned_pair, ['p_001', 'p_003']);
  // p_001 is at the cap (2), so it is skipped and the two still-under-cap
  // recommendations (p_002 at 1, p_004 at 0) are chosen in rank order.
  assert.deepEqual(out[2].assigned_pair, ['p_002', 'p_004']);
});

test('assignPersonaPairs: reuses the most-recommended persona a third time when all are capped', () => {
  const personas = [{ id: 'p_001' }, { id: 'p_002' }, { id: 'p_003' }];
  const rec = ['p_001', 'p_002', 'p_003'];
  const out = assignPersonaPairs(
    [NAMED(rec), NAMED(rec), NAMED(rec)], // 3 territories, only 3 personas, cap 2
    personas
  );
  // First two territories exhaust the cap for p_001 (2) and p_002 (2); p_003
  // reaches 2 as well. The third must reuse: least-used-then-best-ranked.
  const counts = {};
  for (const t of out) for (const id of t.assigned_pair) counts[id] = (counts[id] || 0) + 1;
  // 3 territories * 2 slots = 6 assignments across 3 personas → someone hits 3.
  assert.equal(Object.values(counts).reduce((a, b) => a + b, 0), 6);
  assert.ok(Math.max(...Object.values(counts)) >= 3);
});

test('assignPersonaPairs: fixed personas are exempt and can anchor every territory', () => {
  const personas = [
    { id: 'p_001' },
    { id: 'p_002' },
    { id: 'skeptic', fixed: true },
  ];
  const out = assignPersonaPairs(
    [
      NAMED(['p_001', 'skeptic', 'p_002']),
      NAMED(['p_002', 'skeptic', 'p_001']),
      NAMED(['skeptic', 'p_001', 'p_002']),
    ],
    personas
  );
  const skepticCount = out.filter((t) => t.assigned_pair.includes('skeptic')).length;
  assert.equal(skepticCount, 3, 'a universal persona is never blocked by the cap');
});

test('assignPersonaPairs: filters invalid ids and backfills from the roster', () => {
  const personas = [{ id: 'p_001' }, { id: 'p_002' }, { id: 'skeptic', fixed: true }];
  // Only one valid recommendation — backfill must complete the pair.
  const [t] = assignPersonaPairs([NAMED(['p_001', 'ghost', 'phantom'])], personas);
  assert.equal(t.assigned_pair.length, 2);
  assert.equal(t.assigned_pair[0], 'p_001');
  assert.ok(personas.some((p) => p.id === t.assigned_pair[1]));
});

test('assignPersonaPairs: emits stable territory ids and a distinctness score', () => {
  const personas = [{ id: 'p_001' }, { id: 'p_002' }];
  const [t] = assignPersonaPairs(
    [{ name: 'terr', description: 'd', recommended_personas: ['p_001', 'p_002'] }],
    personas
  );
  assert.equal(t.id, 't_001');
  assert.equal(t.territory_id, 't_001');
  assert.equal(t.name, 'terr');
  assert.equal(typeof t.pair_distinctness_score, 'number');
});
