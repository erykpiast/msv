const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { v4: uuidv4 } = require('uuid');
const { DEFAULT_MODEL } = require('./anthropic');

const ROOT_DIR = process.env.MSV_ROOT
  ? path.resolve(process.env.MSV_ROOT)
  : path.join(os.homedir(), '.msv');
const IDEAS_DIR = path.join(ROOT_DIR, 'ideas');
const ARCHIVE_DIR = path.join(ROOT_DIR, 'archive');

const DEFAULT_BUDGET = {
  max_executor_calls: 60,
  max_total_tokens: 500000,
  used_executor_calls: 0,
  used_total_tokens: 0,
};

async function ensureStorageDirs() {
  await Promise.all([
    fs.mkdir(ROOT_DIR, { recursive: true }),
    fs.mkdir(IDEAS_DIR, { recursive: true }),
    fs.mkdir(ARCHIVE_DIR, { recursive: true }),
  ]);
}

function assertWithinRoot(resolved, base) {
  // path.resolve collapses .. segments before this check, so a `..` in id can't escape.
  if (resolved !== base && !resolved.startsWith(base + path.sep)) {
    throw new Error(`Invalid path outside ${base}: ${resolved}`);
  }
}

function ideaDir(id) {
  const resolved = path.resolve(IDEAS_DIR, String(id));
  assertWithinRoot(resolved, IDEAS_DIR);
  return resolved;
}

function ideaIndexPath(id) {
  return path.join(ideaDir(id), 'index.json');
}

function ideaLogsDir(id) {
  return path.join(ideaDir(id), 'logs');
}

function ideaLogPath(id, name) {
  return path.join(ideaLogsDir(id), `${name}.jsonl`);
}

function archivedIdeaDir(id) {
  const resolved = path.resolve(ARCHIVE_DIR, String(id));
  assertWithinRoot(resolved, ARCHIVE_DIR);
  return resolved;
}

async function ensureIdeaDirs(id) {
  await fs.mkdir(ideaLogsDir(id), { recursive: true });
}

async function atomicWriteText(filePath, text) {
  const dir = path.dirname(filePath);
  const tmpPath = path.join(
    dir,
    `.${path.basename(filePath)}.${process.pid}.${Date.now()}.tmp`
  );
  try {
    // flag: 'wx' = exclusive create — refuses to write through a pre-placed
    // symlink or to overwrite an existing file at the tmp path. Defence in
    // depth against a symlink-redirect attack on shared filesystems.
    await fs.writeFile(tmpPath, text, { encoding: 'utf8', flag: 'wx' });
    await fs.rename(tmpPath, filePath);
  } catch (err) {
    await fs.rm(tmpPath, { force: true });
    throw err;
  }
}

async function atomicWriteJson(filePath, data) {
  const serialized = `${JSON.stringify(data, null, 2)}\n`;
  await atomicWriteText(filePath, serialized);
}

async function readJsonFile(filePath) {
  const content = await fs.readFile(filePath, 'utf8');
  return JSON.parse(content);
}

function freshInvestigation() {
  return {
    started_at: null,
    completed_at: null,
    model: DEFAULT_MODEL,
    budget: { ...DEFAULT_BUDGET },
    perspective_discovery: {
      search_queries: [],
      candidate_personas: [],
      selected_persona_ids: [],
      fixed_personas: ['skeptic', 'builder'],
    },
    coordinator_decisions: {
      initial: null,
      spawn: null,
    },
    pair_debates: [],
    cross_pollination: [],
    forum: {
      constructed_at: null,
      nodes: [],
    },
    synthesis: null,
  };
}

function createIdea(rawCapture, extras = {}) {
  const now = new Date().toISOString();
  return {
    id: uuidv4(),
    raw_capture: rawCapture,
    captured_at: now,
    status: 'pending',
    last_action_at: now,
    parent_id: null,
    investigation: freshInvestigation(),
    user_reactions: {
      steer_notes: [],
      follow_up_topic: null,
    },
    ...extras,
  };
}

async function writeIdea(idea) {
  // ensureIdeaDirs is recursive mkdir — cheap kernel fast-path once dirs exist.
  // We drop the redundant ensureStorageDirs that was previously called on every
  // stage write: the entry-point commands handle that once.
  await ensureIdeaDirs(idea.id);
  idea.last_action_at = new Date().toISOString();
  await atomicWriteJson(ideaIndexPath(idea.id), idea);
}

async function readIdea(id) {
  return readJsonFile(ideaIndexPath(id));
}

async function listIdeas() {
  await ensureStorageDirs();
  const entries = await fs.readdir(IDEAS_DIR, { withFileTypes: true });
  const ideaDirs = entries.filter((entry) => entry.isDirectory());
  const ideas = await Promise.all(
    ideaDirs.map(async (entry) => {
      try {
        return await readJsonFile(path.join(IDEAS_DIR, entry.name, 'index.json'));
      } catch (err) {
        if (err.code === 'ENOENT') return null;
        throw err;
      }
    })
  );
  return ideas
    .filter((idea) => idea !== null)
    .sort((a, b) => (a.captured_at || '').localeCompare(b.captured_at || ''));
}

async function listIdeasByStatus(status) {
  const ideas = await listIdeas();
  return ideas.filter((idea) => idea.status === status);
}

async function listArchivedIdeas() {
  await ensureStorageDirs();
  const entries = await fs.readdir(ARCHIVE_DIR, { withFileTypes: true });
  const dirs = entries.filter((entry) => entry.isDirectory());
  const ideas = await Promise.all(
    dirs.map(async (entry) => {
      try {
        return await readJsonFile(path.join(ARCHIVE_DIR, entry.name, 'index.json'));
      } catch (err) {
        if (err.code === 'ENOENT') return null;
        throw err;
      }
    })
  );
  return ideas
    .filter((idea) => idea !== null)
    .sort((a, b) => (a.captured_at || '').localeCompare(b.captured_at || ''));
}

async function archiveIdea(id) {
  await fs.rename(ideaDir(id), archivedIdeaDir(id));
}

async function appendLog(id, name, record) {
  const entry = { ts: new Date().toISOString(), ...record };
  await fs.appendFile(ideaLogPath(id, name), `${JSON.stringify(entry)}\n`, 'utf8');
}

async function readLog(id, name) {
  const content = await fs.readFile(ideaLogPath(id, name), 'utf8');
  return content
    .split('\n')
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line));
}

module.exports = {
  ROOT_DIR,
  IDEAS_DIR,
  ARCHIVE_DIR,
  DEFAULT_BUDGET,
  ensureStorageDirs,
  ensureIdeaDirs,
  atomicWriteJson,
  atomicWriteText,
  readJsonFile,
  freshInvestigation,
  createIdea,
  writeIdea,
  readIdea,
  listIdeas,
  listIdeasByStatus,
  listArchivedIdeas,
  archiveIdea,
  appendLog,
  readLog,
  ideaDir,
  ideaIndexPath,
  ideaLogsDir,
  ideaLogPath,
  archivedIdeaDir,
};
