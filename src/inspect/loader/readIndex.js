const fs = require('node:fs/promises');
const path = require('node:path');

async function readIndex(ideaDir) {
  const indexPath = path.join(ideaDir, 'index.json');
  let raw;
  try {
    raw = await fs.readFile(indexPath, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') {
      const enriched = new Error(`index.json not found at ${indexPath}`);
      enriched.code = 'ENOENT';
      enriched.cause = err;
      throw enriched;
    }
    throw err;
  }
  try {
    return JSON.parse(raw);
  } catch (err) {
    throw new Error(`Failed to parse ${indexPath}: ${err.message}`);
  }
}

module.exports = { readIndex };
