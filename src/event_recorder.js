'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { ideaDir } = require('./storage');

function attachRecorder(bus, { idea, filePath: customPath } = {}) {
  if (process.env.MSV_NO_RECORD === '1') {
    return async () => {};
  }

  const filePath = customPath || path.join(ideaDir(idea.id), 'events.jsonl');
  const queue = [];
  // Current flush promise; any caller that needs to drain can await this.
  let currentFlush = null;

  function scheduleFlush() {
    if (currentFlush) return; // a flush is running; it will drain queue in its while loop
    currentFlush = (async () => {
      try {
        while (queue.length > 0) {
          const batch = queue.splice(0, queue.length);
          await fs.appendFile(filePath, batch.join(''), 'utf8');
        }
      } finally {
        currentFlush = null;
      }
    })();
  }

  const off = bus.onAny((env) => {
    queue.push(`${JSON.stringify(env)}\n`);
    scheduleFlush();
  });

  return async () => {
    off();
    // Wait for any in-progress flush to complete, then flush remaining items.
    if (currentFlush) await currentFlush;
    if (queue.length > 0) {
      const batch = queue.splice(0, queue.length);
      await fs.appendFile(filePath, batch.join(''), 'utf8');
    }
  };
}

module.exports = { attachRecorder };
