const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// Redirect ~/.msv to a per-process temp dir so appendLog calls inside the
// attach helpers don't pollute the developer's real ideas directory. Must
// happen before requiring storage / nicknamer.
const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'nicknamer-test-'));
process.env.MSV_ROOT = path.join(tmpHome, '.msv');
fs.mkdirSync(path.join(process.env.MSV_ROOT, 'ideas', 'i_test', 'logs'), { recursive: true });

const {
  generateNicknames,
  attachWorkingGroupNicknames,
  attachForumNicknames,
  sanitizeNickname,
  deduplicate,
  NICKNAMER_TOOL,
  MAX_NICKNAME_LEN,
} = require('../src/nicknamer');

function makeClient(handler) {
  return {
    messages: {
      create: async (params, _opts) => handler(params),
    },
  };
}

function buildToolUseResponse(nicknames) {
  return {
    stop_reason: 'tool_use',
    content: [
      {
        type: 'tool_use',
        name: 'emit_nicknames',
        input: { nicknames },
      },
    ],
    usage: { input_tokens: 10, output_tokens: 20 },
  };
}

// ---------------------------------------------------------------------------
// sanitizeNickname
// ---------------------------------------------------------------------------

test('sanitizeNickname accepts canonical kebab-case', () => {
  assert.equal(sanitizeNickname('friction-cliff'), 'friction-cliff');
  assert.equal(sanitizeNickname('cold-start-tax'), 'cold-start-tax');
});

test('sanitizeNickname normalises whitespace and casing', () => {
  assert.equal(sanitizeNickname('Friction Cliff'), 'friction-cliff');
  assert.equal(sanitizeNickname('cold_start_tax'), 'cold-start-tax');
  assert.equal(sanitizeNickname('  Minority Veto  '), 'minority-veto');
});

test('sanitizeNickname rejects single-word inputs', () => {
  assert.equal(sanitizeNickname('cliff'), null);
});

test('sanitizeNickname rejects inputs with more than 3 segments', () => {
  // KEBAB_RE was tightened to {1,2} hyphens (2 or 3 words) to match the prompts.
  assert.equal(sanitizeNickname('one-two-three-four'), null);
});

test('sanitizeNickname strips punctuation but keeps digits', () => {
  assert.equal(sanitizeNickname('v2-bottleneck!'), 'v2-bottleneck');
  assert.equal(sanitizeNickname('???'), null);
});

test('sanitizeNickname enforces MAX_NICKNAME_LEN', () => {
  // Input over 25 chars; after slice + trailing-hyphen trim, must still
  // satisfy KEBAB_RE (2 or 3 segments).
  const longInput = 'verylongword-secondword-third'; // 29 chars, 3 segments
  const out = sanitizeNickname(longInput);
  assert.ok(out !== null, 'should not be rejected outright');
  assert.ok(out.length <= MAX_NICKNAME_LEN, `length ${out.length} ≤ ${MAX_NICKNAME_LEN}`);
});

test('sanitizeNickname rejects non-string inputs', () => {
  assert.equal(sanitizeNickname(42), null);
  assert.equal(sanitizeNickname(null), null);
  assert.equal(sanitizeNickname(undefined), null);
});

// ---------------------------------------------------------------------------
// deduplicate
// ---------------------------------------------------------------------------

test('deduplicate appends -2/-3 to collisions and preserves first seen', () => {
  const out = deduplicate([
    { id: 'a', nickname: 'friction-cliff' },
    { id: 'b', nickname: 'friction-cliff' },
    { id: 'c', nickname: 'friction-cliff' },
    { id: 'd', nickname: 'other-thing' },
  ]);
  assert.equal(out.get('a'), 'friction-cliff');
  assert.equal(out.get('b'), 'friction-cliff-2');
  assert.equal(out.get('c'), 'friction-cliff-3');
  assert.equal(out.get('d'), 'other-thing');
});

test('deduplicate -N suffix skips slots occupied by unrelated candidates', () => {
  const out = deduplicate([
    { id: 'a', nickname: 'shared-name' },
    { id: 'b', nickname: 'shared-name-2' }, // already occupies -2 slot
    { id: 'c', nickname: 'shared-name' },   // must land on -3, not -2
  ]);
  assert.equal(out.get('a'), 'shared-name');
  assert.equal(out.get('b'), 'shared-name-2');
  assert.equal(out.get('c'), 'shared-name-3');
});

test('deduplicate keeps the first nickname when an id repeats', () => {
  const out = deduplicate([
    { id: 'a', nickname: 'first-nick' },
    { id: 'a', nickname: 'second-nick' }, // ignored — id already mapped
  ]);
  assert.equal(out.get('a'), 'first-nick');
  assert.equal(out.size, 1);
});

// ---------------------------------------------------------------------------
// NICKNAMER_TOOL schema
// ---------------------------------------------------------------------------

test('NICKNAMER_TOOL exports the expected tool schema and bounded length', () => {
  assert.equal(NICKNAMER_TOOL.name, 'emit_nicknames');
  assert.equal(NICKNAMER_TOOL.input_schema.type, 'object');
  // Schema maxLength must match MAX_NICKNAME_LEN — three-way mismatch was the
  // original bug; this asserts they don't drift again.
  const itemSchema = NICKNAMER_TOOL.input_schema.properties.nicknames.items;
  assert.equal(itemSchema.properties.nickname.maxLength, MAX_NICKNAME_LEN);
});

// ---------------------------------------------------------------------------
// generateNicknames — happy path + defensive branches
// ---------------------------------------------------------------------------

test('generateNicknames returns empty Map on empty items', async () => {
  const result = await generateNicknames({}, { kind: 'forum', items: [] });
  assert.equal(result.size, 0);
});

test('generateNicknames returns empty Map without a client', async () => {
  const result = await generateNicknames(null, {
    kind: 'forum',
    items: [{ id: 'n_001', content: 'something' }],
  });
  assert.equal(result.size, 0);
});

test('generateNicknames maps ids to sanitised nicknames on success', async () => {
  const client = makeClient(async () =>
    buildToolUseResponse([
      { id: 'n_001', nickname: 'Friction Cliff' },
      { id: 'n_002', nickname: 'cold-start-tax' },
    ])
  );
  const result = await generateNicknames(client, {
    kind: 'forum',
    items: [
      { id: 'n_001', content: 'Users abandon onboarding after three friction points.' },
      { id: 'n_002', content: 'Cold starts dominate latency for new sessions.' },
    ],
    context: { topic: 'app onboarding' },
  });
  assert.equal(result.size, 2);
  assert.equal(result.get('n_001'), 'friction-cliff');
  assert.equal(result.get('n_002'), 'cold-start-tax');
});

test('generateNicknames swallows API errors and returns empty Map', async () => {
  const client = makeClient(async () => {
    throw new Error('boom');
  });
  const result = await generateNicknames(client, {
    kind: 'wg',
    items: [{ id: 'n_001', content: 'x' }],
  });
  assert.equal(result.size, 0);
});

test('generateNicknames returns empty Map when model returns end_turn instead of tool_use', async () => {
  // runStructuredCall throws when the forced tool is missing; the swallow
  // catch in generateNicknames must convert that to an empty Map.
  const client = makeClient(async () => ({
    stop_reason: 'end_turn',
    content: [{ type: 'text', text: 'I cannot help.' }],
    usage: { input_tokens: 5, output_tokens: 3 },
  }));
  const result = await generateNicknames(client, {
    kind: 'wg',
    items: [{ id: 'n_001', content: 'x' }],
  });
  assert.equal(result.size, 0);
});

test('generateNicknames returns empty Map when nicknames field is not an array', async () => {
  const client = makeClient(async () => ({
    stop_reason: 'tool_use',
    content: [{ type: 'tool_use', name: 'emit_nicknames', input: { nicknames: 'wrong' } }],
    usage: { input_tokens: 5, output_tokens: 5 },
  }));
  const result = await generateNicknames(client, {
    kind: 'wg',
    items: [{ id: 'n_001', content: 'x' }],
  });
  assert.equal(result.size, 0);
});

test('generateNicknames skips items whose nickname is not a string', async () => {
  const client = makeClient(async () =>
    buildToolUseResponse([
      { id: 'n_001', nickname: 42 },
      { id: 'n_002', nickname: 'valid-name' },
    ])
  );
  const result = await generateNicknames(client, {
    kind: 'wg',
    items: [
      { id: 'n_001', content: 'a' },
      { id: 'n_002', content: 'b' },
    ],
  });
  assert.equal(result.size, 1);
  assert.equal(result.get('n_002'), 'valid-name');
});

test('generateNicknames drops unknown ids and invalid nicknames', async () => {
  const client = makeClient(async () =>
    buildToolUseResponse([
      { id: 'n_001', nickname: 'friction-cliff' },
      { id: 'never-emitted', nickname: 'ghost-id' },
      { id: 'n_002', nickname: '???' },
    ])
  );
  const result = await generateNicknames(client, {
    kind: 'forum',
    items: [
      { id: 'n_001', content: 'a' },
      { id: 'n_002', content: 'b' },
    ],
  });
  assert.equal(result.size, 1);
  assert.equal(result.get('n_001'), 'friction-cliff');
});

test('generateNicknames de-duplicates colliding nicknames returned by Haiku', async () => {
  const client = makeClient(async () =>
    buildToolUseResponse([
      { id: 'n_001', nickname: 'shared-name' },
      { id: 'n_002', nickname: 'shared-name' },
    ])
  );
  const result = await generateNicknames(client, {
    kind: 'forum',
    items: [
      { id: 'n_001', content: 'a' },
      { id: 'n_002', content: 'b' },
    ],
  });
  assert.equal(result.get('n_001'), 'shared-name');
  assert.equal(result.get('n_002'), 'shared-name-2');
});

test('generateNicknames forwards a custom maxTokens to the API call', async () => {
  let capturedMaxTokens;
  const client = makeClient(async (params) => {
    capturedMaxTokens = params.max_tokens;
    return buildToolUseResponse([{ id: 'n_001', nickname: 'test-name' }]);
  });
  await generateNicknames(client, {
    kind: 'forum',
    items: [{ id: 'n_001', content: 'x' }],
    maxTokens: 512,
  });
  assert.equal(capturedMaxTokens, 512);
});

// ---------------------------------------------------------------------------
// attachWorkingGroupNicknames
// ---------------------------------------------------------------------------

test('attachWorkingGroupNicknames mutates moves and observations in place', async () => {
  const move = {
    move_id: 'm_t_001_debate_0001',
    type: 'Claim',
    content: 'some debate content',
    stage: 'debate',
  };
  const obs = { observation_id: 'o_t_001_001', content: 'an observation' };
  const result = { moves: [move], observations: [obs], surviving_claims: [] };
  const client = makeClient(async () =>
    buildToolUseResponse([
      { id: 'm_t_001_debate_0001', nickname: 'friction-cliff' },
      { id: 'o_t_001_001', nickname: 'cold-start-tax' },
    ])
  );
  const events = [];
  const bus = { emit: (name, payload) => events.push({ name, payload }) };
  await attachWorkingGroupNicknames({
    client,
    idea: { id: 'i_test', raw_capture: 'topic' },
    result,
    territory: { name: 'territory-one' },
    personas: [{ name: 'persona-a' }],
    bus,
    territoryId: 't_001',
  });
  assert.equal(move.nickname, 'friction-cliff');
  assert.equal(obs.nickname, 'cold-start-tax');
  const evt = events.find((e) => e.name === 'wg.nicknames.done');
  assert.ok(evt, 'wg.nicknames.done should be emitted');
  assert.equal(evt.payload.territory_id, 't_001');
  assert.equal(evt.payload.count, 2);
});

test('attachWorkingGroupNicknames propagates move nickname to surviving claims with -cN suffix', async () => {
  const move = {
    move_id: 'm_t_001_debate_0001',
    type: 'Claim',
    content: 'a claim',
    stage: 'debate',
  };
  const claim1 = {
    claim_id: 'c_m_t_001_debate_0001_001',
    originating_move_id: 'm_t_001_debate_0001',
    content: 'c1',
  };
  const claim2 = {
    claim_id: 'c_m_t_001_debate_0001_002',
    originating_move_id: 'm_t_001_debate_0001',
    content: 'c2',
  };
  const result = {
    moves: [move],
    observations: [],
    surviving_claims: [claim1, claim2],
  };
  const client = makeClient(async () =>
    buildToolUseResponse([{ id: 'm_t_001_debate_0001', nickname: 'base-name' }])
  );
  await attachWorkingGroupNicknames({
    client,
    idea: { id: 'i_test', raw_capture: 'topic' },
    result,
    territory: { name: 'territory-one' },
    personas: [],
    bus: null,
    territoryId: 't_001',
  });
  assert.equal(claim1.nickname, 'base-name');
  assert.equal(claim2.nickname, 'base-name-c2');
});

test('attachWorkingGroupNicknames is a no-op when nicknames map is empty', async () => {
  const move = { move_id: 'm_001', type: 'Claim', content: 'x' };
  const result = { moves: [move], observations: [], surviving_claims: [] };
  const client = makeClient(async () => buildToolUseResponse([])); // empty
  await attachWorkingGroupNicknames({
    client,
    idea: { id: 'i_test' },
    result,
    territory: {},
    personas: [],
    bus: null,
    territoryId: 't_001',
  });
  assert.equal(move.nickname, undefined);
});

// ---------------------------------------------------------------------------
// attachForumNicknames
// ---------------------------------------------------------------------------

test('attachForumNicknames mutates node.nickname in place and emits forum.nicknames.done', async () => {
  const node = { node_id: 'n_001', content: 'some claim content' };
  const client = makeClient(async () =>
    buildToolUseResponse([{ id: 'n_001', nickname: 'friction-cliff' }])
  );
  const events = [];
  const bus = { emit: (name, payload) => events.push({ name, payload }) };
  await attachForumNicknames({
    client,
    idea: { id: 'i_test', raw_capture: 'topic' },
    nodes: [node],
    bus,
  });
  assert.equal(node.nickname, 'friction-cliff');
  const evt = events.find((e) => e.name === 'forum.nicknames.done');
  assert.ok(evt, 'forum.nicknames.done should be emitted');
  assert.equal(evt.payload.count, 1);
});

test('attachForumNicknames is a no-op when nodes is empty', async () => {
  const client = makeClient(async () => buildToolUseResponse([]));
  // Should not throw, should not emit (no items).
  let emitted = false;
  await attachForumNicknames({
    client,
    idea: { id: 'i_test' },
    nodes: [],
    bus: { emit: () => { emitted = true; } },
  });
  assert.equal(emitted, false);
});
