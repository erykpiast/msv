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
  // A single follow-up rebuild promise shared by all callers that arrive
  // while `inFlight` is already running. Ensures we never run more than one
  // rebuild concurrently, even under concurrent flushNow calls.
  let queued = null;

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

  function startRebuild() {
    inFlight = rebuildOnce().finally(() => { inFlight = null; });
    return inFlight;
  }

  function requestRebuild() {
    if (pending || inFlight) return;
    pending = setTimeout(() => {
      pending = null;
      startRebuild();
    }, DEBOUNCE_MS);
  }

  async function flushNow() {
    if (pending) { clearTimeout(pending); pending = null; }
    if (inFlight) {
      // A rebuild is already running. Coalesce all concurrent flush callers
      // onto a single follow-up rebuild that runs after the current one
      // completes — guarantees no overlapping rebuilds.
      if (!queued) {
        queued = inFlight.then(() => {
          queued = null;
          return startRebuild();
        });
      }
      return queued;
    }
    return startRebuild();
  }

  return { requestRebuild, flushNow };
}

module.exports = { createViewRebuilder };
