const fs = require('node:fs/promises');
const path = require('node:path');

// Module-level cache keyed by absolute file path.
// Each entry: { size, mtimeMs, records }
//
// Investigation log files are append-only, so any change is reflected in
// either size or mtimeMs. We treat the (size, mtimeMs) pair as the cache
// key; if either differs, we re-read and re-parse.
const cache = new Map();

function _clearCache() {
  cache.clear();
}

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

      // Stat first so we can consult the cache.
      let stat;
      try {
        stat = await fs.stat(filePath);
      } catch (err) {
        // File may have vanished between readdir and stat (rare). Skip it,
        // preserving prior semantics where such transient errors should not
        // crash the rebuild — the next rebuild will pick it up.
        if (err.code === 'ENOENT') return;
        throw err;
      }

      const cached = cache.get(filePath);
      let records;
      if (
        cached &&
        cached.size === stat.size &&
        cached.mtimeMs === stat.mtimeMs
      ) {
        records = cached.records;
      } else {
        let raw;
        try {
          raw = await fs.readFile(filePath, 'utf8');
        } catch (err) {
          if (err.code === 'ENOENT') return;
          throw err;
        }
        const lines = raw.split('\n').filter((line) => line.length > 0);
        records = [];
        for (const line of lines) {
          try {
            records.push(JSON.parse(line));
          } catch (err) {
            throw new Error(`Failed to parse JSONL line in ${filePath}: ${err.message}`);
          }
        }
        cache.set(filePath, {
          size: stat.size,
          mtimeMs: stat.mtimeMs,
          records,
        });
      }

      const key = name.replace(/\.jsonl$/, '');
      result[key] = records;
    })
  );
  return result;
}

module.exports = { readLogs, _clearCache };
