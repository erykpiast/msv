'use strict';

const path = require('node:path');
const { atomicWriteText } = require('../../storage');
const { buildLoaderInput } = require('../loader');
const { buildView } = require('../view/build');

const DEBOUNCE_MS = 250;

/**
 * Creates a debounced view rebuilder.
 *
 * @param {object} opts
 * @param {string} opts.ideaDir - Absolute path to the idea directory.
 * @param {object} opts.broker  - Event broker; receives publishView calls.
 *
 * The following are TEST-ONLY dependency-injection overrides. Do not pass
 * them in production — they replace real I/O with mocks for unit tests.
 * @param {Function} [opts._buildLoaderInput]
 * @param {Function} [opts._buildView]
 * @param {Function} [opts._atomicWriteText]
 */
function createViewRebuilder({
  ideaDir,
  broker,
  _buildLoaderInput,
  _buildView,
  _atomicWriteText,
} = {}) {
  const doLoad = _buildLoaderInput || buildLoaderInput;
  const doView = _buildView || buildView;
  const doWrite = _atomicWriteText || atomicWriteText;

  let pending = null;
  let inFlight = null;

  async function rebuildOnce() {
    try {
      const input = await doLoad(ideaDir);
      const view = doView(input);
      broker.publishView(view);
      await doWrite(
        path.join(ideaDir, 'inspect-view.json'),
        `${JSON.stringify(view, null, 2)}\n`,
      );
    } catch (err) {
      process.stderr.write(`view rebuild failed: ${err.message}\n`);
    }
  }

  function requestRebuild() {
    if (pending) return;
    pending = setTimeout(() => {
      pending = null;
      inFlight = rebuildOnce().finally(() => { inFlight = null; });
    }, DEBOUNCE_MS);
  }

  async function flushNow() {
    if (pending) { clearTimeout(pending); pending = null; }
    if (inFlight) await inFlight;
    inFlight = rebuildOnce().finally(() => { inFlight = null; });
    return inFlight;
  }

  return { requestRebuild, flushNow };
}

module.exports = { createViewRebuilder };
