const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');

// Isolate the test from the user's real ~/.msv. MUST be set before requiring storage.
const TEST_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'msv-storage-test-'));
process.env.MSV_ROOT = TEST_ROOT;

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  ARCHIVE_DIR,
  IDEAS_DIR,
  ROOT_DIR,
  appendLog,
  archiveIdea,
  archivedIdeaDir,
  atomicWriteJson,
  atomicWriteText,
  createIdea,
  ensureStorageDirs,
  ideaDir,
  ideaIndexPath,
  ideaLogPath,
  listIdeas,
  listIdeasByStatus,
  readIdea,
  readJsonFile,
  readLog,
  writeIdea,
} = require('../src/storage');

test.after(async () => {
  await fsp.rm(TEST_ROOT, { recursive: true, force: true });
});

function randomId() {
  return `test-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

test('ROOT_DIR honours MSV_ROOT', () => {
  assert.equal(ROOT_DIR, TEST_ROOT);
  assert.ok(IDEAS_DIR.startsWith(TEST_ROOT));
});

test('createIdea returns spec-shaped schema', () => {
  const idea = createIdea('Test idea');
  assert.ok(idea.id);
  assert.equal(idea.raw_capture, 'Test idea');
  assert.equal(idea.status, 'pending');
  assert.equal(idea.parent_id, null);
  assert.ok(idea.investigation);
  assert.equal(idea.investigation.completed_at, null);
  assert.equal(idea.investigation.budget.max_executor_calls, 60);
  assert.equal(idea.investigation.budget.max_total_tokens, 500000);
  assert.deepEqual(idea.investigation.perspective_discovery.fixed_personas, [
    'skeptic',
    'builder',
  ]);
  assert.deepEqual(idea.investigation.coordinator_decisions, { initial: null, spawn: null });
  assert.ok(Array.isArray(idea.investigation.pair_debates));
  assert.ok(Array.isArray(idea.investigation.cross_pollination));
  assert.equal(idea.investigation.synthesis, null);
  assert.deepEqual(idea.user_reactions, { steer_notes: [], follow_up_topic: null });
});

test('ensureStorageDirs creates root, ideas, and archive directories', async () => {
  await ensureStorageDirs();
  const rootStat = await fsp.stat(ROOT_DIR);
  const ideasStat = await fsp.stat(IDEAS_DIR);
  const archiveStat = await fsp.stat(ARCHIVE_DIR);

  assert.equal(rootStat.isDirectory(), true);
  assert.equal(ideasStat.isDirectory(), true);
  assert.equal(archiveStat.isDirectory(), true);
});

test('atomicWriteJson writes JSON file atomically', async () => {
  const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'msv-atomic-'));
  const filePath = path.join(tempDir, 'idea.json');

  try {
    const payload = { id: 'abc', status: 'pending' };
    await atomicWriteJson(filePath, payload);
    const parsed = await readJsonFile(filePath);
    assert.deepEqual(parsed, payload);
  } finally {
    await fsp.rm(tempDir, { recursive: true, force: true });
  }
});

test('atomicWriteText writes and renames atomically', async () => {
  const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'msv-text-'));
  const filePath = path.join(tempDir, 'out.html');

  try {
    await atomicWriteText(filePath, '<!doctype html>\n');
    const content = await fsp.readFile(filePath, 'utf8');
    assert.equal(content, '<!doctype html>\n');
  } finally {
    await fsp.rm(tempDir, { recursive: true, force: true });
  }
});

test('atomicWriteText leaves prior content intact when writeFile throws before any bytes hit disk', async () => {
  const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'msv-text-err-'));
  const filePath = path.join(tempDir, 'out.txt');
  await fsp.writeFile(filePath, 'original\n', 'utf8');

  const storageFsp = require('node:fs/promises');
  const originalWriteFile = storageFsp.writeFile;
  let capturedTmpPath;
  // True write failure: throw immediately, without delegating to the real
  // writeFile, so no bytes ever land at tmpPath. The cleanup path in
  // atomicWriteText must still succeed (fs.rm with force ignores ENOENT).
  storageFsp.writeFile = async (tmpPath) => {
    capturedTmpPath = tmpPath;
    throw new Error('simulated write failure');
  };

  try {
    await assert.rejects(
      () => atomicWriteText(filePath, 'replacement\n'),
      /simulated write failure/
    );
    // Prior content intact.
    const after = await fsp.readFile(filePath, 'utf8');
    assert.equal(after, 'original\n');
    // Tmp file was never created.
    if (capturedTmpPath) {
      await assert.rejects(() => fsp.stat(capturedTmpPath), /ENOENT/);
    }
  } finally {
    storageFsp.writeFile = originalWriteFile;
    await fsp.rm(tempDir, { recursive: true, force: true });
  }
});

test('atomicWriteText cleans up tmp file when rename fails after partial write', async () => {
  const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'msv-text-rename-err-'));
  const filePath = path.join(tempDir, 'out.txt');
  await fsp.writeFile(filePath, 'original\n', 'utf8');

  const storageFsp = require('node:fs/promises');
  const originalRename = storageFsp.rename;
  let capturedTmpPath;
  storageFsp.rename = async (from) => {
    capturedTmpPath = from;
    throw new Error('simulated rename failure');
  };

  try {
    await assert.rejects(
      () => atomicWriteText(filePath, 'replacement\n'),
      /simulated rename failure/
    );
    const after = await fsp.readFile(filePath, 'utf8');
    assert.equal(after, 'original\n');
    if (capturedTmpPath) {
      await assert.rejects(() => fsp.stat(capturedTmpPath), /ENOENT/);
    }
  } finally {
    storageFsp.rename = originalRename;
    await fsp.rm(tempDir, { recursive: true, force: true });
  }
});

test('ideaDir rejects path-traversal ids', () => {
  assert.throws(() => ideaDir('../escape'), /Invalid path outside/);
  assert.throws(() => ideaDir('../../etc/passwd'), /Invalid path outside/);
});

test('writeIdea/readIdea/listIdeas/archiveIdea integration', async () => {
  const id = randomId();
  const idea = createIdea('Storage integration test');
  idea.id = id;

  try {
    await writeIdea(idea);

    const loaded = await readIdea(id);
    assert.equal(loaded.id, id);
    assert.equal(loaded.status, 'pending');
    assert.equal(loaded.parent_id, null);

    const indexStat = await fsp.stat(ideaIndexPath(id));
    assert.equal(indexStat.isFile(), true);
    const dirStat = await fsp.stat(ideaDir(id));
    assert.equal(dirStat.isDirectory(), true);

    const allIdeas = await listIdeas();
    assert.ok(allIdeas.some((entry) => entry.id === id));

    const pendingIdeas = await listIdeasByStatus('pending');
    assert.ok(pendingIdeas.some((entry) => entry.id === id));

    loaded.status = 'archived';
    await writeIdea(loaded);
    await archiveIdea(id);

    await assert.rejects(() => readIdea(id));
    const archivedIndex = path.join(archivedIdeaDir(id), 'index.json');
    const archived = await readJsonFile(archivedIndex);
    assert.equal(archived.id, id);
    assert.equal(archived.status, 'archived');
  } finally {
    await fsp.rm(ideaDir(id), { recursive: true, force: true });
    await fsp.rm(archivedIdeaDir(id), { recursive: true, force: true });
  }
});

test('appendLog/readLog round-trip writes JSONL records with timestamps', async () => {
  const id = randomId();
  const idea = createIdea('Log integration test');
  idea.id = id;

  try {
    await writeIdea(idea);
    await appendLog(id, 'discovery', { kind: 'request', payload: { q: 'first' } });
    await appendLog(id, 'discovery', { kind: 'response', payload: { ok: true } });

    const records = await readLog(id, 'discovery');
    assert.equal(records.length, 2);
    assert.equal(records[0].kind, 'request');
    assert.equal(records[0].payload.q, 'first');
    assert.equal(records[1].kind, 'response');
    assert.ok(records[0].ts);
    assert.ok(records[1].ts);

    const logStat = await fsp.stat(ideaLogPath(id, 'discovery'));
    assert.equal(logStat.isFile(), true);
  } finally {
    await fsp.rm(ideaDir(id), { recursive: true, force: true });
  }
});
