// Test: orchestration helpers in src/commands/run.js. Covers the pure helpers
// (parseRunSelection, inferInFlightWorkingGroup), the filesystem mutator
// (performRestart), and the runOne error-classification path that persists
// last_failure. These were the gaps flagged by the code review.

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');

const TEST_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'msv-run-test-'));
process.env.MSV_ROOT = TEST_ROOT;

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  parseRunSelection,
  inferInFlightWorkingGroup,
  performRestart,
  runOne,
} = require('../src/commands/run');
const {
  createIdea,
  writeIdea,
  readIdea,
  ideaDir,
  ideaLogPath,
  appendLog,
} = require('../src/storage');

test.after(async () => {
  await fsp.rm(TEST_ROOT, { recursive: true, force: true });
});

function randomId() {
  return `test-run-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

// ---------------------------------------------------------------------------
// parseRunSelection
// ---------------------------------------------------------------------------

test('parseRunSelection: no args → usage', () => {
  assert.deepEqual(parseRunSelection([]), { mode: 'usage' });
});

test('parseRunSelection: --all → all mode', () => {
  assert.deepEqual(parseRunSelection(['--all']), { mode: 'all' });
});

test('parseRunSelection: single id → single mode without restart flag', () => {
  const result = parseRunSelection(['abc-123']);
  assert.equal(result.mode, 'single');
  assert.equal(result.id, 'abc-123');
  assert.equal(result.restartFlag, false);
});

test('parseRunSelection: id + --restart → single mode with restart flag', () => {
  const result = parseRunSelection(['abc-123', '--restart']);
  assert.equal(result.mode, 'single');
  assert.equal(result.id, 'abc-123');
  assert.equal(result.restartFlag, true);
});

test('parseRunSelection: --restart before id also works (order-independent)', () => {
  const result = parseRunSelection(['--restart', 'abc-123']);
  assert.equal(result.mode, 'single');
  assert.equal(result.id, 'abc-123');
  assert.equal(result.restartFlag, true);
});

test('parseRunSelection: --all + --restart → error (incompatible)', () => {
  const result = parseRunSelection(['--all', '--restart']);
  assert.equal(result.mode, 'error');
  assert.match(result.reason, /not allowed with --all/);
});

// ---------------------------------------------------------------------------
// inferInFlightWorkingGroup
// ---------------------------------------------------------------------------

test('inferInFlightWorkingGroup: null inv → null tid and subStage', () => {
  assert.deepEqual(inferInFlightWorkingGroup(null), { tid: null, subStage: null });
  assert.deepEqual(inferInFlightWorkingGroup(undefined), { tid: null, subStage: null });
});

test('inferInFlightWorkingGroup: current_stage not stage 4 → null', () => {
  const inv = { progress: { current_stage: '3_coordinator', working_groups: {} } };
  assert.deepEqual(inferInFlightWorkingGroup(inv), { tid: null, subStage: null });
});

test('inferInFlightWorkingGroup: stage 4 with all complete → null', () => {
  const inv = {
    progress: {
      current_stage: '4_working_groups',
      working_groups: { t1: 'complete', t2: 'complete' },
    },
  };
  assert.deepEqual(inferInFlightWorkingGroup(inv), { tid: null, subStage: null });
});

test('inferInFlightWorkingGroup: stage 4 with all pending → null (no in-flight)', () => {
  // All-pending means the crash happened before any checkpoint — no anchor.
  const inv = {
    progress: {
      current_stage: '4_working_groups',
      working_groups: { t1: 'pending', t2: 'pending' },
    },
  };
  assert.deepEqual(inferInFlightWorkingGroup(inv), { tid: null, subStage: null });
});

test('inferInFlightWorkingGroup: stage 4 with one partial → that tid and next sub-stage', () => {
  const inv = {
    progress: {
      current_stage: '4_working_groups',
      working_groups: {
        t1: 'complete',
        t2: 'researcher_complete',
        t3: 'pending',
      },
    },
  };
  const result = inferInFlightWorkingGroup(inv);
  assert.equal(result.tid, 't2');
  assert.equal(result.subStage, 'observation'); // next after researcher_complete
});

test('inferInFlightWorkingGroup: debate_complete → null subStage (no next)', () => {
  const inv = {
    progress: {
      current_stage: '4_working_groups',
      working_groups: { t1: 'debate_complete' },
    },
  };
  const result = inferInFlightWorkingGroup(inv);
  assert.equal(result.tid, 't1');
  assert.equal(result.subStage, null);
});

// ---------------------------------------------------------------------------
// performRestart
// ---------------------------------------------------------------------------

test('performRestart archives logs and snapshot, then resets investigation', async () => {
  const id = randomId();
  const idea = createIdea('test restart');
  idea.id = id;
  await writeIdea(idea);
  await appendLog(id, 'discovery', { kind: 'request', payload: { q: 'first' } });

  // Mutate to a non-fresh state so we can detect the reset.
  idea.status = 'investigating';
  idea.investigation.progress = {
    current_stage: '4_working_groups',
    working_groups: { t1: 'complete' },
  };
  idea.investigation.last_failure = {
    reason: 'anthropic_unavailable',
    stage: '4_working_groups',
    territory_id: 't1',
    sub_stage: 'researcher',
    error_message: 'simulated',
    occurred_at: new Date().toISOString(),
  };
  await writeIdea(idea);

  await performRestart(idea);

  // 1. In-memory idea reset to a fresh shell.
  assert.equal(idea.status, 'pending');
  assert.equal(idea.investigation.progress, null);
  assert.equal(idea.investigation.last_failure, null);
  assert.deepEqual(idea.investigation.pair_debates, []);

  // 2. Disk reflects the reset.
  const reloaded = await readIdea(id);
  assert.equal(reloaded.status, 'pending');
  assert.equal(reloaded.investigation.progress, null);

  // 3. .attempts/<timestamp>/ directory has logs + snapshot.
  const attemptsRoot = path.join(ideaDir(id), '.attempts');
  const attemptDirs = await fsp.readdir(attemptsRoot);
  assert.equal(attemptDirs.length, 1, 'one attempt directory created');

  const archivedLogs = path.join(attemptsRoot, attemptDirs[0], 'logs');
  const logsStat = await fsp.stat(archivedLogs);
  assert.equal(logsStat.isDirectory(), true);

  const snapshotPath = path.join(attemptsRoot, attemptDirs[0], 'index.json.before-restart');
  const snapshotStat = await fsp.stat(snapshotPath);
  assert.equal(snapshotStat.isFile(), true);

  // 4. Snapshot contains the pre-restart state (with investigating status).
  const snapshotContent = JSON.parse(await fsp.readFile(snapshotPath, 'utf8'));
  assert.equal(snapshotContent.status, 'investigating');
  assert.equal(snapshotContent.investigation.last_failure.reason, 'anthropic_unavailable');
});

test('performRestart handles a missing logs/ directory gracefully', async () => {
  const id = randomId();
  const idea = createIdea('test restart no logs');
  idea.id = id;
  await writeIdea(idea);
  // Pre-emptively remove the logs directory.
  await fsp.rm(path.join(ideaDir(id), 'logs'), { recursive: true, force: true });

  // Should not throw.
  await performRestart(idea);

  assert.equal(idea.status, 'pending');
  // .attempts dir was still created (with just the snapshot).
  const attemptDirs = await fsp.readdir(path.join(ideaDir(id), '.attempts'));
  assert.equal(attemptDirs.length, 1);
});

test('performRestart timestamp is path-safe (no colons or dots)', async () => {
  const id = randomId();
  const idea = createIdea('test restart timestamp');
  idea.id = id;
  await writeIdea(idea);
  await performRestart(idea);

  const attemptDirs = await fsp.readdir(path.join(ideaDir(id), '.attempts'));
  // Timestamp comes from Date().toISOString() with `:` and `.` replaced by `-`.
  // Should contain only digits, hyphens, T, and Z.
  assert.match(attemptDirs[0], /^[0-9TZ-]+$/);
});

// ---------------------------------------------------------------------------
// runOne error classification & last_failure persistence
// ---------------------------------------------------------------------------

test('runOne: classifies a TypeError as internal_error and persists last_failure', async () => {
  const id = randomId();
  const idea = createIdea('test runOne internal');
  idea.id = id;
  await writeIdea(idea);

  // TypeError bypasses api_queue's retry path (only 5xx/429/network codes retry),
  // so the pipeline aborts on the first API attempt without burning 90s of backoff.
  const badClient = {
    get messages() {
      throw new TypeError('not a real client');
    },
  };

  const result = await runOne(idea, badClient, { cancellationToken: { requested: false } });

  assert.equal(result.ok, false);

  const reloaded = await readIdea(id);
  assert.ok(reloaded.investigation.last_failure, 'last_failure must be persisted');
  assert.equal(reloaded.investigation.last_failure.reason, 'internal_error');
  assert.equal(reloaded.investigation.last_failure.stage, '1_discovery');
  assert.ok(reloaded.investigation.last_failure.occurred_at);
  // sanitised, populated
  assert.ok(reloaded.investigation.last_failure.error_message.length > 0);
});

test('runOne: overwrites a pre-existing last_failure on subsequent failure', async () => {
  // The pipeline doesn't actively clear last_failure on entry — it's only cleared
  // when stage 7 completes successfully. If a prior failure existed and the new
  // run fails too, the new last_failure must overwrite the old one.
  const id = randomId();
  const idea = createIdea('test runOne overwrite');
  idea.id = id;
  idea.investigation.last_failure = {
    reason: 'user_cancelled',
    stage: '4_working_groups',
    territory_id: 'old-territory',
    sub_stage: 'ideation',
    error_message: 'old',
    occurred_at: '2020-01-01T00:00:00.000Z',
  };
  await writeIdea(idea);

  const badClient = {
    get messages() {
      throw new TypeError('new failure');
    },
  };

  await runOne(idea, badClient, { cancellationToken: { requested: false } });

  const reloaded = await readIdea(id);
  assert.equal(reloaded.investigation.last_failure.reason, 'internal_error');
  assert.equal(reloaded.investigation.last_failure.error_message, 'new failure');
  assert.notEqual(reloaded.investigation.last_failure.occurred_at, '2020-01-01T00:00:00.000Z');
});

test('runOne: handles a missing investigation defensively', async () => {
  // Defensive path: if idea.investigation is null when the pipeline throws, runOne
  // must not crash in the catch handler — it builds a fresh shell and persists.
  const id = randomId();
  const idea = createIdea('test runOne null inv');
  idea.id = id;
  await writeIdea(idea);
  // Corrupt in-memory after write so readIdea on success path would see fresh.
  idea.investigation = null;

  const badClient = { get messages() { throw new TypeError('boom'); } };

  // Should not crash.
  const result = await runOne(idea, badClient, { cancellationToken: { requested: false } });
  assert.equal(result.ok, false);
  // The recovery shell was created and persisted with last_failure.
  assert.ok(idea.investigation);
  assert.ok(idea.investigation.last_failure);
  assert.equal(idea.investigation.last_failure.reason, 'internal_error');
});
