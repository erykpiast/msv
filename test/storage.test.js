const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');

const {
  ARCHIVE_DIR,
  IDEAS_DIR,
  ROOT_DIR,
  appendEvent,
  archiveIdea,
  atomicWriteJson,
  createIdea,
  ensureStorageDirs,
  listIdeas,
  listIdeasByStatus,
  readIdea,
  readJsonFile,
  writeIdea,
} = require('../src/storage');

function randomId() {
  return `test-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

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

test('ensureStorageDirs creates root, ideas, and archive directories', async () => {
  await ensureStorageDirs();
  const rootStat = await fs.stat(ROOT_DIR);
  const ideasStat = await fs.stat(IDEAS_DIR);
  const archiveStat = await fs.stat(ARCHIVE_DIR);

  assert.equal(rootStat.isDirectory(), true);
  assert.equal(ideasStat.isDirectory(), true);
  assert.equal(archiveStat.isDirectory(), true);
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

test('writeIdea/readIdea/listIdeas/listIdeasByStatus/archiveIdea/appendEvent integration', async () => {
  const id = randomId();
  const idea = createIdea('Storage integration test');
  idea.id = id;

  try {
    appendEvent(idea, 'test-stage', { state: 'started' });
    await writeIdea(idea);

    const loaded = await readIdea(id);
    assert.equal(loaded.id, id);
    assert.equal(loaded.status, 'pending');
    assert.ok(Array.isArray(loaded.investigation.events));
    assert.ok(loaded.investigation.events.length >= 1);

    const allIdeas = await listIdeas();
    assert.ok(allIdeas.some((entry) => entry.id === id));

    const pendingIdeas = await listIdeasByStatus('pending');
    assert.ok(pendingIdeas.some((entry) => entry.id === id));

    loaded.status = 'archived';
    await writeIdea(loaded);
    await archiveIdea(id);

    await assert.rejects(() => readIdea(id));
    const archivedPath = path.join(ARCHIVE_DIR, `${id}.json`);
    const archived = await readJsonFile(archivedPath);
    assert.equal(archived.id, id);
    assert.equal(archived.status, 'archived');
  } finally {
    await fs.rm(path.join(IDEAS_DIR, `${id}.json`), { force: true });
    await fs.rm(path.join(ARCHIVE_DIR, `${id}.json`), { force: true });
  }
});
