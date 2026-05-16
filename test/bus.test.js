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

// Test: EVENTS catalog exhaustiveness.
//
// Walks every .js file under src/ recursively, greps for literal
// `<bus|busRef>.emit('<name>'` patterns, and asserts every name appears in
// the EVENTS catalog values.
//
// Limitations:
// - Dynamic emits (`bus.emit(name, ...)` with a variable) are skipped because
//   the regex only matches string literals. This is intentional — there are
//   currently no dynamic emits in src/, and adding one would require updating
//   this test alongside it.
// - The regex matches single- and double-quoted strings; backtick template
//   literals are not supported (none exist today).
test('EVENTS catalog covers every literal bus.emit(...) call in src/', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const srcRoot = path.resolve(__dirname, '..', 'src');

  // Match bus.emit('name', ...) or busRef.emit('name', ...) — both quote styles.
  const EMIT_REGEX = /\b(?:bus|busRef)\??\.emit\(\s*['"]([\w.]+)['"]/g;

  const emitted = new Set();
  const entries = fs.readdirSync(srcRoot, { recursive: true, withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    if (!entry.name.endsWith('.js')) continue;
    const full = path.join(entry.parentPath || entry.path, entry.name);
    const source = fs.readFileSync(full, 'utf8');
    let match;
    while ((match = EMIT_REGEX.exec(source)) !== null) {
      emitted.add(match[1]);
    }
  }

  const catalog = new Set(Object.values(EVENTS));
  const missing = [...emitted].filter((name) => !catalog.has(name));
  assert.deepEqual(
    missing,
    [],
    `event names emitted in src/ but missing from EVENTS catalog: ${missing.join(', ')}`
  );

  // Sanity: catalog should also be non-empty and contain at least the events
  // we know are emitted (guards against the regex silently matching nothing).
  assert.ok(emitted.size > 0, 'no bus.emit(...) calls were found — regex broken?');
  assert.ok(emitted.has('pipeline.start'));
  assert.ok(emitted.has('wg.start'));
  assert.ok(emitted.has('api.call.start'));
});
