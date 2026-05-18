'use strict';

class CancellationError extends Error {
  constructor(message) {
    super(message);
    this.name = 'CancellationError';
  }
}

// Thrown by api_queue when total retry latency exceeds the per-call wall-clock
// cap. classifyError treats it as 'anthropic_unavailable'. Exported so tests
// can construct it directly instead of regex-matching an error message.
class WallClockCapError extends Error {
  constructor(message, { cause } = {}) {
    super(message);
    this.name = 'WallClockCapError';
    if (cause !== undefined) this.cause = cause;
  }
}

const RETRYABLE_NETWORK_CODES = new Set([
  'ETIMEDOUT',
  'ECONNRESET',
  'ENOTFOUND',
  'ECONNREFUSED',
  'EPIPE',
]);

function classifyError(err) {
  if (err instanceof CancellationError) return 'user_cancelled';
  if (err instanceof WallClockCapError) return 'anthropic_unavailable';
  const status = err?.status ?? err?.response?.status;
  if (typeof status === 'number' && status >= 500 && status < 600) return 'anthropic_unavailable';
  if (status === 429) return 'anthropic_unavailable';
  const code = err?.code ?? err?.cause?.code;
  if (RETRYABLE_NETWORK_CODES.has(code)) return 'anthropic_unavailable';
  // Message-shape fallback for legacy callers that throw a plain Error with
  // the wall-clock-cap text; the instanceof check above is the primary path.
  if (typeof err?.message === 'string' && /exceeded wall-clock cap/.test(err.message)) {
    return 'anthropic_unavailable';
  }
  return 'internal_error';
}

function sanitiseMessage(err) {
  const raw = err instanceof Error ? err.message : String(err);
  // Strip CR (\x0d) along with the other control chars: error messages may be
  // printed to a terminal someday, and "legit\rmalicious" would overwrite the
  // preceding line. We keep \x09 (tab) and \x0a (LF) for readability.
  // eslint-disable-next-line no-control-regex
  return raw.replace(/[\x00-\x08\x0b-\x0c\x0d-\x1f\x7f-\x9f]/g, '').slice(0, 1024);
}

function actionableMessage({ id, reason, stage, territory_id, sub_stage }) {
  const where = [
    stage,
    territory_id && `territory ${territory_id}`,
    sub_stage,
  ]
    .filter(Boolean)
    .join(' / ') || 'unknown';
  return `✗ ${id} failed (${reason}) at ${where} — resume with: msv run ${id}`;
}

module.exports = { CancellationError, WallClockCapError, classifyError, sanitiseMessage, actionableMessage };
