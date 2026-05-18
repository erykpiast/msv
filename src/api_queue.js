// API queue — single entry point for every messages.create call.
//
// Built against @anthropic-ai/sdk@0.96.0.
// Concurrency limit: 6 (Anthropic Tier-2 rate limits throttle at ~20 concurrent).
// Max retries: 5 per call.
// Backoff: Retry-After header (capped at BACKOFF_MAX_MS) first; exponential with jitter (base 1 s, max 30 s) otherwise.
// Retry classes: 429, all 5xx, network errors (ETIMEDOUT, ECONNRESET, ENOTFOUND, ECONNREFUSED),
// and queue-level per-attempt timeouts (code EATTEMPTTIMEOUT — see below).
// Immediate surface: any 4xx except 429.
// Per-call wall-clock cap (CALL_WALL_CLOCK_MAX_MS) bounds total retry latency to avoid stall under sustained 429.
// Per-attempt timeout (PER_ATTEMPT_TIMEOUT_MS) backstops the SDK's own timeout via Promise.race:
// observed in production that the SDK's AbortController-based timeout sometimes leaves a Promise
// pending forever (zero open sockets, 0% CPU, no rejection). Without this backstop the queue
// slot is held indefinitely and Promise.allSettled in the caller never resolves.

'use strict';

const { WallClockCapError } = require('./failure');

const CONCURRENCY = 6;
const MAX_RETRIES = 5;
const BACKOFF_BASE_MS = 1_000;
const BACKOFF_MAX_MS = 30_000;
const CALL_WALL_CLOCK_MAX_MS = 90_000;
// Slightly above SDK_REQUEST_TIMEOUT_MS (60s in anthropic.js) so the SDK has a
// chance to reject cleanly first; this fires only if the SDK promise never
// settles at all.
const PER_ATTEMPT_TIMEOUT_MS = 75_000;

const RETRYABLE_NETWORK_CODES = new Set([
  'ETIMEDOUT',
  'ECONNRESET',
  'ENOTFOUND',
  'ECONNREFUSED',
  'EPIPE',
  'EATTEMPTTIMEOUT',
]);

let inflight = 0;
let queued = 0;
let completed = 0;
let retried = 0;
let callCounter = 0;

let busRef = null;

function setBus(bus) {
  busRef = bus;
}

const waiters = [];

// Reset per-run stats. `callCounter` is intentionally NOT reset — it's a stable
// monotonic identifier used to correlate api.call.start / .end / .retry events
// across the run, not a per-run statistic. Waiters are cleared so a fresh run
// doesn't inherit pending acquire waiters from a previous (presumably crashed) run.
function resetStats() {
  inflight = 0;
  queued = 0;
  completed = 0;
  retried = 0;
  waiters.length = 0;
}

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

// Race fn() against a setTimeout. Timer is unref'd so a stale timer can't keep
// the event loop alive, and is cleared on settle so we don't leak handles.
function runWithAttemptTimeout(fn, ms) {
  let timer;
  let timedOut = false;
  const callPromise = Promise.resolve().then(fn);
  const timeoutPromise = new Promise((_, reject) => {
    timer = setTimeout(() => {
      timedOut = true;
      const err = new Error(`API attempt exceeded per-attempt timeout (${ms}ms)`);
      err.code = 'EATTEMPTTIMEOUT';
      reject(err);
    }, ms);
    if (typeof timer.unref === 'function') timer.unref();
  });
  return Promise.race([callPromise, timeoutPromise]).finally(() => {
    clearTimeout(timer);
    if (timedOut) {
      callPromise.catch(() => {});
    }
  });
}

async function runWithRetries(fn, startedAt, perAttemptTimeoutMs, wallClockMaxMs, callId) {
  let lastError;
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt += 1) {
    try {
      return await runWithAttemptTimeout(fn, perAttemptTimeoutMs);
    } catch (error) {
      lastError = error;
      if (!isRetryable(error) || attempt === MAX_RETRIES) {
        throw error;
      }
      const elapsed = Date.now() - startedAt;
      if (elapsed >= wallClockMaxMs) {
        throw new WallClockCapError(
          `API call exceeded wall-clock cap (${wallClockMaxMs}ms) after ${attempt} retries: ${error.message}`,
          { cause: error }
        );
      }
      retried += 1;
      const wait = Math.min(retryAfterMs(error, attempt), wallClockMaxMs - elapsed);
      if (busRef) {
        busRef.emit('api.call.retry', {
          call_id: callId,
          attempt,
          reason: error?.message || String(error),
          wait_ms: wait,
        });
      }
      await sleep(Math.max(0, wait));
    }
  }
  throw lastError;
}

// On handoff, the slot stays "occupied" — the leaving owner doesn't decrement
// inflight and the incoming waiter doesn't increment it. The previous version
// did inflight += 1 inside the waiter callback without a matching decrement
// here, inflating `inflight` by 1 per handoff and skewing getStats().
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
    waiters.push(resolve);
  });
}

/**
 * Enqueue an API call thunk. Handles bounded concurrency and retry/backoff.
 *
 * Callers with unusually heavy single calls (e.g. the synthesizer, which
 * consumes the full forum) can raise the limits via options; otherwise the
 * defaults tuned for working-group calls apply.
 *
 * @param {() => Promise<any>} fn - Thunk wrapping a messages.create call.
 * @param {{ perAttemptTimeoutMs?: number, wallClockMaxMs?: number, model?: string }} [options]
 * @returns {Promise<any>}
 */
async function enqueue(fn, options = {}) {
  const perAttemptTimeoutMs = options.perAttemptTimeoutMs ?? PER_ATTEMPT_TIMEOUT_MS;
  const wallClockMaxMs = options.wallClockMaxMs ?? CALL_WALL_CLOCK_MAX_MS;
  const { model } = options;
  await acquireSlot();
  const callId = ++callCounter;
  const startedAt = Date.now();
  if (busRef) busRef.emit('api.call.start', { call_id: callId, model });
  try {
    const result = await runWithRetries(fn, startedAt, perAttemptTimeoutMs, wallClockMaxMs, callId);
    completed += 1;
    if (busRef) {
      const usage = result?.usage || {};
      busRef.emit('api.call.end', {
        call_id: callId,
        outcome: 'ok',
        ms: Date.now() - startedAt,
        input_tokens: usage.input_tokens || 0,
        output_tokens: usage.output_tokens || 0,
      });
    }
    return result;
  } catch (err) {
    if (busRef) {
      busRef.emit('api.call.end', {
        call_id: callId,
        outcome: 'failed',
        ms: Date.now() - startedAt,
        error_message: err?.message || String(err),
      });
    }
    throw err;
  } finally {
    releaseSlot();
  }
}

module.exports = { enqueue, getStats, setBus, resetStats };
