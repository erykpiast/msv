'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createBus } = require('../../src/bus');
const { attach } = require('../../src/tui/debug');

function captureStdout(fn) {
  const chunks = [];
  const orig = process.stdout.write.bind(process.stdout);
  process.stdout.write = (chunk) => { chunks.push(String(chunk)); return true; };
  try {
    fn();
  } finally {
    process.stdout.write = orig;
  }
  return chunks.join('');
}

test('debug attach writes one JSON line per event', async () => {
  const bus = createBus();
  bus.setIdea('idea-1');
  const cleanup = attach(bus);

  const out = captureStdout(() => {
    bus.emit('pipeline.start', { raw_capture: 'hello' });
    bus.emit('wg.start', { territory_id: 't_001' });
  });

  await cleanup();

  const lines = out.trim().split('\n').filter(Boolean);
  assert.equal(lines.length, 2);
  const e1 = JSON.parse(lines[0]);
  assert.equal(e1.name, 'pipeline.start');
  assert.equal(e1.raw_capture, 'hello');
  const e2 = JSON.parse(lines[1]);
  assert.equal(e2.name, 'wg.start');
});

test('debug output is terminated by newline', async () => {
  const bus = createBus();
  const cleanup = attach(bus);
  const out = captureStdout(() => bus.emit('pipeline.start', {}));
  await cleanup();
  assert.ok(out.endsWith('\n'));
});

test('nested objects round-trip through JSON.stringify', async () => {
  const bus = createBus();
  const cleanup = attach(bus);
  const payload = { budget: { max: 100, used: 42 }, tags: ['a', 'b'] };
  const out = captureStdout(() => bus.emit('pipeline.start', payload));
  await cleanup();
  const parsed = JSON.parse(out.trim());
  assert.deepEqual(parsed.budget, payload.budget);
  assert.deepEqual(parsed.tags, payload.tags);
});
