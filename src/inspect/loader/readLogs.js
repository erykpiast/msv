const fs = require('node:fs/promises');
const path = require('node:path');

async function readLogs(ideaDir) {
  const logsDir = path.join(ideaDir, 'logs');
  let entries;
  try {
    entries = await fs.readdir(logsDir, { withFileTypes: true });
  } catch (err) {
    if (err.code === 'ENOENT') return {};
    throw err;
  }
  const files = entries
    .filter((e) => e.isFile() && e.name.endsWith('.jsonl'))
    .map((e) => e.name);

  const result = {};
  await Promise.all(
    files.map(async (name) => {
      const filePath = path.join(logsDir, name);
      const raw = await fs.readFile(filePath, 'utf8');
      const lines = raw.split('\n').filter((line) => line.length > 0);
      const records = [];
      for (const line of lines) {
        try {
          records.push(JSON.parse(line));
        } catch (err) {
          throw new Error(`Failed to parse JSONL line in ${filePath}: ${err.message}`);
        }
      }
      const key = name.replace(/\.jsonl$/, '');
      result[key] = records;
    })
  );
  return result;
}

module.exports = { readLogs };
