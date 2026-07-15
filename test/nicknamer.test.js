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

test('generateNicknames returns empty Map when max_tokens truncation hits before the tool_use block appears', async () => {
  // runStructuredCall returns toolUse: null (not a throw) when generation was
  // cut off by max_tokens before the forced tool ever appeared.
  const client = makeClient(async () => ({
    stop_reason: 'max_tokens',
    content: [],
    usage: { input_tokens: 5, output_tokens: 1200 },
  }));
  const result = await generateNicknames(client, {
    kind: 'wg',
    items: [{ id: 'n_001', content: 'x' }],
  });
  assert.equal(result.size, 0);
});

test('generateNicknames calls onError with reason=empty_tool_input when max_tokens truncation hits before tool_use', async () => {
  const client = makeClient(async () => ({
    stop_reason: 'max_tokens',
    content: [],
    usage: { input_tokens: 5, output_tokens: 1200 },
  }));
  const errors = [];
  const result = await generateNicknames(client, {
    kind: 'wg',
    items: [{ id: 'n_001', content: 'x' }],
    onError: (info) => errors.push(info),
  });
  assert.equal(result.size, 0);
  assert.equal(errors.length, 1);
  assert.equal(errors[0].reason, 'empty_tool_input');
  assert.equal(errors[0].truncated, true);
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

test('generateNicknames calls onError with reason=api_error when runStructuredCall throws', async () => {
  const client = makeClient(async () => {
    throw new Error('boom');
  });
  const errors = [];
  const result = await generateNicknames(client, {
    kind: 'wg',
    items: [{ id: 'n_001', content: 'x' }],
    onError: (info) => errors.push(info),
  });
  assert.equal(result.size, 0);
  assert.equal(errors.length, 1);
  assert.equal(errors[0].reason, 'api_error');
  assert.equal(errors[0].message, 'boom');
});

test('generateNicknames calls onError with reason=empty_tool_input when nicknames array is missing', async () => {
  const client = makeClient(async () => ({
    stop_reason: 'tool_use',
    content: [{ type: 'tool_use', name: 'emit_nicknames', input: { nicknames: [] } }],
    usage: { input_tokens: 5, output_tokens: 5 },
  }));
  const errors = [];
  const result = await generateNicknames(client, {
    kind: 'wg',
    items: [{ id: 'n_001', content: 'x' }],
    onError: (info) => errors.push(info),
  });
  assert.equal(result.size, 0);
  assert.equal(errors.length, 1);
  assert.equal(errors[0].reason, 'empty_tool_input');
});

test('generateNicknames calls onError with reason=all_rejected when every nickname fails sanitisation', async () => {
  const client = makeClient(async () =>
    buildToolUseResponse([
      { id: 'n_001', nickname: '???' },           // sanitisation fails
      { id: 'n_002', nickname: 'singleword' },    // KEBAB_RE rejects
    ])
  );
  const errors = [];
  const result = await generateNicknames(client, {
    kind: 'wg',
    items: [
      { id: 'n_001', content: 'a' },
      { id: 'n_002', content: 'b' },
    ],
    onError: (info) => errors.push(info),
  });
  assert.equal(result.size, 0);
  assert.equal(errors.length, 1);
  assert.equal(errors[0].reason, 'all_rejected');
  assert.equal(errors[0].received, 2);
  assert.equal(errors[0].valid, 0);
});

test('generateNicknames does NOT call onError on success', async () => {
  const client = makeClient(async () =>
    buildToolUseResponse([{ id: 'n_001', nickname: 'valid-name' }])
  );
  const errors = [];
  const result = await generateNicknames(client, {
    kind: 'wg',
    items: [{ id: 'n_001', content: 'x' }],
    onError: (info) => errors.push(info),
  });
  assert.equal(result.size, 1);
  assert.equal(errors.length, 0);
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

test('attachWorkingGroupNicknames (alignment) names only alignment-stage moves and emits sub_stage tag', async () => {
  const align1 = { move_id: 'm_t_001_alignment_0001', type: 'Drop', content: 'align 1', stage: 'alignment' };
  const align2 = { move_id: 'm_t_001_alignment_0002', type: 'Keep', content: 'align 2', stage: 'alignment' };
  // A debate move on the same result must NOT be sent to the alignment batch
  // — debate hasn't happened yet when the alignment nicknamer fires, but the
  // filter has to work even if the array is dirty.
  const debate = { move_id: 'm_t_001_debate_0001', type: 'Claim', content: 'debate', stage: 'debate' };
  const result = {
    moves: [align1, align2, debate],
    observations: [],
    researcher_reports: [],
    surviving_claims: [],
  };
  const sentItems = [];
  const client = makeClient(async (params) => {
    sentItems.push(...params.messages[0].content.split('\n').filter((l) => l.startsWith('- ')));
    return buildToolUseResponse([
      { id: 'm_t_001_alignment_0001', nickname: 'cull-stragglers' },
      { id: 'm_t_001_alignment_0002', nickname: 'preserve-anchors' },
    ]);
  });
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
    subStage: 'alignment',
  });
  assert.equal(align1.nickname, 'cull-stragglers');
  assert.equal(align2.nickname, 'preserve-anchors');
  assert.equal(debate.nickname, undefined, 'debate move must not be named by the alignment batch');
  // Sanity: the user message only mentioned the two alignment moves.
  assert.equal(sentItems.filter((l) => l.includes('m_t_001_alignment_')).length, 2);
  assert.equal(sentItems.filter((l) => l.includes('m_t_001_debate_')).length, 0);
  const evt = events.find((e) => e.name === 'wg.nicknames.done');
  assert.ok(evt);
  assert.equal(evt.payload.sub_stage, 'alignment');
  assert.equal(evt.payload.count, 2);
});

test('attachWorkingGroupNicknames (researcher) names findings nested in researcher_reports', async () => {
  const f1 = { finding_id: 'f_aq_001_01', summary: 'first finding', source_url: 'u1', source_quote: 'q1', confidence_in_source: 7 };
  const f2 = { finding_id: 'f_aq_001_02', summary: 'second finding', source_url: 'u2', source_quote: 'q2', confidence_in_source: 6 };
  const f3 = { finding_id: 'f_aq_002_01', summary: 'third finding', source_url: 'u3', source_quote: 'q3', confidence_in_source: 8 };
  const result = {
    moves: [],
    observations: [],
    researcher_reports: [
      { report_id: 'rr_001', aligned_id: 'aq_001', outcome: 'useful', findings: [f1, f2], search_trace: [] },
      { report_id: 'rr_002', aligned_id: 'aq_002', outcome: 'useful', findings: [f3], search_trace: [] },
    ],
    surviving_claims: [],
  };
  const client = makeClient(async () =>
    buildToolUseResponse([
      { id: 'f_aq_001_01', nickname: 'cold-start' },
      { id: 'f_aq_001_02', nickname: 'token-cliff' },
      { id: 'f_aq_002_01', nickname: 'survival-bias' },
    ])
  );
  const events = [];
  const bus = { emit: (name, payload) => events.push({ name, payload }) };
  await attachWorkingGroupNicknames({
    client,
    idea: { id: 'i_test', raw_capture: 'topic' },
    result,
    territory: { name: 'territory-one' },
    personas: [],
    bus,
    territoryId: 't_001',
    subStage: 'researcher',
  });
  assert.equal(f1.nickname, 'cold-start');
  assert.equal(f2.nickname, 'token-cliff');
  assert.equal(f3.nickname, 'survival-bias');
  const evt = events.find((e) => e.name === 'wg.nicknames.done');
  assert.ok(evt);
  assert.equal(evt.payload.sub_stage, 'researcher');
});

test('attachWorkingGroupNicknames (observation) names only observations', async () => {
  const obs1 = { observation_id: 'o_t_001_001', content: 'obs one' };
  const obs2 = { observation_id: 'o_t_001_002', content: 'obs two' };
  const result = {
    moves: [],
    observations: [obs1, obs2],
    researcher_reports: [],
    surviving_claims: [],
  };
  const client = makeClient(async () =>
    buildToolUseResponse([
      { id: 'o_t_001_001', nickname: 'frame-shift' },
      { id: 'o_t_001_002', nickname: 'evidence-gap' },
    ])
  );
  await attachWorkingGroupNicknames({
    client,
    idea: { id: 'i_test', raw_capture: 'topic' },
    result,
    territory: {},
    personas: [],
    bus: null,
    territoryId: 't_001',
    subStage: 'observation',
  });
  assert.equal(obs1.nickname, 'frame-shift');
  assert.equal(obs2.nickname, 'evidence-gap');
});

test('attachWorkingGroupNicknames (debate) names debate moves and propagates to surviving claims with -cN', async () => {
  const align = { move_id: 'm_t_001_alignment_0001', type: 'Drop', content: 'align', stage: 'alignment', nickname: 'already-named' };
  const debate1 = { move_id: 'm_t_001_debate_0001', type: 'Claim', content: 'debate 1', stage: 'debate' };
  const debate2 = { move_id: 'm_t_001_debate_0002', type: 'Rebut', content: 'debate 2', stage: 'debate' };
  const claim1 = { claim_id: 'c_m_t_001_debate_0001_001', originating_move_id: 'm_t_001_debate_0001', content: 'c1' };
  const claim2 = { claim_id: 'c_m_t_001_debate_0001_002', originating_move_id: 'm_t_001_debate_0001', content: 'c2' };
  const claim3 = { claim_id: 'c_m_t_001_debate_0002_001', originating_move_id: 'm_t_001_debate_0002', content: 'c3' };
  const result = {
    moves: [align, debate1, debate2],
    observations: [],
    researcher_reports: [],
    surviving_claims: [claim1, claim2, claim3],
  };
  const client = makeClient(async () =>
    buildToolUseResponse([
      { id: 'm_t_001_debate_0001', nickname: 'opening-thesis' },
      { id: 'm_t_001_debate_0002', nickname: 'sharp-rebuttal' },
    ])
  );
  await attachWorkingGroupNicknames({
    client,
    idea: { id: 'i_test', raw_capture: 'topic' },
    result,
    territory: {},
    personas: [],
    bus: null,
    territoryId: 't_001',
    subStage: 'debate',
  });
  assert.equal(debate1.nickname, 'opening-thesis');
  assert.equal(debate2.nickname, 'sharp-rebuttal');
  // Alignment move's existing nickname must not be overwritten.
  assert.equal(align.nickname, 'already-named');
  // Claim propagation: first claim inherits, second gets -c2 suffix.
  assert.equal(claim1.nickname, 'opening-thesis');
  assert.equal(claim2.nickname, 'opening-thesis-c2');
  assert.equal(claim3.nickname, 'sharp-rebuttal');
});

test('attachWorkingGroupNicknames is observable on silent failure and tags sub_stage', async () => {
  const move = { move_id: 'm_t_001_alignment_0001', type: 'Claim', content: 'x', stage: 'alignment' };
  const result = { moves: [move], observations: [], researcher_reports: [], surviving_claims: [] };
  const client = makeClient(async () => buildToolUseResponse([])); // empty
  const events = [];
  const bus = { emit: (name, payload) => events.push({ name, payload }) };
  await attachWorkingGroupNicknames({
    client,
    idea: { id: 'i_test' },
    result,
    territory: {},
    personas: [],
    bus,
    territoryId: 't_001',
    subStage: 'alignment',
  });
  assert.equal(move.nickname, undefined);
  const failed = events.find((e) => e.name === 'wg.nicknames.failed');
  assert.ok(failed, 'wg.nicknames.failed must be emitted on silent failure');
  assert.equal(failed.payload.territory_id, 't_001');
  assert.equal(failed.payload.sub_stage, 'alignment');
  assert.equal(failed.payload.attempted, 1);
  assert.equal(failed.payload.reason, 'empty_tool_input');
});

test('attachWorkingGroupNicknames emits failed event with api_error reason when the API throws', async () => {
  const move = { move_id: 'm_t_001_debate_0001', type: 'Claim', content: 'x', stage: 'debate' };
  const result = { moves: [move], observations: [], researcher_reports: [], surviving_claims: [] };
  const client = makeClient(async () => {
    throw new Error('rate limited');
  });
  const events = [];
  const bus = { emit: (name, payload) => events.push({ name, payload }) };
  await attachWorkingGroupNicknames({
    client,
    idea: { id: 'i_test' },
    result,
    territory: {},
    personas: [],
    bus,
    territoryId: 't_001',
    subStage: 'debate',
  });
  const failed = events.find((e) => e.name === 'wg.nicknames.failed');
  assert.ok(failed);
  assert.equal(failed.payload.sub_stage, 'debate');
  assert.equal(failed.payload.reason, 'api_error');
  assert.equal(failed.payload.detail, 'rate limited');
});

test('attachWorkingGroupNicknames passes maxTokens=4000 to the API call (researcher batch headroom)', async () => {
  let capturedMaxTokens;
  const client = makeClient(async (params) => {
    capturedMaxTokens = params.max_tokens;
    return buildToolUseResponse([{ id: 'f_aq_001_01', nickname: 'test-name' }]);
  });
  const result = {
    moves: [],
    observations: [],
    researcher_reports: [
      { report_id: 'rr_001', aligned_id: 'aq_001', outcome: 'useful', findings: [{ finding_id: 'f_aq_001_01', summary: 'x' }], search_trace: [] },
    ],
    surviving_claims: [],
  };
  await attachWorkingGroupNicknames({
    client,
    idea: { id: 'i_test' },
    result,
    territory: {},
    personas: [],
    bus: null,
    territoryId: 't_001',
    subStage: 'researcher',
  });
  assert.equal(capturedMaxTokens, 4000);
});

test('attachWorkingGroupNicknames is a no-op when the sub-stage has no items to name', async () => {
  // Researcher with no findings — must not call the API, must not emit events.
  let apiCalled = false;
  const client = makeClient(async () => {
    apiCalled = true;
    return buildToolUseResponse([]);
  });
  const events = [];
  const bus = { emit: (name, payload) => events.push({ name, payload }) };
  await attachWorkingGroupNicknames({
    client,
    idea: { id: 'i_test' },
    result: { moves: [], observations: [], researcher_reports: [], surviving_claims: [] },
    territory: {},
    personas: [],
    bus,
    territoryId: 't_001',
    subStage: 'researcher',
  });
  assert.equal(apiCalled, false);
  assert.equal(events.length, 0);
});

test('attachWorkingGroupNicknames throws on unknown subStage', async () => {
  await assert.rejects(
    () =>
      attachWorkingGroupNicknames({
        client: makeClient(async () => buildToolUseResponse([])),
        idea: { id: 'i_test' },
        result: { moves: [], observations: [], researcher_reports: [], surviving_claims: [] },
        territory: {},
        personas: [],
        bus: null,
        territoryId: 't_001',
        subStage: 'made_up_stage',
      }),
    /unknown subStage 'made_up_stage'/
  );
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

test('attachForumNicknames emits forum.nicknames.failed when generateNicknames returns empty', async () => {
  const node = { node_id: 'n_001', content: 'some content' };
  const client = makeClient(async () => buildToolUseResponse([])); // empty input
  const events = [];
  const bus = { emit: (name, payload) => events.push({ name, payload }) };
  await attachForumNicknames({
    client,
    idea: { id: 'i_test' },
    nodes: [node],
    bus,
  });
  assert.equal(node.nickname, undefined);
  const failed = events.find((e) => e.name === 'forum.nicknames.failed');
  assert.ok(failed, 'forum.nicknames.failed must be emitted on silent failure');
  assert.equal(failed.payload.attempted, 1);
  assert.equal(failed.payload.reason, 'empty_tool_input');
});
