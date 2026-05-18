'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createBus } = require('./bus');

// Helper: load a fresh module copy so env-var-based branches can be tested
// independently without one test polluting the next.
function loadFreshRelay() {
  const relayPath = require.resolve('./event_relay');
  delete require.cache[relayPath];
  return require('./event_relay');
}

// ---------------------------------------------------------------------------
// 1. Relay POSTs the envelope to the configured URL
// ---------------------------------------------------------------------------
test('relay POSTs the envelope to the default URL with correct headers and body', async () => {
  const originalFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, opts) => {
    calls.push({ url, opts });
    return { ok: true };
  };

  // Delete any overriding env var so we get the default URL
  const savedUrl = process.env.MSV_INSPECT_URL;
  const savedNoRelay = process.env.MSV_NO_RELAY;
  delete process.env.MSV_INSPECT_URL;
  delete process.env.MSV_NO_RELAY;

  try {
    const { attachRelay } = loadFreshRelay();
    const bus = createBus();
    bus.setIdea('idea-1');
    const detach = attachRelay(bus);

    bus.emit('pipeline.start', { raw_capture: 'hello' });

    // Give the microtask queue a tick to let the async fetch call register
    await new Promise((r) => setImmediate(r));

    detach();

    assert.equal(calls.length, 1, 'expected exactly one POST');
    assert.equal(calls[0].url, 'http://127.0.0.1:5180/events');
    assert.equal(calls[0].opts.method, 'POST');
    assert.equal(calls[0].opts.headers['content-type'], 'application/json');

    const body = JSON.parse(calls[0].opts.body);
    assert.equal(body.name, 'pipeline.start');
    assert.equal(body.raw_capture, 'hello');
    assert.equal(body.idea_id, 'idea-1');
  } finally {
    globalThis.fetch = originalFetch;
    if (savedUrl === undefined) {
      delete process.env.MSV_INSPECT_URL;
    } else {
      process.env.MSV_INSPECT_URL = savedUrl;
    }
    if (savedNoRelay === undefined) {
      delete process.env.MSV_NO_RELAY;
    } else {
      process.env.MSV_NO_RELAY = savedNoRelay;
    }
  }
});

// ---------------------------------------------------------------------------
// 2. Relay swallows network errors
// ---------------------------------------------------------------------------
test('relay swallows network errors and does not throw', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    throw new Error('network failure');
  };

  const savedUrl = process.env.MSV_INSPECT_URL;
  const savedNoRelay = process.env.MSV_NO_RELAY;
  delete process.env.MSV_INSPECT_URL;
  delete process.env.MSV_NO_RELAY;

  try {
    const { attachRelay } = loadFreshRelay();
    const bus = createBus();
    const detach = attachRelay(bus);

    // Emit several events — none should throw
    bus.emit('pipeline.start', {});
    bus.emit('wg.start', {});
    bus.emit('pipeline.complete', {});

    // Wait for all microtasks / promises
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));

    detach();
    // If we reach here without an uncaught rejection, the test passes.
  } finally {
    globalThis.fetch = originalFetch;
    if (savedUrl === undefined) {
      delete process.env.MSV_INSPECT_URL;
    } else {
      process.env.MSV_INSPECT_URL = savedUrl;
    }
    if (savedNoRelay === undefined) {
      delete process.env.MSV_NO_RELAY;
    } else {
      process.env.MSV_NO_RELAY = savedNoRelay;
    }
  }
});

// ---------------------------------------------------------------------------
// 3. MSV_INSPECT_URL overrides the default URL
// ---------------------------------------------------------------------------
test('MSV_INSPECT_URL env var overrides the default relay URL', async () => {
  const originalFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, opts) => {
    calls.push({ url, opts });
    return { ok: true };
  };

  const savedUrl = process.env.MSV_INSPECT_URL;
  const savedNoRelay = process.env.MSV_NO_RELAY;
  process.env.MSV_INSPECT_URL = 'http://localhost:9999/my-events';
  delete process.env.MSV_NO_RELAY;

  try {
    const { attachRelay } = loadFreshRelay();
    const bus = createBus();
    const detach = attachRelay(bus);

    bus.emit('pipeline.start', {});

    await new Promise((r) => setImmediate(r));

    detach();

    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, 'http://localhost:9999/my-events');
  } finally {
    globalThis.fetch = originalFetch;
    if (savedUrl === undefined) {
      delete process.env.MSV_INSPECT_URL;
    } else {
      process.env.MSV_INSPECT_URL = savedUrl;
    }
    if (savedNoRelay === undefined) {
      delete process.env.MSV_NO_RELAY;
    } else {
      process.env.MSV_NO_RELAY = savedNoRelay;
    }
  }
});

// ---------------------------------------------------------------------------
// 4. MSV_NO_RELAY=1 disables the relay entirely
// ---------------------------------------------------------------------------
test('MSV_NO_RELAY=1 disables the relay — zero POSTs are made', async () => {
  const originalFetch = globalThis.fetch;
  let fetchCallCount = 0;
  globalThis.fetch = async () => {
    fetchCallCount += 1;
    return { ok: true };
  };

  const savedUrl = process.env.MSV_INSPECT_URL;
  const savedNoRelay = process.env.MSV_NO_RELAY;
  delete process.env.MSV_INSPECT_URL;
  process.env.MSV_NO_RELAY = '1';

  try {
    const { attachRelay } = loadFreshRelay();
    const bus = createBus();
    const detach = attachRelay(bus);

    bus.emit('pipeline.start', {});
    bus.emit('wg.start', {});

    await new Promise((r) => setImmediate(r));

    detach();

    assert.equal(fetchCallCount, 0, 'expected no fetch calls when MSV_NO_RELAY=1');
  } finally {
    globalThis.fetch = originalFetch;
    if (savedUrl === undefined) {
      delete process.env.MSV_INSPECT_URL;
    } else {
      process.env.MSV_INSPECT_URL = savedUrl;
    }
    if (savedNoRelay === undefined) {
      delete process.env.MSV_NO_RELAY;
    } else {
      process.env.MSV_NO_RELAY = savedNoRelay;
    }
  }
});

// ---------------------------------------------------------------------------
// 5. AbortController.abort is called on timeout
// ---------------------------------------------------------------------------
test('AbortController.abort is called within ~300ms when fetch never resolves', async () => {
  const originalFetch = globalThis.fetch;
  let abortCalled = false;
  const originalAbortController = globalThis.AbortController;

  // Patch AbortController to spy on abort()
  globalThis.AbortController = class SpyAbortController {
    constructor() {
      this.signal = { aborted: false };
      this.abort = () => {
        abortCalled = true;
        this.signal.aborted = true;
      };
    }
  };

  // fetch never resolves
  globalThis.fetch = () => new Promise(() => {});

  const savedUrl = process.env.MSV_INSPECT_URL;
  const savedNoRelay = process.env.MSV_NO_RELAY;
  delete process.env.MSV_INSPECT_URL;
  delete process.env.MSV_NO_RELAY;

  try {
    const { attachRelay } = loadFreshRelay();
    const bus = createBus();
    const detach = attachRelay(bus);

    bus.emit('pipeline.start', {});

    // Wait up to 300ms for the abort to fire (relay timeout is 200ms)
    await new Promise((resolve) => {
      const deadline = Date.now() + 300;
      function check() {
        if (abortCalled || Date.now() >= deadline) {
          resolve();
        } else {
          setTimeout(check, 10);
        }
      }
      check();
    });

    detach();

    assert.ok(abortCalled, 'expected AbortController.abort() to be called after timeout');
  } finally {
    globalThis.fetch = originalFetch;
    globalThis.AbortController = originalAbortController;
    if (savedUrl === undefined) {
      delete process.env.MSV_INSPECT_URL;
    } else {
      process.env.MSV_INSPECT_URL = savedUrl;
    }
    if (savedNoRelay === undefined) {
      delete process.env.MSV_NO_RELAY;
    } else {
      process.env.MSV_NO_RELAY = savedNoRelay;
    }
  }
});
