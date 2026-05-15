const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');

const { atomicWriteJson, createIdea, readJsonFile } = require('../src/storage');

test('createIdea returns expected top-level schema keys', () => {
  const idea = createIdea('Test idea');
  assert.ok(idea.id);
  assert.equal(idea.raw_capture, 'Test idea');
  assert.equal(idea.status, 'pending');
  assert.ok(idea.investigation);
  assert.ok(idea.user_reactions);
  assert.ok(Array.isArray(idea.investigation.perspective_discovery));
  assert.ok(Array.isArray(idea.user_reactions.steer_notes));
});

test('atomicWriteJson writes JSON file atomically', async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'msv-storage-test-'));
  const filePath = path.join(tempDir, 'idea.json');

  try {
    const payload = { id: 'abc', status: 'pending' };
    await atomicWriteJson(filePath, payload);
    const parsed = await readJsonFile(filePath);
    assert.deepEqual(parsed, payload);
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});
