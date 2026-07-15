const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// Redirect ~/.msv to a per-process temp dir so appendLog calls inside
// normalizeReport don't pollute the developer's real ideas directory.
// Must happen before requiring storage / researcher.
const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'researcher-test-'));
process.env.MSV_ROOT = path.join(tmpHome, '.msv');
fs.mkdirSync(path.join(process.env.MSV_ROOT, 'ideas', 'i_test', 'logs'), { recursive: true });

// Stub out grounding's network-fetching validator BEFORE researcher.js is
// first required: researcher.js destructures `validateFindingGrounding` at
// module-load time, so the override must land on the shared module.exports
// object before that require executes. Tests below only exercise the
// truncation-retry loop in runJointResearcher, not the grounding pass itself
// (which is covered separately), so a permissive always-ok stub keeps them
// hermetic (no real HTTP calls) without hiding a runtime dependency.
const grounding = require('../src/grounding');
grounding.validateFindingGrounding = async () => ({
  ok: true,
  errors: [],
  warnings: [],
  meta: {},
});

const { normalizeReport, coerceArray, runJointResearcher } = require('../src/agents/researcher');
const { readLog } = require('../src/storage');

const LOG_FILE = 'pair-t_test-researcher-aq_test';
const READ_LOG = () => readLog('i_test', LOG_FILE);

const F1 = { summary: 's1', source_url: 'u1', source_quote: 'q1', confidence_in_source: 7 };
const F2 = { summary: 's2', source_url: 'u2', source_quote: 'q2', confidence_in_source: 5 };

test('coerceArray: pass-through for real arrays', () => {
  assert.deepEqual(coerceArray([F1, F2]), [F1, F2]);
  assert.deepEqual(coerceArray([]), []);
});

test('coerceArray: parses stringified JSON arrays (the t_005 failure mode)', () => {
  const stringified = JSON.stringify([F1, F2]);
  assert.deepEqual(coerceArray(stringified), [F1, F2]);
});

test('coerceArray: returns null for non-array, non-parseable input', () => {
  assert.equal(coerceArray('not json'), null);
  assert.equal(coerceArray('"a string, not an array"'), null);
  assert.equal(coerceArray('{"k":"v"}'), null);
  assert.equal(coerceArray(null), null);
  assert.equal(coerceArray(undefined), null);
  assert.equal(coerceArray(42), null);
  assert.equal(coerceArray({ findings: [F1] }), null);
});

test('normalizeReport: well-formed input passes through unchanged', async () => {
  const result = await normalizeReport(
    { outcome: 'useful', findings: [F1, F2], search_trace: ['q1', 'q2'] },
    { ideaId: 'i_test', logFile: LOG_FILE, alignedId: 'aq_ok' }
  );
  assert.equal(result.outcome, 'useful');
  assert.deepEqual(result.findings, [F1, F2]);
  assert.deepEqual(result.search_trace, ['q1', 'q2']);
});

test('normalizeReport: recovers stringified findings without forcing dead_end', async () => {
  const result = await normalizeReport(
    {
      outcome: 'useful',
      findings: JSON.stringify([F1, F2]),
      search_trace: ['q1'],
    },
    { ideaId: 'i_test', logFile: LOG_FILE, alignedId: 'aq_strfind' }
  );
  assert.equal(result.outcome, 'useful');
  assert.equal(result.findings.length, 2);
  assert.deepEqual(result.findings[0], F1);
  // Recovery is silent — JSON.parse succeeded, so no malformed_emit is logged.
  // Read the log defensively: if no test before this one logged anything, the
  // file may not exist yet.
  let entries = [];
  try {
    entries = await READ_LOG();
  } catch (e) {
    if (e.code !== 'ENOENT') throw e;
  }
  assert.equal(
    entries.some((e) => e.kind === 'malformed_emit' && e.payload.aligned_id === 'aq_strfind'),
    false
  );
});

test('normalizeReport: unrecoverable findings → dead_end + malformed_emit log (the t_005 bug)', async () => {
  // Simulate the production failure: a 12,163-char garbage string instead of an array.
  const garbage = 'x'.repeat(12163);
  const result = await normalizeReport(
    { outcome: 'useful', findings: garbage, search_trace: [] },
    { ideaId: 'i_test', logFile: LOG_FILE, alignedId: 'aq_t_005_009_001' }
  );
  assert.equal(result.outcome, 'dead_end', 'outcome must downgrade to dead_end when findings are unrecoverable');
  assert.deepEqual(result.findings, []);
  assert.deepEqual(result.search_trace, []);

  const entries = await READ_LOG();
  const malformed = entries.find(
    (e) => e.kind === 'malformed_emit' && e.payload.aligned_id === 'aq_t_005_009_001'
  );
  assert.ok(malformed, 'malformed_emit log entry must be written');
  assert.deepEqual(malformed.payload.fields, ['findings']);
  assert.equal(malformed.payload.findings_type, 'string');
});

test('normalizeReport: malformed search_trace alone does not downgrade outcome', async () => {
  const result = await normalizeReport(
    { outcome: 'useful', findings: [F1], search_trace: 'not an array' },
    { ideaId: 'i_test', logFile: LOG_FILE, alignedId: 'aq_badtrace' }
  );
  assert.equal(result.outcome, 'useful', 'findings are fine → outcome preserved');
  assert.deepEqual(result.findings, [F1]);
  assert.deepEqual(result.search_trace, []);

  const entries = await READ_LOG();
  const malformed = entries.find(
    (e) => e.kind === 'malformed_emit' && e.payload.aligned_id === 'aq_badtrace'
  );
  assert.ok(malformed);
  assert.deepEqual(malformed.payload.fields, ['search_trace']);
});

test('normalizeReport: result.findings.map is always safe (the working_group.js:459 invariant)', async () => {
  // The whole point of the fix: downstream may call .map without guards.
  for (const badFindings of [
    JSON.stringify([F1]),  // recoverable
    'garbage',             // unrecoverable
    null,
    undefined,
    42,
    { not: 'an array' },
  ]) {
    const result = await normalizeReport(
      { outcome: 'useful', findings: badFindings, search_trace: [] },
      { ideaId: 'i_test', logFile: LOG_FILE, alignedId: 'aq_invariant' }
    );
    // Must not throw.
    const mapped = result.findings.map((f, i) => ({ finding_id: `f_${i}`, ...f }));
    assert.ok(Array.isArray(mapped));
  }
});

test('normalizeReport: rawInput=null/undefined produces a clean dead_end report', async () => {
  for (const bad of [null, undefined, 'string', 42]) {
    const result = await normalizeReport(bad, {
      ideaId: 'i_test',
      logFile: LOG_FILE,
      alignedId: 'aq_nullinput',
    });
    assert.deepEqual(result.findings, []);
    assert.deepEqual(result.search_trace, []);
    assert.equal(result.outcome, 'dead_end');
  }
});

// ---------------------------------------------------------------------------
// runJointResearcher — maxTokens bump + max_tokens truncation retry
// ---------------------------------------------------------------------------

function makeIdea() {
  return { id: 'i_test' };
}

function makeTerritory() {
  return { id: 't_test', name: 'Test Territory', description: 'A territory for testing.' };
}

function makeAlignedQuestion(suffix = '001') {
  return { aligned_id: `aq_${suffix}`, question: `Test question ${suffix}?` };
}

// Sequences a fixed list of `messages.create` responses; the last entry is
// reused for any call beyond the list length so tests don't need to predict
// exactly how many turns the loop takes.
function makeSequencedClient(responses) {
  const capturedParams = [];
  let call = 0;
  return {
    capturedParams,
    messages: {
      create: async (params) => {
        capturedParams.push(params);
        const idx = Math.min(call, responses.length - 1);
        call += 1;
        return responses[idx];
      },
    },
  };
}

function truncatedMalformedResponse({ outputTokens = 6000 } = {}) {
  return {
    stop_reason: 'max_tokens',
    content: [
      {
        type: 'tool_use',
        id: 'mock_report',
        name: 'emit_researcher_report',
        // Cut off mid-JSON: findings never closed out as a valid array.
        input: { outcome: 'useful', findings: 'x'.repeat(500), search_trace: [] },
      },
    ],
    usage: { input_tokens: 10, output_tokens: outputTokens },
  };
}

function wellFormedResponse() {
  return {
    stop_reason: 'tool_use',
    content: [
      {
        type: 'tool_use',
        id: 'mock_report',
        name: 'emit_researcher_report',
        input: {
          outcome: 'useful',
          findings: [
            {
              summary: 'Recovered finding.',
              source_url: 'https://example.com/a',
              source_quote: 'q',
              confidence_in_source: 7,
            },
          ],
          search_trace: ['query one'],
        },
      },
    ],
    usage: { input_tokens: 10, output_tokens: 800 },
  };
}

test('runJointResearcher: passes maxTokens 8000 to the underlying call', async () => {
  const client = makeSequencedClient([wellFormedResponse()]);

  await runJointResearcher({
    client,
    idea: makeIdea(),
    territory: makeTerritory(),
    alignedQuestion: makeAlignedQuestion('maxtok'),
  });

  assert.equal(client.capturedParams[0].max_tokens, 8000);
});

test('runJointResearcher: a truncated + malformed report triggers a retry instead of an immediate dead_end', async () => {
  const client = makeSequencedClient([truncatedMalformedResponse(), wellFormedResponse()]);

  const result = await runJointResearcher({
    client,
    idea: makeIdea(),
    territory: makeTerritory(),
    alignedQuestion: makeAlignedQuestion('retry_success'),
  });

  // The bug this fixes: without the retry, this would come back dead_end with
  // 0 findings even though the model had already done real research.
  assert.equal(client.capturedParams.length, 2, 'the model must be re-prompted exactly once');
  assert.equal(result.outcome, 'useful');
  assert.equal(result.findings.length, 1);
  assert.equal(result.findings[0].summary, 'Recovered finding.');

  const entries = await readLog('i_test', 'pair-t_test-researcher-aq_retry_success');
  const retryLog = entries.find((e) => e.kind === 'truncation_retry');
  assert.ok(retryLog, 'a truncation_retry log entry must be written');
  assert.equal(retryLog.payload.reason, 'findings_unrecoverable');
});

test('runJointResearcher: exhausting the retry (still truncated/malformed) falls back to dead_end without crashing', async () => {
  const client = makeSequencedClient([truncatedMalformedResponse(), truncatedMalformedResponse()]);

  const result = await runJointResearcher({
    client,
    idea: makeIdea(),
    territory: makeTerritory(),
    alignedQuestion: makeAlignedQuestion('retry_exhausted'),
  });

  assert.equal(result.outcome, 'dead_end');
  assert.deepEqual(result.findings, []);

  const entries = await readLog('i_test', 'pair-t_test-researcher-aq_retry_exhausted');
  const retryLogs = entries.filter((e) => e.kind === 'truncation_retry');
  assert.equal(retryLogs.length, 1, 'only one retry attempt is made, even when it also fails');
});
