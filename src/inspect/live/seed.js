'use strict';

const path = require('node:path');
const { createReadStream } = require('node:fs');
const { createInterface } = require('node:readline');

function isValidEnvelope(env) {
  return (
    env !== null &&
    typeof env === 'object' &&
    typeof env.name === 'string' &&
    typeof env.idea_id === 'string' &&
    typeof env.ts === 'number'
  );
}

async function seedBrokerFromDisk({ ideaDir, broker, ideaId }) {
  const filePath = path.join(ideaDir, 'events.jsonl');
  const stream = createReadStream(filePath, { encoding: 'utf8' });

  // createReadStream is lazy: ENOENT (and other errors) surface as an 'error'
  // event when the stream tries to open the file. readline's `for await` will
  // reject with that error, so we catch it here and map ENOENT to count=0.
  const rl = createInterface({ input: stream, crlfDelay: Infinity });

  let count = 0;
  try {
    for await (const line of rl) {
      if (!line.trim()) continue;
      try {
        const env = JSON.parse(line);
        if (isValidEnvelope(env) && broker.publishEvent(env)) {
          count += 1;
        }
      } catch {
        // Tolerate partial / malformed lines.
      }
    }
  } catch (err) {
    if (err && err.code === 'ENOENT') return 0;
    throw err;
  }
  return count;
}

module.exports = { seedBrokerFromDisk, isValidEnvelope };
