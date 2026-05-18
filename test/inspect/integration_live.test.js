// NOTE: Despite the filename, these tests exercise the broker in isolation
// (no Vite server, no HTTP). HTTP-level middleware behavior (body cap, SSE
// headers, pipeline.complete → flushNow) is not covered here.
// TODO: replace or supplement with a real HTTP-level test using node:http.
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createBroker } = require('../../src/inspect/live/eventBroker');

// Minimal fake response writable that captures written SSE frames.
function makeFakeRes() {
  const frames = [];
  return {
    write(frame) {
      frames.push(frame);
    },
    frames,
  };
}

test('POST event → GET stream subscriber receives it', () => {
  const broker = createBroker({ ideaId: 'test-idea' });
  const res = makeFakeRes();

  broker.subscribe(res);
  broker.publishEvent({ idea_id: 'test-idea', name: 'pipeline.stage.start', stage: 'discovery', ts: 1 });

  assert.equal(res.frames.length, 1);
  assert.ok(res.frames[0].startsWith('event: event\n'), `expected SSE event frame, got: ${res.frames[0]}`);
  assert.ok(res.frames[0].includes('"pipeline.stage.start"'), 'frame must contain event name');
  assert.ok(res.frames[0].includes('"discovery"'), 'frame must contain stage payload');
});

test('GET stream first, then POST — event arrives after subscribe', () => {
  const broker = createBroker({ ideaId: 'idea-late' });
  const res = makeFakeRes();

  // Subscribe before any events are published
  broker.subscribe(res);
  assert.equal(res.frames.length, 0, 'no frames before any publish');

  broker.publishEvent({ idea_id: 'idea-late', name: 'wg.start', territory_id: 't_001', ts: 2 });

  assert.equal(res.frames.length, 1);
  assert.ok(res.frames[0].includes('"wg.start"'), 'frame must contain wg.start event');
});

test('POST with wrong idea_id is dropped — subscriber not notified', () => {
  const broker = createBroker({ ideaId: 'right-idea' });
  const res = makeFakeRes();

  broker.subscribe(res);
  const published = broker.publishEvent({ idea_id: 'wrong-idea', name: 'pipeline.stage.start', stage: 'discovery', ts: 3 });

  assert.equal(published, false, 'publishEvent must return false for wrong idea_id');
  assert.equal(res.frames.length, 0, 'subscriber must not receive frames for wrong idea_id');
});

test('two subscribers receive the same event', () => {
  const broker = createBroker({ ideaId: 'shared-idea' });
  const res1 = makeFakeRes();
  const res2 = makeFakeRes();

  broker.subscribe(res1);
  broker.subscribe(res2);

  broker.publishEvent({ idea_id: 'shared-idea', name: 'pipeline.complete', ts: 4 });

  assert.equal(res1.frames.length, 1, 'first subscriber receives the event');
  assert.equal(res2.frames.length, 1, 'second subscriber receives the event');
  assert.equal(res1.frames[0], res2.frames[0], 'both subscribers receive identical frames');
  assert.ok(res1.frames[0].includes('"pipeline.complete"'), 'frame contains event name');
});
