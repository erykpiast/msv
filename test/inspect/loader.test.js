const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { buildLoaderInput } = require('../../src/inspect/loader');
const { contradictionKey } = require('../../src/forum');

const FIX = path.resolve(__dirname, '..', 'fixtures', 'inspect');

test('loader merges index + logs correctly on the ready fixture', async () => {
  const input = await buildLoaderInput(path.join(FIX, 'ready'));

  // Top-level shape: index parsed, logs aggregated, enrichments produced.
  assert.ok(input.index.id, 'index.json must parse');
  assert.equal(input.index.status, 'archived');
  assert.ok(input.logs['pair-sq_001'], 'pair logs must be loaded');
  assert.ok(input.enrichments.discovery.timings.started_at, 'discovery timings present');

  // Every debate enrichment should carry per-move attempt counts on every move.
  for (const debate of input.index.investigation.pair_debates) {
    const sqEnr = input.enrichments.debates[debate.sub_question_id];
    assert.ok(sqEnr, `enrichment present for ${debate.sub_question_id}`);
    const moveIds = Object.keys(sqEnr.moves);
    assert.ok(moveIds.length > 0, `enrichment must produce per-move data for ${debate.sub_question_id}`);
    for (const moveId of moveIds) {
      assert.equal(
        typeof sqEnr.moves[moveId].attempt,
        'number',
        `${debate.sub_question_id}/${moveId} has numeric attempt count`
      );
    }
  }

  // Forum verdicts must be keyed using src/forum.js#contradictionKey convention
  // (sorted claim_id_a|claim_id_b).
  const verdictKeys = Object.keys(input.enrichments.forum.contradiction_verdicts);
  assert.ok(verdictKeys.length > 0, 'forum-contradictions verdicts must be loaded');
  for (const key of verdictKeys) {
    const [a, b] = key.split('|');
    assert.equal(key, contradictionKey({ claim_id: a }, { claim_id: b }), `verdict key sorted: ${key}`);
  }
});

test('loader tolerates missing logs and partial transcripts', async () => {
  // Sub-case (a): investigating fixture (later-stage logs absent).
  const inv = await buildLoaderInput(path.join(FIX, 'investigating'));
  assert.equal(inv.index.status, 'investigating');
  assert.deepEqual(inv.enrichments.debates, {});
  assert.equal(inv.enrichments.synthesis.timings.started_at, null);
  assert.deepEqual(inv.enrichments.forum.contradiction_verdicts, {});
  assert.deepEqual(inv.enrichments.parseErrors.parse_errors, []);

  // Sub-case (b): degraded-discovery fixture (empty persona arrays).
  const deg = await buildLoaderInput(path.join(FIX, 'degraded-discovery'));
  assert.deepEqual(deg.index.investigation.perspective_discovery.candidate_personas, []);
  assert.ok(Array.isArray(deg.index.investigation.pair_debates));
});
