'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// Redirect ~/.msv to a per-process temp dir so appendLog inside runBreadthAnalysis
// doesn't touch the developer's real ideas directory. Must precede the require.
const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'breadth-test-'));
process.env.MSV_ROOT = path.join(tmpHome, '.msv');
fs.mkdirSync(path.join(process.env.MSV_ROOT, 'ideas', 'i_test', 'logs'), { recursive: true });

const {
  runBreadthAnalysis,
  collectFindings,
  evennessOf,
  extractAreas,
} = require('../src/agents/breadth');

const IDEA = { id: 'i_test', raw_capture: 'A topic.' };

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

const SYNTHESIS = {
  sections: [
    { area_title: 'A', area_summary: 's', key_findings: [{ content: 'f0' }, { content: 'f1' }] },
    { area_title: 'B', area_summary: 's', key_findings: [{ content: 'f2' }] },
  ],
  headline_findings: ['h0', 'h1'],
};

function areasResponse(areas) {
  return {
    stop_reason: 'tool_use',
    content: [{ type: 'tool_use', name: 'report_areas', id: 'tu_1', input: { areas } }],
    usage: { input_tokens: 10, output_tokens: 20 },
  };
}

// ---- pure helpers ----

test('collectFindings pools section key_findings + headline_findings, drops empties', () => {
  assert.deepEqual(collectFindings(SYNTHESIS), ['f0', 'f1', 'f2', 'h0', 'h1']);
  assert.deepEqual(collectFindings(null), []);
  assert.deepEqual(
    collectFindings({ sections: [{ key_findings: [{ content: '' }, {}] }], headline_findings: [1, 'ok'] }),
    ['ok']
  );
});

test('evennessOf: 1.0 for balanced areas, low for one dominant, 0 for <2', () => {
  assert.equal(evennessOf([3, 3]), 1);
  assert.equal(evennessOf([5]), 0);
  assert.equal(evennessOf([]), 0);
  assert.ok(evennessOf([10, 1, 1]) < 0.7);
});

test('extractAreas: plain array', () => {
  assert.deepEqual(
    extractAreas({ input: { areas: [{ label: 'x', finding_indices: [0] }] } }),
    [{ label: 'x', finding_indices: [0] }]
  );
});

test('extractAreas: unwraps double-encoded areas string holding {areas:[...]}', () => {
  const inner = JSON.stringify({ areas: [{ label: 'x', finding_indices: [0, 1] }] });
  assert.deepEqual(extractAreas({ input: { areas: inner } }), [
    { label: 'x', finding_indices: [0, 1] },
  ]);
});

test('extractAreas: unwraps double-encoded areas string holding a bare array', () => {
  const inner = JSON.stringify([{ label: 'y', finding_indices: [2] }]);
  assert.deepEqual(extractAreas({ input: { areas: inner } }), [{ label: 'y', finding_indices: [2] }]);
});

test('extractAreas: null on malformed / missing', () => {
  assert.equal(extractAreas({ input: {} }), null);
  assert.equal(extractAreas({ input: { areas: 'not json' } }), null);
  assert.equal(extractAreas(null), null);
});

// ---- full call ----

test('runBreadthAnalysis: happy path returns n_areas, evenness, cleaned areas', async () => {
  const client = makeCreateClient(() =>
    areasResponse([
      { label: 'Area one', finding_indices: [0, 1, 2] },
      { label: 'Area two', finding_indices: [3, 4] },
    ])
  );
  const result = await runBreadthAnalysis({ client, idea: IDEA, model: 'claude-sonnet-5', synthesis: SYNTHESIS });
  assert.equal(result.n_areas, 2);
  assert.equal(result.model, 'claude-sonnet-5');
  assert.equal(result.areas.length, 2);
  assert.ok(result.evenness > 0.9); // [3,2] is near-balanced
  assert.ok(result.computed_at);
});

test('runBreadthAnalysis: returns null without a call when <2 findings', async () => {
  let called = false;
  const client = makeCreateClient(() => {
    called = true;
    return areasResponse([]);
  });
  const result = await runBreadthAnalysis({
    client,
    idea: IDEA,
    model: 'claude-sonnet-5',
    synthesis: { sections: [{ key_findings: [{ content: 'only-one' }] }], headline_findings: [] },
  });
  assert.equal(result, null);
  assert.equal(called, false);
});

test('runBreadthAnalysis: null on malformed payload (does not throw)', async () => {
  const client = makeCreateClient(() => ({
    stop_reason: 'tool_use',
    content: [{ type: 'tool_use', name: 'report_areas', id: 'tu_1', input: { areas: 'garbage' } }],
    usage: { input_tokens: 1, output_tokens: 1 },
  }));
  const result = await runBreadthAnalysis({ client, idea: IDEA, model: 'claude-sonnet-5', synthesis: SYNTHESIS });
  assert.equal(result, null);
});

test('runBreadthAnalysis: drops areas with empty labels', async () => {
  const client = makeCreateClient(() =>
    areasResponse([
      { label: 'Real', finding_indices: [0] },
      { label: '', finding_indices: [1] },
    ])
  );
  const result = await runBreadthAnalysis({ client, idea: IDEA, model: 'claude-sonnet-5', synthesis: SYNTHESIS });
  assert.equal(result.n_areas, 1);
});
