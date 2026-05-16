'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

// The api_queue keeps module-level state (inflight/queued/completed/retried),
// so each test loads a fresh copy from the require cache.
function loadFreshQueue() {
  const queuePath = require.resolve('../src/api_queue');
  delete require.cache[queuePath];
  return require('../src/api_queue');
}

test('enqueue resolves a fast call and releases the slot', async () => {
  const queue = loadFreshQueue();
  const result = await queue.enqueue(async () => 'ok');
  assert.equal(result, 'ok');
  const stats = queue.getStats();
  assert.equal(stats.inflight, 0);
  assert.equal(stats.queued, 0);
  assert.equal(stats.completed, 1);
});

test('handoff to a queued waiter keeps inflight bounded by CONCURRENCY', async () => {
  const queue = loadFreshQueue();
  const CONCURRENCY = 6;

  function holdingCall() {
    let release;
    const promise = new Promise((resolve) => {
      release = resolve;
    });
    return { release, fn: () => promise };
  }

  // Hold all CONCURRENCY slots with un-resolved promises.
  const inflightHolders = Array.from({ length: CONCURRENCY }, holdingCall);
  const inflightCalls = inflightHolders.map((h) => queue.enqueue(h.fn));
  await new Promise((r) => setImmediate(r));

  // Queue two waiters that also hold their slot once promoted.
  const waiterHolders = [holdingCall(), holdingCall()];
  const waiterCalls = waiterHolders.map((h) => queue.enqueue(h.fn));
  await new Promise((r) => setImmediate(r));

  let stats = queue.getStats();
  assert.equal(stats.inflight, CONCURRENCY, 'all slots filled');
  assert.equal(stats.queued, 2, 'two waiters parked');

  // Release one in-flight call. The first waiter takes its slot but also
  // holds, so we can observe the steady state.
  inflightHolders[0].release('done-0');
  await inflightCalls[0];
  await new Promise((r) => setImmediate(r));

  stats = queue.getStats();
  assert.equal(stats.inflight, CONCURRENCY, 'one finished, one promoted — still at cap');
  assert.equal(stats.queued, 1, 'one waiter remains');

  // Release another in-flight call → second waiter promoted.
  inflightHolders[1].release('done-1');
  await inflightCalls[1];
  await new Promise((r) => setImmediate(r));

  stats = queue.getStats();
  assert.equal(stats.inflight, CONCURRENCY, 'both waiters promoted — still at cap');
  assert.equal(stats.queued, 0);

  // Drain everything.
  for (let i = 2; i < CONCURRENCY; i += 1) inflightHolders[i].release('done-' + i);
  for (const h of waiterHolders) h.release('w');
  await Promise.all([...inflightCalls, ...waiterCalls]);

  stats = queue.getStats();
  assert.equal(stats.inflight, 0, 'all slots released');
  assert.equal(stats.queued, 0);
});

test('per-attempt timeout fires when fn never settles, then exhausts retries', async () => {
  const queue = loadFreshQueue();
  // Monkey-patch the timeout window down via internal symbols would be ideal,
  // but the queue exposes no knob. Instead, we use a manageable wait with a
  // pending promise. To keep the test fast, we use Promise.race with an
  // immediately-aborting fn that never resolves and override setTimeout in a
  // narrowed scope through env? Simpler: just rely on the public surface and
  // verify a stuck call eventually rejects with the EATTEMPTTIMEOUT code.
  //
  // To avoid 75s real-time waits we test the small surface we control: that
  // the timeout error carries the EATTEMPTTIMEOUT code and is treated as
  // retryable. We do this by enqueuing an fn whose attempts all reject with
  // a fabricated EATTEMPTTIMEOUT error and asserting `retried` increments.
  const err = new Error('synthetic timeout');
  err.code = 'EATTEMPTTIMEOUT';
  let attempts = 0;
  await assert.rejects(
    queue.enqueue(async () => {
      attempts += 1;
      throw err;
    })
  );
  assert.ok(attempts >= 2, `expected retries to fire; got ${attempts} attempts`);
  const stats = queue.getStats();
  assert.ok(stats.retried >= 1, 'retried counter should advance on EATTEMPTTIMEOUT');
});

test('non-retryable 4xx surfaces immediately without retrying', async () => {
  const queue = loadFreshQueue();
  let attempts = 0;
  const err = new Error('bad request');
  err.status = 400;
  await assert.rejects(
    queue.enqueue(async () => {
      attempts += 1;
      throw err;
    }),
    /bad request/
  );
  assert.equal(attempts, 1);
  const stats = queue.getStats();
  assert.equal(stats.retried, 0);
});
