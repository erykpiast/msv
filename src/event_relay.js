'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { ideaDir } = require('./storage');

const DEFAULT_PORT = 5180;
const RELAY_TIMEOUT_MS = 200;
const PORT_FILE_NAME = '.inspect-port.json';
// How long a discovered port is trusted before we re-check disk. Balances
// picking up a fresh `msv inspect` session quickly against re-reading the
// port file on every single bus event.
const PORT_CACHE_TTL_MS = 2_000;

function parseRelayUrl(raw) {
  const fallback = `http://127.0.0.1:${DEFAULT_PORT}/events`;
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

// An explicit override always wins and is resolved once — it's a fixed
// user choice, unlike the per-idea auto-discovered port below.
const EXPLICIT_URL = process.env.MSV_INSPECT_URL ? parseRelayUrl(process.env.MSV_INSPECT_URL) : null;

function isPidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM means the process exists but is owned by someone else — still alive.
    return err.code === 'EPERM';
  }
}

// `msv inspect` writes its bound port + pid into the idea directory. Reading
// it here lets the relay find a session that fell back off the default port
// (e.g. a second `msv inspect` running while a stale one still holds 5180)
// without any manual MSV_INSPECT_URL coordination.
function readAnnouncedPort(ideaId) {
  let raw;
  try {
    raw = fs.readFileSync(path.join(ideaDir(ideaId), PORT_FILE_NAME), 'utf8');
  } catch {
    return null;
  }
  try {
    const { port, pid } = JSON.parse(raw);
    if (!Number.isInteger(port) || port <= 0) return null;
    if (!isPidAlive(pid)) return null;
    return port;
  } catch {
    return null;
  }
}

const portCache = new Map(); // idea_id -> { url, checkedAt }

function resolveUrl(ideaId) {
  if (EXPLICIT_URL) return EXPLICIT_URL;
  if (typeof ideaId !== 'string' || !ideaId) return `http://127.0.0.1:${DEFAULT_PORT}/events`;

  const cached = portCache.get(ideaId);
  const now = Date.now();
  if (cached && now - cached.checkedAt < PORT_CACHE_TTL_MS) return cached.url;

  const port = readAnnouncedPort(ideaId) ?? DEFAULT_PORT;
  const url = `http://127.0.0.1:${port}/events`;
  portCache.set(ideaId, { url, checkedAt: now });
  return url;
}

function attachRelay(bus) {
  if (process.env.MSV_NO_RELAY === '1') return () => {};

  const off = bus.onAny((env) => {
    const url = resolveUrl(env.idea_id);
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), RELAY_TIMEOUT_MS);
    fetch(url, {
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
