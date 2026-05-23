const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { v4: uuidv4 } = require('uuid');
const { MODEL, SYNTHESIZER_MODEL } = require('./models');

let ROOT_DIR = process.env.MSV_ROOT
  ? path.resolve(process.env.MSV_ROOT)
  : path.join(os.homedir(), '.msv');
let IDEAS_DIR = path.join(ROOT_DIR, 'ideas');
let ARCHIVE_DIR = path.join(ROOT_DIR, 'archive');

// Test-only escape hatch. process.env.MSV_ROOT is read once at module load
// into ROOT_DIR, so two test files setting the env var sequentially would race
// on whichever file required storage.js first. setRootForTesting() lets a test
// hook reconfigure the root at runtime, which is the only way to keep test
// files isolated from each other.
function setRootForTesting(dir) {
  ROOT_DIR = path.resolve(dir);
  IDEAS_DIR = path.join(ROOT_DIR, 'ideas');
  ARCHIVE_DIR = path.join(ROOT_DIR, 'archive');
}

const DEFAULT_BUDGET = {
  max_executor_calls: 240,
  max_total_tokens: 8_000_000,
  max_researcher_tool_calls: 200,
  used_executor_calls: 0,
  used_total_tokens: 0,
  used_researcher_tool_calls: 0,
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

// Constrain log-name segments to alphanumerics, underscore, hyphen.
// Any other character (including path separators and dots) is collapsed to '_'.
// Truncated to 96 chars to keep multi-segment composite names within filesystem limits.
function safeSlug(s) {
  return String(s ?? '').replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 96) || '_';
}

function ideaLogPath(id, name) {
  const safe = safeSlug(name);
  const resolved = path.resolve(ideaLogsDir(id), `${safe}.jsonl`);
  assertWithinRoot(resolved, ideaLogsDir(id));
  return resolved;
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

/**
 * Returns the initial (empty) investigation object for a new idea.
 *
 * Resumption fields (see specs/feat-investigation-resumption.md §8.2):
 *   progress      – null until runPipeline starts; thereafter:
 *                     {
 *                       current_stage: '1_discovery' | '2_diversity' |
 *                                      '3_coordinator' | '4_working_groups' |
 *                                      '5_cross_pollination' | '6_forum' |
 *                                      '7_synthesis' | 'complete',
 *                       working_groups: { [territoryId: string]: SubStageProgressValue }
 *                     }
 *                   where SubStageProgressValue is one of: 'pending',
 *                   'ideation_complete', 'adversarial_complete',
 *                   'alignment_complete', 'researcher_complete',
 *                   'observation_complete', 'debate_complete', 'complete'.
 *   last_failure  – null on success; on failure:
 *                     {
 *                       reason: 'anthropic_unavailable' | 'user_cancelled' | 'internal_error',
 *                       stage:  <current_stage value>,
 *                       territory_id: <slug> | null,
 *                       sub_stage:    'ideation' | 'adversarial' | ... | 'debate' | null,
 *                       error_message: <sanitised single-line message>,
 *                       occurred_at:   <ISO 8601>
 *                     }
 */
function freshInvestigation() {
  return {
    schema_version: 'v5',
    started_at: null,
    completed_at: null,
    model: MODEL,
    synthesizer_model: SYNTHESIZER_MODEL,
    budget: { ...DEFAULT_BUDGET },
    perspective_discovery: {
      search_queries: [],
      candidate_personas: [],
      selected_persona_ids: [],
      fixed_personas: ['skeptic', 'builder'],
    },
    coordinator_decisions: {
      initial: null,
    },
    pair_debates: [],
    cross_pollination: [],
    forum: {
      constructed_at: null,
      nodes: [],
      dead_end_questions: [],
    },
    synthesis: null,
    progress: null,
    last_failure: null,
  };
}

// Legacy ideas lack schema_version; tag them on load so downstream code can
// branch without checking for the absent field.
// Structural heuristic: if any pair_debate has territory_id, the idea was written
// by the v5 pipeline (which uses territory_id), even if schema_version was lost
// in a partial migration or hand-edit. Falls back to v4 only when no signal exists.
function normalizeLoadedIdea(idea) {
  const inv = idea?.investigation;
  if (!inv) return idea;
  // Ensure resumption fields exist at well-known keys with null defaults so
  // downstream code can read inv.progress without optional-chaining each time.
  // Ideas written by older code have both null; planResume treats that as "no
  // resume anchor" and falls back to fresh-run.
  if (!('progress' in inv)) inv.progress = null;
  if (!('last_failure' in inv)) inv.last_failure = null;
  if (!inv.schema_version) {
    const firstDebate = Array.isArray(inv.pair_debates) ? inv.pair_debates[0] : null;
    const hasV5Marker =
      firstDebate?.territory_id != null ||
      Array.isArray(inv.coordinator_decisions?.initial?.territories);
    inv.schema_version = hasV5Marker ? 'v5' : 'v4';
  }
  return idea;
}

// Strip ANSI / control characters from a string before persisting it to a log file.
// Reason: researcher output may include web-fetched content with ANSI escape or OSC
// sequences that hijack terminals when a developer `cat`s the JSONL file.
// Applied recursively to any object before JSON.stringify.
function stripControlChars(value) {
  if (typeof value === 'string') {
    // eslint-disable-next-line no-control-regex
    return value.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f]/g, '');
  }
  if (Array.isArray(value)) return value.map(stripControlChars);
  if (value && typeof value === 'object') {
    const out = {};
    for (const k of Object.keys(value)) out[k] = stripControlChars(value[k]);
    return out;
  }
  return value;
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
  const idea = await readJsonFile(ideaIndexPath(id));
  return normalizeLoadedIdea(idea);
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
  const entry = stripControlChars({ ts: new Date().toISOString(), ...record });
  await fs.appendFile(ideaLogPath(id, name), `${JSON.stringify(entry)}\n`, 'utf8');
}

async function readLog(id, name) {
  const content = await fs.readFile(ideaLogPath(id, name), 'utf8');
  return content
    .split('\n')
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line));
}

// Per-idea async mutex that serialises concurrent read-modify-write operations
// on index.json. Without this, two concurrent working-group checkpoint callbacks
// can both observe findIndex === -1 and both append, duplicating entries.
//
// Use this when multiple concurrent async tasks may mutate + write the same idea
// (e.g. working-group checkpoint callbacks under Promise.allSettled). Callers
// that run only one writer at a time (the top-level runPipeline stages) may call
// writeIdea directly without going through the mutex.
//
// Each caller stores its own `next` (its release signal) in the map and replaces
// the previous entry. The chain is built by each new caller capturing the prior
// `next` from the map and awaiting it. The cleanup predicate compares against
// the same `next` we stored, so only the last caller in the chain deletes the
// map entry — otherwise the map would grow by one entry per processed idea.
const _ideaMutexes = new Map();
async function ideaWriteMutex(id, fn) {
  const prev = _ideaMutexes.get(id) || Promise.resolve();
  let resolveNext;
  const next = new Promise((r) => {
    resolveNext = r;
  });
  _ideaMutexes.set(id, next);
  await prev;
  try {
    return await fn();
  } finally {
    resolveNext();
    if (_ideaMutexes.get(id) === next) _ideaMutexes.delete(id);
  }
}

// Test-only: number of live mutex entries. Used to verify the cleanup predicate.
function _ideaMutexSize() {
  return _ideaMutexes.size;
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
  normalizeLoadedIdea,
  safeSlug,
  stripControlChars,
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
  ideaWriteMutex,
  _ideaMutexSize,
  setRootForTesting,
};
