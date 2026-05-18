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

const { normalizeReport, coerceArray } = require('../src/agents/researcher');
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
