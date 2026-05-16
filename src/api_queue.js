// API queue — single entry point for every messages.create call.
//
// Built against @anthropic-ai/sdk@0.96.0.
// Concurrency limit: 6 (Anthropic Tier-2 rate limits throttle at ~20 concurrent).
// Max retries: 5 per call.
// Backoff: Retry-After header (capped at BACKOFF_MAX_MS) first; exponential with jitter (base 1 s, max 30 s) otherwise.
// Retry classes: 429, all 5xx, network errors (ETIMEDOUT, ECONNRESET, ENOTFOUND, ECONNREFUSED).
// Immediate surface: any 4xx except 429.
// Per-call wall-clock cap (CALL_WALL_CLOCK_MAX_MS) bounds total retry latency to avoid stall under sustained 429.

'use strict';

const CONCURRENCY = 6;
const MAX_RETRIES = 5;
const BACKOFF_BASE_MS = 1_000;
const BACKOFF_MAX_MS = 30_000;
const CALL_WALL_CLOCK_MAX_MS = 90_000;

const RETRYABLE_NETWORK_CODES = new Set([
  'ETIMEDOUT',
  'ECONNRESET',
  'ENOTFOUND',
  'ECONNREFUSED',
  'EPIPE',
]);

let inflight = 0;
let queued = 0;
let completed = 0;
let retried = 0;

const waiters = [];

function getStats() {
  return { inflight, queued, completed, retried };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function parseRetryAfterMs(retryAfterHeader) {
  if (!retryAfterHeader) return null;
  const seconds = Number(retryAfterHeader);
  if (!Number.isNaN(seconds)) return Math.min(seconds * 1_000, BACKOFF_MAX_MS);
  const date = Date.parse(retryAfterHeader);
  if (!Number.isNaN(date)) return Math.min(Math.max(0, date - Date.now()), BACKOFF_MAX_MS);
  return null;
}

function isRetryable(error) {
  const status = error?.status ?? error?.response?.status;
  if (status === 429) return true;
  if (status != null && status >= 500 && status < 600) return true;
  if (status != null && status >= 400 && status < 500) return false;
  const code = error?.code ?? error?.cause?.code;
  if (RETRYABLE_NETWORK_CODES.has(code)) return true;
  return false;
}

function retryAfterMs(error, attempt) {
  const header = error?.headers?.['retry-after'] ?? error?.response?.headers?.['retry-after'];
  const fromHeader = parseRetryAfterMs(header);
  if (fromHeader != null) return fromHeader;
  const jitter = Math.random() * BACKOFF_BASE_MS;
  return Math.min(BACKOFF_BASE_MS * 2 ** (attempt - 1) + jitter, BACKOFF_MAX_MS);
}

async function runWithRetries(fn, startedAt) {
  let lastError;
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt += 1) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      if (!isRetryable(error) || attempt === MAX_RETRIES) {
        throw error;
      }
      const elapsed = Date.now() - startedAt;
      if (elapsed >= CALL_WALL_CLOCK_MAX_MS) {
        // Surface a hard error rather than continue stalling the queue.
        const stallError = new Error(
          `API call exceeded wall-clock cap (${CALL_WALL_CLOCK_MAX_MS}ms) after ${attempt} retries: ${error.message}`
        );
        stallError.cause = error;
        throw stallError;
      }
      retried += 1;
      const wait = Math.min(retryAfterMs(error, attempt), CALL_WALL_CLOCK_MAX_MS - elapsed);
      await sleep(Math.max(0, wait));
    }
  }
  throw lastError;
}

function releaseSlot() {
  if (waiters.length > 0) {
    const next = waiters.shift();
    queued -= 1;
    next();
  } else {
    inflight -= 1;
  }
}

async function acquireSlot() {
  if (inflight < CONCURRENCY) {
    inflight += 1;
    return;
  }
  queued += 1;
  await new Promise((resolve) => {
    waiters.push(() => {
      inflight += 1;
      resolve();
    });
  });
}

/**
 * Enqueue an API call thunk. Handles bounded concurrency and retry/backoff.
 *
 * @param {() => Promise<any>} fn - Thunk wrapping a messages.create call.
 * @returns {Promise<any>}
 */
async function enqueue(fn) {
  await acquireSlot();
  const startedAt = Date.now();
  try {
    const result = await runWithRetries(fn, startedAt);
    completed += 1;
    return result;
  } finally {
    releaseSlot();
  }
}

module.exports = { enqueue, getStats };
