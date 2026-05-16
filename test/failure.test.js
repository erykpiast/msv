// Test: classifyError() decides what the persisted last_failure.reason will
// be, which in turn dictates the message shown to the user. A regression here
// means a real outage gets reported as 'internal_error' and the user thinks
// there's a code bug.

const test = require('node:test');
const assert = require('node:assert/strict');
const { classifyError, sanitiseMessage, actionableMessage, CancellationError } = require('../src/failure');

test('500 status → anthropic_unavailable', () => {
  const err = Object.assign(new Error('Internal Server Error'), { status: 500 });
  assert.equal(classifyError(err), 'anthropic_unavailable');
});

test('503 status → anthropic_unavailable', () => {
  assert.equal(classifyError(Object.assign(new Error(), { status: 503 })), 'anthropic_unavailable');
});

test('529 status → anthropic_unavailable', () => {
  assert.equal(classifyError(Object.assign(new Error(), { status: 529 })), 'anthropic_unavailable');
});

test('429 → anthropic_unavailable (sustained rate-limit treated same as 5xx)', () => {
  assert.equal(classifyError(Object.assign(new Error(), { status: 429 })), 'anthropic_unavailable');
});

test('ETIMEDOUT → anthropic_unavailable', () => {
  assert.equal(classifyError(Object.assign(new Error(), { code: 'ETIMEDOUT' })), 'anthropic_unavailable');
});

test('ECONNRESET → anthropic_unavailable', () => {
  assert.equal(classifyError(Object.assign(new Error(), { code: 'ECONNRESET' })), 'anthropic_unavailable');
});

test('EPIPE → anthropic_unavailable', () => {
  assert.equal(classifyError(Object.assign(new Error(), { code: 'EPIPE' })), 'anthropic_unavailable');
});

test('nested cause code → anthropic_unavailable', () => {
  const err = new Error('network failure');
  err.cause = new Error('underlying');
  err.cause.code = 'ENOTFOUND';
  assert.equal(classifyError(err), 'anthropic_unavailable');
});

test('wall-clock cap message → anthropic_unavailable', () => {
  // api_queue.js wraps the underlying error and prefixes the message.
  assert.equal(
    classifyError(new Error('API call exceeded wall-clock cap (90000ms) after 3 retries: Internal Server Error')),
    'anthropic_unavailable'
  );
});

test('CancellationError → user_cancelled', () => {
  assert.equal(classifyError(new CancellationError('cancelled at t1 ideation')), 'user_cancelled');
});

test('400 status (validation) → internal_error', () => {
  // 4xx except 429 means our prompt is wrong, not Anthropic being unavailable.
  assert.equal(
    classifyError(Object.assign(new Error('invalid_request_error'), { status: 400 })),
    'internal_error'
  );
});

test('plain TypeError → internal_error', () => {
  assert.equal(classifyError(new TypeError('Cannot read undefined')), 'internal_error');
});

test('null / undefined → internal_error (does not crash)', () => {
  assert.equal(classifyError(null), 'internal_error');
  assert.equal(classifyError(undefined), 'internal_error');
  assert.equal(classifyError('string error'), 'internal_error');
});

test('sanitiseMessage strips control chars and clips to 1 KB', () => {
  // Error messages may contain web content surfaced via SDK error.message.
  // Control chars are unsafe when later printed to terminal or rendered.
  const longCtl = '\x07' + 'x'.repeat(2000);
  const msg = sanitiseMessage(new Error(longCtl));
  assert.equal(msg.length, 1024);
  assert.doesNotMatch(msg, /[\x00-\x1f]/);
});

test('sanitiseMessage strips CR (\\x0d) — prevents terminal line overwrite', () => {
  // CR alone moves the cursor to the start of the line. "legit\rmalicious" prints
  // as "malicious" when sent to a terminal. CR must be stripped from any string
  // that might one day be printed.
  const msg = sanitiseMessage(new Error('legit message\rmalicious overwrite'));
  assert.equal(msg, 'legit messagemalicious overwrite');
  assert.ok(!msg.includes('\r'));
});

test('sanitiseMessage strips ESC (\\x1b) — prevents ANSI/OSC sequences', () => {
  const msg = sanitiseMessage(new Error('before\x1b[31mred\x1b[0m after'));
  assert.ok(!msg.includes('\x1b'));
});

test('sanitiseMessage preserves \\t and \\n (readable whitespace)', () => {
  const msg = sanitiseMessage(new Error('line1\nline2\tindented'));
  assert.ok(msg.includes('\n'));
  assert.ok(msg.includes('\t'));
});

test('sanitiseMessage handles non-Error values', () => {
  assert.equal(sanitiseMessage('plain string'), 'plain string');
  assert.equal(sanitiseMessage({ message: 'ignored' }), '[object Object]');
});

test('actionableMessage formats a terminal-safe line', () => {
  const msg = actionableMessage({
    id: 'abc-123',
    reason: 'anthropic_unavailable',
    stage: '4_working_groups',
    territory_id: 'regulatory',
    sub_stage: 'researcher',
  });
  assert.match(msg, /✗ abc-123/);
  assert.match(msg, /anthropic_unavailable/);
  assert.match(msg, /4_working_groups/);
  assert.match(msg, /territory regulatory/);
  assert.match(msg, /researcher/);
  assert.match(msg, /msv run abc-123/);
});

test('actionableMessage omits null territory and sub_stage gracefully', () => {
  const msg = actionableMessage({
    id: 'abc-123',
    reason: 'user_cancelled',
    stage: '5_cross_pollination',
    territory_id: null,
    sub_stage: null,
  });
  assert.match(msg, /5_cross_pollination/);
  assert.doesNotMatch(msg, /null/);
});
