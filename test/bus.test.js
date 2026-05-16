'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createBus, EVENTS } = require('../src/bus');

test('createBus returns a bus with emit, on, onAny, setIdea', () => {
  const bus = createBus();
  assert.equal(typeof bus.emit, 'function');
  assert.equal(typeof bus.on, 'function');
  assert.equal(typeof bus.onAny, 'function');
  assert.equal(typeof bus.setIdea, 'function');
});

test('emit calls named listener with merged envelope', () => {
  const bus = createBus();
  bus.setIdea('test-idea-1');
  const received = [];
  bus.on('pipeline.start', (env) => received.push(env));
  bus.emit('pipeline.start', { raw_capture: 'hello' });
  assert.equal(received.length, 1);
  assert.equal(received[0].raw_capture, 'hello');
  assert.equal(received[0].idea_id, 'test-idea-1');
  assert.ok(typeof received[0].ts === 'number');
  assert.equal(received[0].name, 'pipeline.start');
});

test('catch-all * listener receives every named event with .name set', () => {
  const bus = createBus();
  const names = [];
  bus.onAny((env) => names.push(env.name));
  bus.emit('pipeline.start', {});
  bus.emit('wg.start', { territory_id: 't_001' });
  assert.deepEqual(names, ['pipeline.start', 'wg.start']);
});

test('listener errors do not crash the emitter or mute subsequent listeners', () => {
  const bus = createBus();
  const called = [];
  bus.on('pipeline.start', () => { throw new Error('broken listener'); });
  bus.on('pipeline.start', () => called.push('second'));
  // Should not throw
  bus.emit('pipeline.start', {});
  assert.deepEqual(called, ['second']);
});

test('setIdea is sticky across multiple emits', () => {
  const bus = createBus();
  bus.setIdea('sticky-id');
  const ids = [];
  bus.onAny((env) => ids.push(env.idea_id));
  bus.emit('pipeline.start', {});
  bus.emit('wg.start', {});
  assert.deepEqual(ids, ['sticky-id', 'sticky-id']);
});

test('on returns a cleanup function that removes the listener', () => {
  const bus = createBus();
  const calls = [];
  const off = bus.on('pipeline.start', () => calls.push(1));
  bus.emit('pipeline.start', {});
  off();
  bus.emit('pipeline.start', {});
  assert.deepEqual(calls, [1]);
});

test('EVENTS catalog contains key event names', () => {
  assert.ok(EVENTS.PIPELINE_START);
  assert.ok(EVENTS.WG_START);
  assert.ok(EVENTS.API_CALL_START);
  assert.equal(EVENTS.PIPELINE_START, 'pipeline.start');
  assert.equal(EVENTS.WG_END, 'wg.end');
});
