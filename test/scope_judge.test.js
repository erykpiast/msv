'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// Redirect ~/.msv to a per-process temp dir so appendLog calls inside
// runScopeJudge don't pollute the developer's real ideas directory. Must
// happen before requiring storage / scope_judge (see coordinator.test.js).
const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'scope-judge-test-'));
process.env.MSV_ROOT = path.join(tmpHome, '.msv');
fs.mkdirSync(path.join(process.env.MSV_ROOT, 'ideas', 'i_test', 'logs'), { recursive: true });

const {
  runScopeJudge,
  bucketScoreToTerritoryTarget,
  FALLBACK_TARGET,
} = require('../src/agents/scope_judge');
const { readLog } = require('../src/storage');

const IDEA = { id: 'i_test', raw_capture: 'Some topic to judge.' };

function makeCreateClient(handler) {
  return {
    messages: {
      create: async (params, opts) => handler(params, opts),
    },
  };
}

function scoreResponse(score) {
  return {
    stop_reason: 'tool_use',
    content: [
      { type: 'tool_use', name: 'report_scope', id: 'tu_1', input: { score } },
    ],
    usage: { input_tokens: 10, output_tokens: 5 },
  };
}

test('bucketScoreToTerritoryTarget: narrow scores map to T=3', () => {
  assert.equal(bucketScoreToTerritoryTarget(1), 3);
  assert.equal(bucketScoreToTerritoryTarget(3), 3);
});

test('bucketScoreToTerritoryTarget: no-signal scores map to T=5', () => {
  assert.equal(bucketScoreToTerritoryTarget(4), 5);
  assert.equal(bucketScoreToTerritoryTarget(6), 5);
});

test('bucketScoreToTerritoryTarget: broad scores map to T=10', () => {
  assert.equal(bucketScoreToTerritoryTarget(7), 10);
  assert.equal(bucketScoreToTerritoryTarget(10), 10);
});

test('bucketScoreToTerritoryTarget: missing or out-of-range scores fall back to the safe default, not the max bucket', () => {
  assert.equal(bucketScoreToTerritoryTarget(undefined), FALLBACK_TARGET);
  assert.equal(bucketScoreToTerritoryTarget(NaN), FALLBACK_TARGET);
  assert.equal(bucketScoreToTerritoryTarget(11), FALLBACK_TARGET);
});

test('runScopeJudge: happy path returns score and bucketed target', async () => {
  const client = makeCreateClient(() => scoreResponse(8));

  const result = await runScopeJudge({ client, idea: IDEA, budget: {} });

  assert.equal(result.score, 8);
  assert.equal(result.target, 10);

  const entries = await readLog('i_test', 'scope_judge');
  const responseLog = entries.find((e) => e.kind === 'response');
  assert.ok(responseLog);
  assert.equal(responseLog.payload.score, 8);
  assert.equal(responseLog.payload.target, 10);
});

test('runScopeJudge: truncated call with no tool_use falls back to the no-signal target', async () => {
  const client = makeCreateClient(() => ({
    stop_reason: 'max_tokens',
    content: [],
    usage: { input_tokens: 5, output_tokens: 300 },
  }));

  const result = await runScopeJudge({ client, idea: IDEA, budget: {} });

  assert.equal(result.score, null);
  assert.equal(result.target, FALLBACK_TARGET);

  const entries = await readLog('i_test', 'scope_judge');
  assert.ok(entries.find((e) => e.kind === 'truncated_fallback'));
});

test('runScopeJudge: truncated tool_use with a missing score falls back to the safe default (not the max bucket)', async () => {
  const client = makeCreateClient(() => ({
    stop_reason: 'max_tokens',
    content: [{ type: 'tool_use', name: 'report_scope', id: 'tu_partial', input: {} }],
    usage: { input_tokens: 5, output_tokens: 300 },
  }));

  const result = await runScopeJudge({ client, idea: IDEA, budget: {} });

  assert.equal(result.target, FALLBACK_TARGET);
});
