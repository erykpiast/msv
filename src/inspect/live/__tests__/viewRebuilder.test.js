'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { mock } = require('node:test');
const { createViewRebuilder } = require('../viewRebuilder');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeMocks() {
  const fakeView = { id: 'test-idea', status: 'done' };
  const fakeInput = { index: {}, logs: {}, enrichments: {} };

  let loadCallCount = 0;
  let viewCallCount = 0;
  const writeCallArgs = [];
  const brokerPublishViewCalls = [];

  const _buildLoaderInput = async () => {
    loadCallCount++;
    return fakeInput;
  };

  const _buildView = () => {
    viewCallCount++;
    return fakeView;
  };

  const _atomicWriteText = async (filePath, text) => {
    writeCallArgs.push({ filePath, text });
  };

  const broker = {
    publishViewCalls: brokerPublishViewCalls,
    publishView(view) {
      brokerPublishViewCalls.push(view);
    },
  };

  return {
    fakeView,
    loadCallCount: () => loadCallCount,
    viewCallCount: () => viewCallCount,
    writeCallArgs,
    brokerPublishViewCalls,
    _buildLoaderInput,
    _buildView,
    _atomicWriteText,
    broker,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test('debounces multiple calls into a single rebuild', async () => {
  mock.timers.enable({ apis: ['setTimeout'] });
  try {
    const m = makeMocks();
    const rebuilder = createViewRebuilder({
      ideaDir: '/fake/idea',
      broker: m.broker,
      _buildLoaderInput: m._buildLoaderInput,
      _buildView: m._buildView,
      _atomicWriteText: m._atomicWriteText,
    });

    // Trigger 5 rapid requestRebuild calls
    for (let i = 0; i < 5; i++) {
      rebuilder.requestRebuild();
    }

    // Advance past the 250ms debounce window (synchronous)
    mock.timers.tick(300);

    // Drain microtasks so the async doLoad / rebuild chain completes
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    assert.equal(m.viewCallCount(), 1, 'exactly one rebuild despite 5 calls');
    assert.equal(m.loadCallCount(), 1, 'exactly one load call');
  } finally {
    mock.timers.reset();
  }
});

test('flushNow bypasses debounce and triggers exactly one rebuild', async () => {
  mock.timers.enable({ apis: ['setTimeout'] });
  try {
    const m = makeMocks();
    const rebuilder = createViewRebuilder({
      ideaDir: '/fake/idea',
      broker: m.broker,
      _buildLoaderInput: m._buildLoaderInput,
      _buildView: m._buildView,
      _atomicWriteText: m._atomicWriteText,
    });

    // Schedule a debounced rebuild
    rebuilder.requestRebuild();

    // Immediately flush — this should cancel the pending timeout and run once
    await rebuilder.flushNow();

    // Advance past the debounce window to confirm nothing else fires
    mock.timers.tick(300);
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    assert.equal(m.viewCallCount(), 1, 'exactly one rebuild (the flushed one, not the debounced one)');
  } finally {
    mock.timers.reset();
  }
});

test('publishView is called with the output of buildView', async () => {
  const m = makeMocks();
  const rebuilder = createViewRebuilder({
    ideaDir: '/fake/idea',
    broker: m.broker,
    _buildLoaderInput: m._buildLoaderInput,
    _buildView: m._buildView,
    _atomicWriteText: m._atomicWriteText,
  });

  await rebuilder.flushNow();

  assert.equal(m.brokerPublishViewCalls.length, 1);
  assert.deepEqual(m.brokerPublishViewCalls[0], m.fakeView);
});

test('atomicWriteText is called with the correct path and JSON content', async () => {
  const m = makeMocks();
  const ideaDir = '/fake/idea/dir';
  const rebuilder = createViewRebuilder({
    ideaDir,
    broker: m.broker,
    _buildLoaderInput: m._buildLoaderInput,
    _buildView: m._buildView,
    _atomicWriteText: m._atomicWriteText,
  });

  await rebuilder.flushNow();

  assert.equal(m.writeCallArgs.length, 1);
  const { filePath, text } = m.writeCallArgs[0];
  assert.equal(filePath, path.join(ideaDir, 'inspect-view.json'));

  // Text should be valid JSON ending with a newline
  const parsed = JSON.parse(text);
  assert.deepEqual(parsed, m.fakeView);
  assert.ok(text.endsWith('\n'), 'output ends with newline');
});

test('concurrent flushNow calls do not produce overlapping rebuilds (M19)', async () => {
  let inflightCount = 0;
  let maxInflight = 0;
  let loadCalls = 0;

  const slowLoad = async () => {
    inflightCount++;
    loadCalls++;
    maxInflight = Math.max(maxInflight, inflightCount);
    await new Promise((r) => setTimeout(r, 10));
    inflightCount--;
    return { index: {}, logs: {}, enrichments: {} };
  };

  const rebuilder = createViewRebuilder({
    ideaDir: '/fake/idea',
    broker: { publishView() {} },
    _buildLoaderInput: slowLoad,
    _buildView: () => ({ id: 'x' }),
    _atomicWriteText: async () => {},
  });

  await Promise.all([
    rebuilder.flushNow(),
    rebuilder.flushNow(),
    rebuilder.flushNow(),
  ]);

  assert.equal(maxInflight, 1, 'no two rebuilds run concurrently');
  // At most one extra follow-up rebuild — initial + coalesced follow-up = 2 max.
  assert.ok(loadCalls <= 2, `load called at most twice, got ${loadCalls}`);
});

test('requestRebuild does not start a new rebuild while one is in flight (M19)', async () => {
  let inflightCount = 0;
  let maxInflight = 0;

  const slowLoad = async () => {
    inflightCount++;
    maxInflight = Math.max(maxInflight, inflightCount);
    await new Promise((r) => setTimeout(r, 20));
    inflightCount--;
    return { index: {}, logs: {}, enrichments: {} };
  };

  const rebuilder = createViewRebuilder({
    ideaDir: '/fake/idea',
    broker: { publishView() {} },
    _buildLoaderInput: slowLoad,
    _buildView: () => ({ id: 'x' }),
    _atomicWriteText: async () => {},
  });

  // Kick off a flushNow (starts a rebuild immediately).
  const p = rebuilder.flushNow();
  // While that rebuild is in-flight, fire several requestRebuild calls.
  // They should be no-ops because inFlight is set.
  for (let i = 0; i < 10; i++) rebuilder.requestRebuild();

  await p;
  // Allow any debounced timer that snuck through to fire (it shouldn't).
  await new Promise((r) => setTimeout(r, 350));

  assert.equal(maxInflight, 1, 'requestRebuild while in-flight does not start a second rebuild');
});

test('readLogs caches parsed files by size+mtimeMs (H7)', async () => {
  const fs = require('node:fs/promises');
  const os = require('node:os');
  const fsPath = require('node:path');
  const { readLogs, _clearCache } = require('../../loader/readLogs');

  _clearCache();

  const tmp = await fs.mkdtemp(fsPath.join(os.tmpdir(), 'msv-readlogs-cache-'));
  const logsDir = fsPath.join(tmp, 'logs');
  await fs.mkdir(logsDir, { recursive: true });
  const fileA = fsPath.join(logsDir, 'a.jsonl');
  await fs.writeFile(fileA, JSON.stringify({ n: 1 }) + '\n' + JSON.stringify({ n: 2 }) + '\n');

  // Spy on fs.readFile via monkey-patch: count invocations against fileA.
  const origReadFile = fs.readFile.bind(fs);
  let readFileCalls = 0;
  const fsMod = require('node:fs/promises');
  fsMod.readFile = async (...args) => {
    if (args[0] === fileA) readFileCalls++;
    return origReadFile(...args);
  };

  try {
    const first = await readLogs(tmp);
    assert.deepEqual(first.a, [{ n: 1 }, { n: 2 }]);
    assert.equal(readFileCalls, 1, 'first read parses the file');

    const second = await readLogs(tmp);
    assert.deepEqual(second.a, [{ n: 1 }, { n: 2 }]);
    assert.equal(readFileCalls, 1, 'second read served from cache (no re-read)');

    // Append → size changes → cache invalidates and re-parses.
    // Force a different mtime by waiting 10ms (filesystem timestamp granularity).
    await new Promise((r) => setTimeout(r, 10));
    await fs.appendFile(fileA, JSON.stringify({ n: 3 }) + '\n');

    const third = await readLogs(tmp);
    assert.deepEqual(third.a, [{ n: 1 }, { n: 2 }, { n: 3 }]);
    assert.equal(readFileCalls, 2, 'append invalidates cache, file re-parsed');
  } finally {
    fsMod.readFile = origReadFile;
    await fs.rm(tmp, { recursive: true, force: true });
    _clearCache();
  }
});
