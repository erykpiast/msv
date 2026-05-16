'use strict';

class CancellationError extends Error {
  constructor(message) {
    super(message);
    this.name = 'CancellationError';
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
  const status = err?.status ?? err?.response?.status;
  if (typeof status === 'number' && status >= 500 && status < 600) return 'anthropic_unavailable';
  if (status === 429) return 'anthropic_unavailable';
  const code = err?.code ?? err?.cause?.code;
  if (RETRYABLE_NETWORK_CODES.has(code)) return 'anthropic_unavailable';
  if (typeof err?.message === 'string' && /exceeded wall-clock cap/.test(err.message)) {
    return 'anthropic_unavailable';
  }
  return 'internal_error';
}

function sanitiseMessage(err) {
  const raw = err instanceof Error ? err.message : String(err);
  // eslint-disable-next-line no-control-regex
  return raw.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f]/g, '').slice(0, 1024);
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

module.exports = { CancellationError, classifyError, sanitiseMessage, actionableMessage };
