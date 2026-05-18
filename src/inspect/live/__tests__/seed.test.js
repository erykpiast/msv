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
      JSON.stringify({ idea_id: 'idea-match', name: 'pipeline.start' }),
      JSON.stringify({ idea_id: 'idea-other', name: 'pipeline.start' }),
      JSON.stringify({ idea_id: 'idea-match', name: 'wg.start' }),
      JSON.stringify({ idea_id: 'idea-other', name: 'wg.start' }),
      JSON.stringify({ idea_id: 'idea-match', name: 'wg.end' }),
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
    const goodLine1 = JSON.stringify({ idea_id: ideaId, name: 'pipeline.start' });
    const goodLine2 = JSON.stringify({ idea_id: ideaId, name: 'wg.start' });
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
