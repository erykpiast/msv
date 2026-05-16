'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { createBus } = require('../src/bus');
const { attachRecorder } = require('../src/event_recorder');

async function makeTmpDir() {
  return fs.mkdtemp(path.join(os.tmpdir(), 'msv-test-'));
}

test('each emitted event yields one JSON line in events.jsonl', async () => {
  const tmpDir = await makeTmpDir();
  const filePath = path.join(tmpDir, 'events.jsonl');

  try {
    const bus = createBus();
    bus.setIdea('test-idea');
    const cleanup = attachRecorder(bus, { idea: { id: 'test-idea' }, filePath });

    bus.emit('pipeline.start', { raw_capture: 'hello' });
    bus.emit('wg.start', { territory_id: 't_001' });
    bus.emit('pipeline.complete', { ok: true });

    await cleanup();

    const content = await fs.readFile(filePath, 'utf8');
    const lines = content.trim().split('\n').filter(Boolean);
    assert.equal(lines.length, 3);
    for (const line of lines) {
      const parsed = JSON.parse(line);
      assert.ok(parsed.name);
      assert.ok(typeof parsed.ts === 'number');
    }
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

test('envelope fields round-trip through the file', async () => {
  const tmpDir = await makeTmpDir();
  const filePath = path.join(tmpDir, 'events.jsonl');

  try {
    const bus = createBus();
    bus.setIdea('test-idea');
    const cleanup = attachRecorder(bus, { idea: { id: 'test-idea' }, filePath });

    bus.emit('pipeline.start', { raw_capture: 'topic', budget: { max: 100 } });
    await cleanup();

    const content = await fs.readFile(filePath, 'utf8');
    const parsed = JSON.parse(content.trim());
    assert.equal(parsed.name, 'pipeline.start');
    assert.equal(parsed.raw_capture, 'topic');
    assert.deepEqual(parsed.budget, { max: 100 });
    assert.equal(parsed.idea_id, 'test-idea');
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

test('MSV_NO_RECORD=1 skips file creation', async () => {
  const tmpDir = await makeTmpDir();
  const filePath = path.join(tmpDir, 'events.jsonl');

  const originalNoRecord = process.env.MSV_NO_RECORD;
  process.env.MSV_NO_RECORD = '1';

  try {
    const bus = createBus();
    bus.setIdea('test-idea');
    const cleanup = attachRecorder(bus, { idea: { id: 'test-idea' }, filePath });
    bus.emit('pipeline.start', {});
    await cleanup();

    await assert.rejects(fs.readFile(filePath, 'utf8'));
  } finally {
    if (originalNoRecord === undefined) {
      delete process.env.MSV_NO_RECORD;
    } else {
      process.env.MSV_NO_RECORD = originalNoRecord;
    }
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

test('append-only across two cleanup cycles', async () => {
  const tmpDir = await makeTmpDir();
  const filePath = path.join(tmpDir, 'events.jsonl');

  try {
    const bus1 = createBus();
    bus1.setIdea('test-idea');
    const cleanup1 = attachRecorder(bus1, { idea: { id: 'test-idea' }, filePath });
    bus1.emit('pipeline.start', {});
    bus1.emit('wg.start', {});
    bus1.emit('wg.end', {});
    await cleanup1();

    const bus2 = createBus();
    bus2.setIdea('test-idea');
    const cleanup2 = attachRecorder(bus2, { idea: { id: 'test-idea' }, filePath });
    bus2.emit('pipeline.complete', {});
    bus2.emit('synthesizer.done', {});
    await cleanup2();

    const content = await fs.readFile(filePath, 'utf8');
    const lines = content.trim().split('\n').filter(Boolean);
    assert.equal(lines.length, 5);
    assert.equal(JSON.parse(lines[0]).name, 'pipeline.start');
    assert.equal(JSON.parse(lines[4]).name, 'synthesizer.done');
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});
