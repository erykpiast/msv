'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');

async function seedBrokerFromDisk({ ideaDir, broker, ideaId }) {
  let raw;
  try {
    raw = await fs.readFile(path.join(ideaDir, 'events.jsonl'), 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return 0;
    throw err;
  }
  let count = 0;
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    try {
      const env = JSON.parse(line);
      if (broker.publishEvent(env)) count += 1;
    } catch {
      // Tolerate partial last line.
    }
  }
  return count;
}

module.exports = { seedBrokerFromDisk };
