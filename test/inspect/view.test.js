const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { buildLoaderInput } = require('../../src/inspect/loader');
const { buildView } = require('../../src/inspect/view/build');
const { deriveContradictionEdges } = require('../../src/inspect/view/derive/contradictionEdges');
const { derivePersonaInteractions } = require('../../src/inspect/view/derive/personaInteractions');
const { deriveStageDurations } = require('../../src/inspect/view/derive/stageDurations');

const FIX = path.resolve(__dirname, '..', 'fixtures', 'inspect');

test('buildView produces the InvestigationView shape on the ready fixture', async () => {
  const li = await buildLoaderInput(path.join(FIX, 'ready'));
  const view = buildView(li);

  // Top-level keys
  for (const k of [
    'id', 'raw_capture', 'status', 'budget', 'stages',
    'discovery', 'coordinator', 'debates', 'forum',
    'synthesis', 'persona_interactions', 'parse_errors',
  ]) {
    assert.ok(k in view, `view.${k} present`);
  }

  // Reference run: 7 stages (canary — tied to STAGES constant in stageDurations.js,
  // independent of fixture content).
  assert.equal(view.stages.length, 7, 'seven pipeline stages rendered');
  // 12 forum nodes is canary-coupled to the `ready` fixture. If the fixture is
  // regenerated (see test/fixtures/inspect/README.md), update this number.
  assert.equal(view.forum.nodes.length, 12, 'twelve forum nodes');

  // Spec §8.5 + types.d.ts: each stage carries summary + detail_ref.
  for (const stage of view.stages) {
    assert.ok(stage.detail_ref, `${stage.key} has detail_ref`);
    if (stage.status === 'done' || stage.status === 'partial') {
      assert.ok(stage.summary, `${stage.key} done stage has summary`);
    }
  }
});

test('view model: contradiction edges are deduplicated', () => {
  const forumNodes = [
    { node_id: 'n_001', claim_id: 'c_A', working_group_id: 'sq_001', contradiction_with_node_id: 'n_002' },
    { node_id: 'n_002', claim_id: 'c_B', working_group_id: 'sq_002', contradiction_with_node_id: 'n_001' },
  ];
  const verdicts = {
    'c_A|c_B': { contradicts: true, reason: 'reason A↔B' },
  };
  const edges = deriveContradictionEdges(forumNodes, verdicts);
  assert.equal(edges.length, 1, 'one undirected edge despite mutual links');
  assert.equal(edges[0].from_node_id, 'n_001');
  assert.equal(edges[0].to_node_id, 'n_002');
  assert.equal(edges[0].reason, 'reason A↔B');
});

test('view model: persona interactions matrix counts move types correctly', () => {
  const debates = [
    {
      sub_question_id: 'sq_001',
      moves: [
        { move_id: 'm1', by_persona_id: 'B', type: 'Claim', references_move_id: null },
        { move_id: 'm2', by_persona_id: 'A', type: 'Rebut', references_move_id: 'm1' },
        { move_id: 'm3', by_persona_id: 'A', type: 'Rebut', references_move_id: 'm1' },
        { move_id: 'm4', by_persona_id: 'A', type: 'Rebut', references_move_id: 'm1' },
        { move_id: 'm5', by_persona_id: 'A', type: 'Concede', references_move_id: 'm1' },
        // Same-debate self-reference should not be counted.
        { move_id: 'm6', by_persona_id: 'A', type: 'Support', references_move_id: 'm5' },
      ],
    },
  ];
  const matrix = derivePersonaInteractions(debates);
  assert.deepEqual(matrix.A.B, { Rebut: 3, Concede: 1, Question: 0, Support: 0 });
  assert.equal(matrix.A.A, undefined, 'self-references are excluded');
});

test('view model: persona interactions cross-debate self-reference is excluded', () => {
  // The moveAuthor lookup is built across all debates, so a move authored by
  // persona A in sq_002 that references a move authored by A in sq_001 must
  // be classified as a self-reference and excluded.
  const debates = [
    {
      sub_question_id: 'sq_001',
      moves: [
        { move_id: 'm_sq_001_1', by_persona_id: 'A', type: 'Claim', references_move_id: null },
        { move_id: 'm_sq_001_2', by_persona_id: 'B', type: 'Rebut', references_move_id: 'm_sq_001_1' },
      ],
    },
    {
      sub_question_id: 'sq_002',
      moves: [
        { move_id: 'm_sq_002_1', by_persona_id: 'A', type: 'Claim', references_move_id: null },
        // A → A across debates — must not show up in the matrix.
        { move_id: 'm_sq_002_2', by_persona_id: 'A', type: 'Rebut', references_move_id: 'm_sq_001_1' },
        // B → A across debates — a legitimate cross-debate interaction.
        { move_id: 'm_sq_002_3', by_persona_id: 'B', type: 'Concede', references_move_id: 'm_sq_001_1' },
      ],
    },
  ];
  const matrix = derivePersonaInteractions(debates);
  assert.equal(matrix.A?.A, undefined, 'cross-debate self-reference excluded');
  assert.deepEqual(matrix.B.A, { Rebut: 1, Concede: 1, Question: 0, Support: 0 });
});

test('view model: stage durations handle null timestamps', () => {
  const loaderInput = {
    index: {
      investigation: {
        pair_debates: [],
        forum: { constructed_at: null, nodes: [] },
        synthesis: null,
      },
    },
    enrichments: {
      discovery: { timings: { started_at: '2026-01-01T00:00:00Z', completed_at: null } },
      coordinator: {
        timings: {
          initial: { started_at: null, completed_at: null },
          spawn: { started_at: null, completed_at: null },
        },
        spawn_declined: true,
      },
      debates: {},
      crossPollination: { timings: { started_at: null, completed_at: null } },
      forum: { timings: { started_at: null, completed_at: null } },
      synthesis: { timings: { started_at: null, completed_at: null } },
      parseErrors: { parse_errors: [] },
    },
  };
  const stages = deriveStageDurations(loaderInput);
  const discovery = stages.find((s) => s.key === 'discovery');
  assert.equal(discovery.duration_ms, null, 'duration is null when completed_at is missing');
  assert.ok(!Number.isNaN(discovery.duration_ms ?? 0));
  assert.equal(discovery.status, 'partial');

  const synth = stages.find((s) => s.key === 'synthesis');
  assert.equal(synth.status, 'not_run');

  const spawn = stages.find((s) => s.key === 'coordinator_spawn');
  assert.equal(spawn.status, 'skipped');
});

test('view model: synthesis stage shows "partial" when started but timestamps missing', () => {
  const loaderInput = {
    index: {
      investigation: {
        pair_debates: [],
        forum: { constructed_at: null, nodes: [] },
        // Synthesis object exists but has no produced_at — pipeline is mid-write.
        synthesis: {},
      },
    },
    enrichments: {
      discovery: { timings: { started_at: null, completed_at: null } },
      coordinator: {
        timings: {
          initial: { started_at: null, completed_at: null },
          spawn: { started_at: null, completed_at: null },
        },
        spawn_declined: false,
      },
      debates: {},
      crossPollination: { timings: { started_at: null, completed_at: null } },
      forum: { timings: { started_at: null, completed_at: null } },
      synthesis: { timings: { started_at: '2026-01-01T00:00:00Z', completed_at: null } },
      parseErrors: { parse_errors: [] },
    },
  };
  const stages = deriveStageDurations(loaderInput);
  const synth = stages.find((s) => s.key === 'synthesis');
  assert.equal(synth.started_at, '2026-01-01T00:00:00Z');
  assert.equal(synth.completed_at, null);
  assert.equal(synth.duration_ms, null);
  assert.equal(synth.status, 'partial', 'started without completed_at is partial, not not_run');
});

test('view model: synthesis null on investigating fixture', async () => {
  const li = await buildLoaderInput(path.join(FIX, 'investigating'));
  const view = buildView(li);
  assert.equal(view.synthesis, null);
  assert.equal(view.forum.nodes.length, 0);
  assert.deepEqual(view.debates, {});
});

// --- v5 dispatch path ---

test('buildView routes a v5 idea through working_groups, not debates', async () => {
  const li = await buildLoaderInput(path.join(FIX, 'ready-v5'));
  const view = buildView(li);

  assert.equal(view.schema_version, 'v5');
  // v4 `debates` should be empty for v5 ideas; v5 `working_groups` carries the data.
  assert.deepEqual(view.debates, {});
  assert.equal(Object.keys(view.working_groups).length, 1);
  const wg = view.working_groups['t_001'];
  assert.ok(wg, 'working group for t_001');
  assert.equal(wg.territory?.id, 't_001');
  assert.equal(wg.candidate_questions.length, 1);
  assert.equal(wg.aligned_questions.length, 1);
  assert.equal(wg.researcher_reports.length, 1);
  assert.equal(wg.observations.length, 1);
  assert.equal(wg.moves.length, 1);
  assert.equal(wg.surviving_claims.length, 1);
});

test('buildView v5: coordinator exposes territories, not sub_questions', async () => {
  const li = await buildLoaderInput(path.join(FIX, 'ready-v5'));
  const view = buildView(li);

  assert.equal(view.coordinator.territories.length, 1);
  assert.equal(view.coordinator.territories[0].id, 't_001');
});

test('buildView v5: stages use v5 labels (6 stages, no coordinator_spawn)', async () => {
  const li = await buildLoaderInput(path.join(FIX, 'ready-v5'));
  const view = buildView(li);

  // STAGES_V5 has 6 stages — coordinator_spawn is removed.
  assert.equal(view.stages.length, 6);
  assert.ok(!view.stages.some((s) => s.key === 'coordinator_spawn'));
  const debates = view.stages.find((s) => s.key === 'debates');
  assert.ok(debates.label.toLowerCase().includes('working'));
});

test('buildView v5: synthesis exposes question_landscape and budget exposes researcher tool calls', async () => {
  const li = await buildLoaderInput(path.join(FIX, 'ready-v5'));
  const view = buildView(li);

  assert.ok(view.synthesis.question_landscape);
  assert.equal(view.synthesis.question_landscape.length, 1);
  assert.equal(view.budget.max_researcher_tool_calls, 60);
  assert.equal(view.budget.used_researcher_tool_calls, 12);
});

test('buildView v5: forum exposes dead_end_questions (even when empty)', async () => {
  const li = await buildLoaderInput(path.join(FIX, 'ready-v5'));
  const view = buildView(li);
  assert.ok(Array.isArray(view.forum.dead_end_questions));
});
