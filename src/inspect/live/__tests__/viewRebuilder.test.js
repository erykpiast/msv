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
