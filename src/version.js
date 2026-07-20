'use strict';

const { execFileSync } = require('node:child_process');

// Cached for the process lifetime — the running binary's commit doesn't change mid-process.
let cachedSha;

function getCommitSha() {
  if (cachedSha !== undefined) return cachedSha;
  try {
    cachedSha = execFileSync('git', ['rev-parse', '--short', 'HEAD'], {
      cwd: __dirname,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    cachedSha = null;
  }
  return cachedSha;
}

module.exports = { getCommitSha };
