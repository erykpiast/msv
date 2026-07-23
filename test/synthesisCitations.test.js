'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  buildEntityIndex,
  resolveInternalId,
  scanAndResolve,
  redactUnresolved,
  buildRepairPrompt,
} = require('../src/agents/synthesisCitations');

function buildFixtureInputs() {
  return {
    forum: {
      nodes: [
        {
          node_id: 'n_001',
          evidence_refs: [{ finding_id: 'f_aq1_01' }],
        },
        {
          node_id: 'n_002',
          evidence_refs: [{ observation_id: 'o_t1_001' }],
        },
        {
          node_id: 'n_003',
          // No evidence_refs at all — a resolvable node with nothing to cite.
          evidence_refs: [],
        },
      ],
    },
    pairDebates: [
      {
        territory_id: 't1',
        researcher_reports: [
          {
            report_id: 'rr_001',
            findings: [
              { finding_id: 'f_aq1_01', source_url: 'https://example.com/a', source_title: 'Source A' },
            ],
          },
        ],
        observations: [
          { observation_id: 'o_t1_001', cited_finding_ids: ['f_aq1_01'] },
        ],
      },
    ],
  };
}

test('buildEntityIndex indexes findings, observations, and forum nodes by id', () => {
  const { forum, pairDebates } = buildFixtureInputs();
  const index = buildEntityIndex({ forum, pairDebates });

  assert.ok(index.findingsById.has('f_aq1_01'));
  assert.ok(index.observationsById.has('o_t1_001'));
  assert.ok(index.nodesById.has('n_001'));
  assert.ok(index.nodesById.has('n_002'));
});

test('resolveInternalId resolves a finding_id directly to its source', () => {
  const { forum, pairDebates } = buildFixtureInputs();
  const index = buildEntityIndex({ forum, pairDebates });

  assert.deepEqual(resolveInternalId('f_aq1_01', index), {
    url: 'https://example.com/a',
    title: 'Source A',
  });
});

test('resolveInternalId walks observation_id -> cited_finding_ids -> finding', () => {
  const { forum, pairDebates } = buildFixtureInputs();
  const index = buildEntityIndex({ forum, pairDebates });

  assert.deepEqual(resolveInternalId('o_t1_001', index), {
    url: 'https://example.com/a',
    title: 'Source A',
  });
});

test('resolveInternalId walks node_id -> evidence_refs -> finding/observation', () => {
  const { forum, pairDebates } = buildFixtureInputs();
  const index = buildEntityIndex({ forum, pairDebates });

  assert.deepEqual(resolveInternalId('n_001', index), {
    url: 'https://example.com/a',
    title: 'Source A',
  });
  assert.deepEqual(resolveInternalId('n_002', index), {
    url: 'https://example.com/a',
    title: 'Source A',
  });
});

test('resolveInternalId returns null for a known node with no resolvable evidence', () => {
  const { forum, pairDebates } = buildFixtureInputs();
  const index = buildEntityIndex({ forum, pairDebates });

  assert.equal(resolveInternalId('n_003', index), null);
});

test('scanAndResolve rewrites a bare resolvable id in tension_points.sides[].position as an inline link', () => {
  const { forum, pairDebates } = buildFixtureInputs();
  const index = buildEntityIndex({ forum, pairDebates });
  const payload = {
    report: 'Report body.',
    tension_points: [
      {
        title: 'T',
        description: 'The claim in n_001 is disputed.',
        sides: [{ label: 'Side A', position: 'This holds per n_002.' }],
        resolution: null,
      },
    ],
  };

  const { payload: resolved, unresolved } = scanAndResolve(payload, index);

  assert.equal(unresolved.length, 0);
  assert.match(resolved.tension_points[0].description, /\[Source A\]\(https:\/\/example\.com\/a\)/);
  assert.match(resolved.tension_points[0].sides[0].position, /\[Source A\]\(https:\/\/example\.com\/a\)/);
  // Original payload is untouched — the resolver returns a new object.
  assert.match(payload.tension_points[0].description, /n_001/);
});

test('scanAndResolve reports an unresolved id (known node, no citable evidence) with field path and context', () => {
  const { forum, pairDebates } = buildFixtureInputs();
  const index = buildEntityIndex({ forum, pairDebates });
  const payload = {
    report: 'See n_003 for details.',
  };

  const { unresolved } = scanAndResolve(payload, index);

  assert.equal(unresolved.length, 1);
  assert.equal(unresolved[0].id, 'n_003');
  assert.equal(unresolved[0].field, 'report');
  assert.match(unresolved[0].context, /n_003/);
});

test('scanAndResolve flags a shaped-but-hallucinated id as unresolved even when it is absent from the index', () => {
  // Design §2: an id that "references a finding/observation that doesn't
  // exist" must still be caught, not just ids that resolve to a dead end.
  const payload = { report: 'The strongest claim is n_999, per the debate.' };
  const { unresolved } = scanAndResolve(payload, {
    findingsById: new Map(),
    observationsById: new Map(),
    nodesById: new Map(),
  });

  assert.equal(unresolved.length, 1);
  assert.equal(unresolved[0].id, 'n_999');
});

test('scanAndResolve covers area_title, proposal topic/territory_hint, and question_landscape prose, but exempts territory_id', () => {
  const index = {
    findingsById: new Map(),
    observationsById: new Map(),
    nodesById: new Map(),
  };
  const payload = {
    sections: [{ area_title: 'Area n_101', area_summary: 'ok', key_findings: [] }],
    next_pass_proposals: [{ topic: 'Dig into n_102', rationale: 'ok', territory_hint: 'see n_103' }],
    question_landscape: [
      {
        territory_name: 'T',
        // Matching id shape, but territory_id is exempt (structured metadata) —
        // must not be flagged even though it looks like an internal id.
        territory_id: 'n_999',
        questions: [{ question: 'Why n_104?', origin: 'ok', provenance_note: 'from n_105' }],
      },
    ],
  };

  const { unresolved } = scanAndResolve(payload, index);
  const ids = unresolved.map((u) => u.id).sort();

  assert.deepEqual(ids, ['n_101', 'n_102', 'n_103', 'n_104', 'n_105']);
});

test('scanAndResolve does not flag ordinary domain prose that merely resembles an id prefix', () => {
  const payload = {
    report: 'The p_value was below 0.05, and the o_ring failed under pressure; r_squared held.',
  };
  const { unresolved } = scanAndResolve(payload, {
    findingsById: new Map(),
    observationsById: new Map(),
    nodesById: new Map(),
  });

  assert.deepEqual(unresolved, []);
});

test('redactUnresolved replaces the given ids with [unverified] and leaves everything else alone', () => {
  const payload = {
    report: 'Cites n_003 and also mentions f_aq1_01.',
    key_references: [{ url: 'https://x.com', title: 'X', summary: 'about n_003', key_observations: [] }],
  };

  const redacted = redactUnresolved(payload, ['n_003']);

  assert.equal(redacted.report, 'Cites [unverified] and also mentions f_aq1_01.');
  assert.equal(redacted.key_references[0].summary, 'about [unverified]');
});

test('redactUnresolved is a no-op when given no ids', () => {
  const payload = { report: 'n_003 untouched' };
  assert.equal(redactUnresolved(payload, []), payload);
});

test('buildRepairPrompt batches every unresolved reference into a single message', () => {
  const prompt = buildRepairPrompt([
    { id: 'n_003', field: 'report', context: 'See n_003 for details.' },
    { id: 'p_009', field: 'tension_points[0].sides[1].label', context: 'per p_009' },
  ]);

  assert.match(prompt, /n_003/);
  assert.match(prompt, /p_009/);
  assert.match(prompt, /emit_synthesis/);
});
