'use strict';

function parseRelayUrl(raw) {
  const fallback = 'http://127.0.0.1:5180/events';
  if (!raw) return fallback;
  try {
    const u = new URL(raw);
    if (!['127.0.0.1', '::1', 'localhost'].includes(u.hostname)) {
      process.stderr.write(`[msv:relay] MSV_INSPECT_URL "${raw}" is not a loopback address — using default\n`);
      return fallback;
    }
    return raw;
  } catch {
    process.stderr.write(`[msv:relay] MSV_INSPECT_URL "${raw}" is not a valid URL — using default\n`);
    return fallback;
  }
}

const RELAY_URL = parseRelayUrl(process.env.MSV_INSPECT_URL);
const RELAY_TIMEOUT_MS = 200;

function attachRelay(bus) {
  if (process.env.MSV_NO_RELAY === '1') return () => {};

  const off = bus.onAny((env) => {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), RELAY_TIMEOUT_MS);
    fetch(RELAY_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(env),
      signal: ctrl.signal,
    })
      .catch(() => {})
      .finally(() => clearTimeout(timer));
  });

  return () => {
    off();
  };
}

module.exports = { attachRelay };
