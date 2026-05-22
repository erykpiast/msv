'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { seedBrokerFromDisk } = require('../seed');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function makeTmpDir() {
  return fs.mkdtemp(path.join(os.tmpdir(), 'msv-seed-test-'));
}

function makeBroker(targetIdeaId) {
  const published = [];
  return {
    published,
    publishEvent(env) {
      if (env.idea_id !== targetIdeaId) return false;
      published.push(env);
      return true;
    },
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test('seeds only events with matching idea_id and returns the count', async () => {
  const dir = await makeTmpDir();
  try {
    const ideaId = 'idea-match';
    const lines = [
      JSON.stringify({ idea_id: 'idea-match', name: 'pipeline.start', ts: 1 }),
      JSON.stringify({ idea_id: 'idea-other', name: 'pipeline.start', ts: 2 }),
      JSON.stringify({ idea_id: 'idea-match', name: 'wg.start', ts: 3 }),
      JSON.stringify({ idea_id: 'idea-other', name: 'wg.start', ts: 4 }),
      JSON.stringify({ idea_id: 'idea-match', name: 'wg.end', ts: 5 }),
    ];
    await fs.writeFile(path.join(dir, 'events.jsonl'), lines.join('\n') + '\n', 'utf8');

    const broker = makeBroker(ideaId);
    const count = await seedBrokerFromDisk({ ideaDir: dir, broker, ideaId });

    assert.equal(count, 3, 'only 3 matching idea-match events');
    assert.equal(broker.published.length, 3);
    assert.equal(broker.published[0].name, 'pipeline.start');
    assert.equal(broker.published[1].name, 'wg.start');
    assert.equal(broker.published[2].name, 'wg.end');
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('returns 0 when events.jsonl is missing (no throw)', async () => {
  const dir = await makeTmpDir();
  try {
    const broker = makeBroker('idea-x');
    const count = await seedBrokerFromDisk({ ideaDir: dir, broker, ideaId: 'idea-x' });
    assert.equal(count, 0);
    assert.equal(broker.published.length, 0);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('tolerates a malformed last line and still loads prior valid events', async () => {
  const dir = await makeTmpDir();
  try {
    const ideaId = 'idea-partial';
    const goodLine1 = JSON.stringify({ idea_id: ideaId, name: 'pipeline.start', ts: 1 });
    const goodLine2 = JSON.stringify({ idea_id: ideaId, name: 'wg.start', ts: 2 });
    const partialLine = '{"idea_id":"idea-partial","name":"wg'; // truncated JSON

    const content = [goodLine1, goodLine2, partialLine].join('\n');
    await fs.writeFile(path.join(dir, 'events.jsonl'), content, 'utf8');

    const broker = makeBroker(ideaId);
    // Should not throw
    const count = await seedBrokerFromDisk({ ideaDir: dir, broker, ideaId });

    assert.equal(count, 2, 'only 2 valid events parsed; partial line tolerated');
    assert.equal(broker.published[0].name, 'pipeline.start');
    assert.equal(broker.published[1].name, 'wg.start');
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('publishes envelopes with valid shape (name, idea_id, ts)', async () => {
  const dir = await makeTmpDir();
  try {
    const ideaId = 'idea-valid';
    const lines = [
      JSON.stringify({ idea_id: ideaId, name: 'pipeline.start', ts: 100, payload: { a: 1 } }),
      JSON.stringify({ idea_id: ideaId, name: 'wg.start', ts: 101 }),
    ];
    await fs.writeFile(path.join(dir, 'events.jsonl'), lines.join('\n') + '\n', 'utf8');

    const broker = makeBroker(ideaId);
    const count = await seedBrokerFromDisk({ ideaDir: dir, broker, ideaId });

    assert.equal(count, 2);
    assert.equal(broker.published[0].name, 'pipeline.start');
    assert.deepEqual(broker.published[0].payload, { a: 1 });
    assert.equal(broker.published[1].ts, 101);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('silently skips envelopes missing required fields (name / idea_id / ts)', async () => {
  const dir = await makeTmpDir();
  try {
    const ideaId = 'idea-shape';
    const lines = [
      // valid
      JSON.stringify({ idea_id: ideaId, name: 'good', ts: 1 }),
      // missing name
      JSON.stringify({ idea_id: ideaId, ts: 2 }),
      // missing idea_id
      JSON.stringify({ name: 'noid', ts: 3 }),
      // missing ts
      JSON.stringify({ idea_id: ideaId, name: 'no-ts' }),
      // wrong type: name is number
      JSON.stringify({ idea_id: ideaId, name: 42, ts: 4 }),
      // wrong type: ts is string
      JSON.stringify({ idea_id: ideaId, name: 'ts-string', ts: 'nope' }),
      // null
      'null',
      // non-object
      '42',
      // another valid
      JSON.stringify({ idea_id: ideaId, name: 'good2', ts: 5 }),
    ];
    await fs.writeFile(path.join(dir, 'events.jsonl'), lines.join('\n') + '\n', 'utf8');

    const broker = makeBroker(ideaId);
    const count = await seedBrokerFromDisk({ ideaDir: dir, broker, ideaId });

    assert.equal(count, 2, 'only the two structurally valid matching envelopes pass');
    assert.equal(broker.published[0].name, 'good');
    assert.equal(broker.published[1].name, 'good2');
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('rejects tampered events that pretend to be from another idea', async () => {
  // Defense-in-depth: even if a tampered file injects a malformed entry,
  // structural validation rejects it before publishEvent runs.
  const dir = await makeTmpDir();
  try {
    const ideaId = 'idea-real';
    const lines = [
      JSON.stringify({ idea_id: ideaId, name: 'pipeline.start', ts: 1 }),
      // Tampered: no ts, attacker-controlled payload
      JSON.stringify({ idea_id: ideaId, name: 'evil', payload: { exec: 'rm -rf /' } }),
    ];
    await fs.writeFile(path.join(dir, 'events.jsonl'), lines.join('\n') + '\n', 'utf8');

    const broker = makeBroker(ideaId);
    const count = await seedBrokerFromDisk({ ideaDir: dir, broker, ideaId });

    assert.equal(count, 1);
    assert.equal(broker.published.length, 1);
    assert.equal(broker.published[0].name, 'pipeline.start');
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('streams large file without throwing and counts all valid events', async () => {
  const dir = await makeTmpDir();
  try {
    const ideaId = 'idea-large';
    const total = 5000;
    const lines = [];
    for (let i = 0; i < total; i++) {
      lines.push(JSON.stringify({ idea_id: ideaId, name: 'tick', ts: i, seq: i }));
    }
    await fs.writeFile(path.join(dir, 'events.jsonl'), lines.join('\n') + '\n', 'utf8');

    const broker = makeBroker(ideaId);
    const count = await seedBrokerFromDisk({ ideaDir: dir, broker, ideaId });

    assert.equal(count, total);
    assert.equal(broker.published.length, total);
    assert.equal(broker.published[0].seq, 0);
    assert.equal(broker.published[total - 1].seq, total - 1);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});
