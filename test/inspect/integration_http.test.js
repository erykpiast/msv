'use strict';

// HTTP-level integration tests for `msv inspect`'s Vite middleware. Unlike
// `integration_live.test.js`, this file boots the real Vite dev server and
// drives it over HTTP via fetch. The primary regression guard is the
// /events/stream-before-/events ordering invariant: see commit 9313a02.
//
// These tests are slow because Vite cold-starts (~1-3s). Each test reuses a
// single server instance via node:test's before/after hooks to keep total
// wall time bounded.

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { startInspectServer } = require('../../src/inspect/server');

const READY_FIXTURE = path.resolve(__dirname, '..', 'fixtures', 'inspect', 'ready');
// Idea id used in posted envelopes. Must match the broker's configured ideaId
// or the broker filters the event out (publishEvent returns false). The
// broker filters by the constructor ideaId, not by on-disk index.json.
const TEST_IDEA_ID = 'http-test-idea';

let server;
let baseUrl;

test.before(async () => {
  // port 0 -> OS picks a free ephemeral port. We resolve the actual port
  // afterwards from server.httpServer.address().
  server = await startInspectServer({
    ideaDir: READY_FIXTURE,
    ideaId: TEST_IDEA_ID,
    port: 0,
  });
  const addr = server.httpServer && server.httpServer.address && server.httpServer.address();
  assert.ok(addr && typeof addr === 'object', 'server.httpServer.address() must return an address object');
  baseUrl = `http://127.0.0.1:${addr.port}`;
});

test.after(async () => {
  if (server) {
    await server.close();
  }
});

test('GET /events/stream returns 200 with text/event-stream (not intercepted by /events handler)', async () => {
  // The bug fixed in commit 9313a02: Connect matches middleware by registration
  // order. '/events' is a prefix of '/events/stream', so registering /events
  // first caused it to swallow stream requests and respond 405 (only POST
  // allowed). The fix is to register /events/stream BEFORE /events.
  const controller = new AbortController();
  try {
    const res = await fetch(`${baseUrl}/events/stream`, {
      method: 'GET',
      signal: controller.signal,
    });

    assert.equal(res.status, 200, `expected 200, got ${res.status}`);
    const ct = res.headers.get('content-type') || '';
    assert.ok(
      ct.startsWith('text/event-stream'),
      `expected content-type to start with text/event-stream, got: ${ct}`,
    );
    // The SSE handler keeps the connection open indefinitely. Abort so the
    // server doesn't hold the request socket and so fetch() doesn't hang on
    // body consumption during teardown.
  } finally {
    controller.abort();
  }
});

test('POST /events with valid envelope returns 204', async () => {
  const envelope = {
    idea_id: TEST_IDEA_ID,
    name: 'pipeline.stage.start',
    stage: 'discovery',
    ts: Date.now(),
  };
  const res = await fetch(`${baseUrl}/events`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(envelope),
  });
  // Drain body so the connection can be released cleanly.
  await res.text();
  assert.equal(res.status, 204, `expected 204, got ${res.status}`);
});

test('POST /events with body over 1MB is rejected (413 or connection reset)', async () => {
  // Body cap is 1_000_000 bytes (see server.js). 1.5MB is safely over.
  const oversized = 'x'.repeat(1_500_000);
  const body = JSON.stringify({
    idea_id: TEST_IDEA_ID,
    name: 'pipeline.stage.start',
    stage: 'discovery',
    ts: Date.now(),
    padding: oversized,
  });
  // The server sets res.statusCode = 413, calls res.end(), then req.destroy()
  // as soon as it sees more than 1_000_000 bytes. Because the client is still
  // streaming the body when the socket is destroyed, two outcomes are possible
  // depending on chunk/ack timing:
  //   1. fetch resolves with status 413 (server's response arrived before the
  //      client finished writing).
  //   2. fetch rejects with EPIPE / ECONNRESET (server destroyed the socket
  //      mid-write).
  // Either outcome is evidence the cap was enforced. The negative assertion
  // that matters is: we must NOT get a 204 (which is the success response for
  // a well-formed envelope under the cap).
  let status = null;
  let networkError = null;
  try {
    const res = await fetch(`${baseUrl}/events`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body,
    });
    status = res.status;
    try {
      await res.text();
    } catch {
      // Server may destroy the socket mid-response; tolerate read errors.
    }
  } catch (err) {
    networkError = err;
  }

  if (status !== null) {
    assert.equal(status, 413, `expected 413, got ${status}`);
  } else {
    // Network-level abort. Verify it's a connection-reset class error and not
    // some unrelated failure (e.g. server crashed for a different reason).
    const code = networkError && networkError.cause && networkError.cause.code;
    assert.ok(
      code === 'EPIPE' || code === 'ECONNRESET' || code === 'UND_ERR_SOCKET',
      `expected EPIPE/ECONNRESET/UND_ERR_SOCKET on body-cap reject, got: ${code} (${networkError && networkError.message})`,
    );
  }
});

test('GET /events returns 405 (POST-only handler)', async () => {
  // Sanity check that /events still requires POST. Confirms the ordering fix
  // didn't accidentally make /events match too broadly.
  const res = await fetch(`${baseUrl}/events`, { method: 'GET' });
  await res.text();
  assert.equal(res.status, 405, `expected 405, got ${res.status}`);
});
