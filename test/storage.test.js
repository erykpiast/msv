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
  ideaWriteMutex,
  _ideaMutexSize,
  listIdeas,
  listIdeasByStatus,
  normalizeLoadedIdea,
  readIdea,
  readJsonFile,
  readLog,
  safeSlug,
  stripControlChars,
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
  assert.equal(idea.investigation.budget.max_executor_calls, 240);
  assert.equal(idea.investigation.budget.max_total_tokens, 8_000_000);
  assert.equal(idea.investigation.budget.max_researcher_tool_calls, 200);
  assert.equal(idea.investigation.schema_version, 'v5');
  assert.deepEqual(idea.investigation.perspective_discovery.fixed_personas, [
    'skeptic',
    'builder',
  ]);
  assert.deepEqual(idea.investigation.coordinator_decisions, { initial: null });
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

// --- normalizeLoadedIdea ---

test('normalizeLoadedIdea tags legacy idea without schema_version as v4', () => {
  const legacy = { investigation: { pair_debates: [{ sub_question_id: 'sq_001' }] } };
  normalizeLoadedIdea(legacy);
  assert.equal(legacy.investigation.schema_version, 'v4');
});

test('normalizeLoadedIdea tags an idea with territory_id pair_debates as v5', () => {
  // Structural heuristic: a missing schema_version with v5-shape data should still
  // resolve to v5 so the inspector doesn't silently render an empty view.
  const partial = { investigation: { pair_debates: [{ territory_id: 't_001' }] } };
  normalizeLoadedIdea(partial);
  assert.equal(partial.investigation.schema_version, 'v5');
});

test('normalizeLoadedIdea tags an idea with coordinator territories as v5', () => {
  const partial = {
    investigation: {
      pair_debates: [],
      coordinator_decisions: { initial: { territories: [{ id: 't_001' }] } },
    },
  };
  normalizeLoadedIdea(partial);
  assert.equal(partial.investigation.schema_version, 'v5');
});

test('normalizeLoadedIdea leaves an existing schema_version untouched', () => {
  const v5 = { investigation: { schema_version: 'v5', pair_debates: [] } };
  normalizeLoadedIdea(v5);
  assert.equal(v5.investigation.schema_version, 'v5');
});

test('normalizeLoadedIdea handles null/empty input gracefully', () => {
  assert.equal(normalizeLoadedIdea(null), null);
  assert.deepEqual(normalizeLoadedIdea({}), {});
  assert.deepEqual(normalizeLoadedIdea({ investigation: null }), { investigation: null });
});

// --- safeSlug ---

test('safeSlug preserves alphanumerics, underscore, hyphen', () => {
  assert.equal(safeSlug('pair-t_001-debate'), 'pair-t_001-debate');
  assert.equal(safeSlug('t_001'), 't_001');
});

test('safeSlug strips path separators and dots', () => {
  assert.equal(safeSlug('../etc/passwd'), '___etc_passwd');
  assert.equal(safeSlug('a/b/c'), 'a_b_c');
  assert.equal(safeSlug('a.b'), 'a_b');
});

test('safeSlug truncates and never returns empty', () => {
  const long = 'a'.repeat(200);
  assert.equal(safeSlug(long).length, 96);
  assert.equal(safeSlug(''), '_');
  assert.equal(safeSlug(null), '_');
});

// --- stripControlChars ---

test('stripControlChars removes ANSI escape sequences from strings', () => {
  const dirty = 'before\x1b[31mred\x1b[0m after';
  assert.equal(stripControlChars(dirty), 'before[31mred[0m after');
});

test('stripControlChars walks arrays and objects recursively', () => {
  const dirty = { a: '\x07bell', b: ['x\x00null', 'clean'] };
  assert.deepEqual(stripControlChars(dirty), { a: 'bell', b: ['xnull', 'clean'] });
});

test('stripControlChars preserves printable text including unicode and newlines', () => {
  const clean = 'line one\nline two — em-dash 🎯';
  assert.equal(stripControlChars(clean), clean);
});

// --- ideaWriteMutex ---

test('two concurrent read-modify-writes inside the mutex preserve both mutations', async () => {
  // Without the mutex, two concurrent callbacks can both observe findIndex === -1
  // and both push, duplicating entries. This test simulates that race directly.
  const id = randomId();
  const idea = createIdea('test mutex');
  idea.id = id;
  idea.investigation.progress = { current_stage: '4_working_groups', working_groups: {} };

  try {
    await writeIdea(idea);

    const op1 = ideaWriteMutex(idea.id, async () => {
      const cur = await readIdea(idea.id);
      cur.investigation.progress.working_groups.t1 = 'complete';
      await writeIdea(cur);
    });
    const op2 = ideaWriteMutex(idea.id, async () => {
      const cur = await readIdea(idea.id);
      cur.investigation.progress.working_groups.t2 = 'complete';
      await writeIdea(cur);
    });
    await Promise.all([op1, op2]);

    const final = await readIdea(idea.id);
    assert.deepEqual(final.investigation.progress.working_groups, {
      t1: 'complete',
      t2: 'complete',
    });
  } finally {
    await fsp.rm(ideaDir(id), { recursive: true, force: true });
  }
});

test('ideaWriteMutex propagates errors without leaking the lock', async () => {
  const id = randomId();
  const idea = createIdea('mutex error test');
  idea.id = id;

  try {
    await writeIdea(idea);

    const failOp = ideaWriteMutex(idea.id, async () => {
      throw new Error('simulated failure');
    });
    await assert.rejects(failOp, /simulated failure/);

    // Next operation must not hang (lock must have been released).
    let resolved = false;
    await Promise.race([
      ideaWriteMutex(idea.id, async () => { resolved = true; }),
      new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 2000)),
    ]);
    assert.ok(resolved, 'lock was not released after error');
  } finally {
    await fsp.rm(ideaDir(id), { recursive: true, force: true });
  }
});

test('ideaWriteMutex cleans up its map entry after a single op completes', async () => {
  // Sanity: map starts empty.
  assert.equal(_ideaMutexSize(), 0, 'map should be empty at start');
  await ideaWriteMutex('mutex-cleanup-single', async () => {});
  assert.equal(_ideaMutexSize(), 0, 'map should be empty after one op');
});

test('ideaWriteMutex cleans up after concurrent ops on the same id', async () => {
  // Regression test for the original bug where the cleanup predicate
  // (_ideaMutexes.get(id) === next) compared `next` against `prev.then(()=>next)`
  // and never matched, causing the map to grow by one entry per processed idea.
  const before = _ideaMutexSize();
  const tasks = [];
  for (let i = 0; i < 5; i++) {
    tasks.push(
      ideaWriteMutex('mutex-cleanup-concurrent', async () => {
        await new Promise((r) => setTimeout(r, 5));
      })
    );
  }
  await Promise.all(tasks);
  assert.equal(_ideaMutexSize(), before, 'map should return to original size after all ops complete');
});

test('ideaWriteMutex serialises ops on the same id (operations run sequentially)', async () => {
  // Without the mutex, operations would interleave; with it, op N+1 must wait for op N.
  const order = [];
  const op = (label) =>
    ideaWriteMutex('mutex-serialise-test', async () => {
      order.push(`${label}-start`);
      await new Promise((r) => setTimeout(r, 10));
      order.push(`${label}-end`);
    });
  await Promise.all([op('a'), op('b'), op('c')]);
  assert.deepEqual(order, [
    'a-start', 'a-end',
    'b-start', 'b-end',
    'c-start', 'c-end',
  ], 'each op must complete before the next starts');
  assert.equal(_ideaMutexSize(), 0, 'no entries left behind');
});

// --- normalizeLoadedIdea: resumption fields ---

test('normalizeLoadedIdea adds progress and last_failure null to ideas that lack them', () => {
  const idea = { investigation: { schema_version: 'v5', pair_debates: [] } };
  normalizeLoadedIdea(idea);
  assert.ok('progress' in idea.investigation);
  assert.equal(idea.investigation.progress, null);
  assert.ok('last_failure' in idea.investigation);
  assert.equal(idea.investigation.last_failure, null);
});

test('normalizeLoadedIdea does not overwrite existing progress or last_failure', () => {
  const progress = { current_stage: '4_working_groups', working_groups: { t1: 'complete' } };
  const last_failure = { reason: 'user_cancelled' };
  const idea = { investigation: { schema_version: 'v5', pair_debates: [], progress, last_failure } };
  normalizeLoadedIdea(idea);
  assert.deepEqual(idea.investigation.progress, progress);
  assert.deepEqual(idea.investigation.last_failure, last_failure);
});
