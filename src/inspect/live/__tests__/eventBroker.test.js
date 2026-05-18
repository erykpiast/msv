'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createBroker } = require('../eventBroker');

test('publishEvent rejects mismatched idea_id', () => {
  const broker = createBroker({ ideaId: 'idea-A' });
  const frames = [];
  broker.subscribe({ write: (f) => frames.push(f) });

  const result = broker.publishEvent({ idea_id: 'idea-B', name: 'pipeline.start' });

  assert.equal(result, false);
  assert.equal(broker._ring.length, 0);
  // subscriber should have received no event frames (only the initial replay,
  // which is empty because ring was empty at subscribe time)
  assert.equal(frames.length, 0);
});

test('publishEvent enqueues event and notifies subscriber', () => {
  const broker = createBroker({ ideaId: 'idea-1' });
  const frames = [];
  broker.subscribe({ write: (f) => frames.push(f) });

  const env = { idea_id: 'idea-1', name: 'pipeline.start' };
  const result = broker.publishEvent(env);

  assert.equal(result, true);
  assert.equal(broker._ring.length, 1);
  assert.equal(frames.length, 1);
  assert.ok(frames[0].startsWith('event: event\n'));
  assert.ok(frames[0].includes('"pipeline.start"'));
});

test('subscribe replays all ring events then the last view in order', async () => {
  const broker = createBroker({ ideaId: 'idea-2' });

  broker.publishEvent({ idea_id: 'idea-2', name: 'e1' });
  broker.publishEvent({ idea_id: 'idea-2', name: 'e2' });
  broker.publishEvent({ idea_id: 'idea-2', name: 'e3' });
  broker.publishView({ status: 'ok' });

  const frames = [];
  broker.subscribe({ write: (f) => frames.push(f) });

  // Replay is async (batched via setImmediate); drain the queue before asserting.
  await new Promise((resolve) => setImmediate(resolve));

  // First three frames should be event replays (history before snapshot)
  assert.equal(frames.length, 4);
  assert.ok(frames[0].startsWith('event: event\n'), `expected event first, got: ${frames[0]}`);
  assert.ok(frames[0].includes('"e1"'));
  assert.ok(frames[1].includes('"e2"'));
  assert.ok(frames[2].includes('"e3"'));
  // Last frame should be the view replay (authoritative ground truth)
  assert.ok(frames[3].startsWith('event: view\n'), `expected view last, got: ${frames[3]}`);
});

test('ring overflow trims oldest events', () => {
  const broker = createBroker({ ideaId: 'idea-3' });

  // Publish 10,001 events
  for (let i = 0; i < 10_001; i++) {
    broker.publishEvent({ idea_id: 'idea-3', name: 'e', seq: i });
  }

  assert.equal(broker._ring.length, 10_000);
  // The oldest event (seq: 0) should be gone; newest is seq: 10000
  assert.equal(broker._ring[0].seq, 1);
  assert.equal(broker._ring[broker._ring.length - 1].seq, 10_000);
});

test('broken subscriber is dropped from the set', () => {
  const broker = createBroker({ ideaId: 'idea-4' });

  let writeCount = 0;
  const brokenWriter = {
    write() {
      writeCount++;
      throw new Error('socket closed');
    },
  };

  broker.subscribe(brokenWriter);
  assert.equal(broker._subscribers.size, 1);

  broker.publishEvent({ idea_id: 'idea-4', name: 'test' });

  assert.equal(broker._subscribers.size, 0);
  // write was called once (during broadcast), then the subscriber was removed
  assert.equal(writeCount, 1);
});

test('unsubscribe returned from subscribe removes the subscriber', () => {
  const broker = createBroker({ ideaId: 'idea-unsubscribe' });
  const written = [];
  const res = { write: (frame) => written.push(frame) };

  const unsubscribe = broker.subscribe(res);
  assert.equal(broker._subscribers.size, 1, 'subscriber added');

  unsubscribe();
  assert.equal(broker._subscribers.size, 0, 'subscriber removed');

  // Publishing after unsubscribe should not call res.write
  written.length = 0;
  broker.publishEvent({ idea_id: 'idea-unsubscribe', name: 'any', ts: 1 });
  assert.equal(written.length, 0, 'no write after unsubscribe');
});
