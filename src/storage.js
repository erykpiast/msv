const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { v4: uuidv4 } = require('uuid');

const ROOT_DIR = path.join(os.homedir(), '.msv');
const IDEAS_DIR = path.join(ROOT_DIR, 'ideas');
const ARCHIVE_DIR = path.join(ROOT_DIR, 'archive');

async function ensureStorageDirs() {
  await Promise.all([
    fs.mkdir(ROOT_DIR, { recursive: true }),
    fs.mkdir(IDEAS_DIR, { recursive: true }),
    fs.mkdir(ARCHIVE_DIR, { recursive: true }),
  ]);
}

function ideaFilePath(id) {
  return path.join(IDEAS_DIR, `${id}.json`);
}

function archivedIdeaFilePath(id) {
  return path.join(ARCHIVE_DIR, `${id}.json`);
}

async function atomicWriteJson(filePath, data) {
  const dir = path.dirname(filePath);
  const tmpPath = path.join(
    dir,
    `.${path.basename(filePath)}.${process.pid}.${Date.now()}.tmp`
  );
  const serialized = `${JSON.stringify(data, null, 2)}\n`;
  await fs.writeFile(tmpPath, serialized, 'utf8');
  await fs.rename(tmpPath, filePath);
}

async function readJsonFile(filePath) {
  const content = await fs.readFile(filePath, 'utf8');
  return JSON.parse(content);
}

function createIdea(rawCapture, extras = {}) {
  const now = new Date().toISOString();
  return {
    id: uuidv4(),
    raw_capture: rawCapture,
    captured_at: now,
    status: 'pending',
    last_action_at: now,
    investigation: {
      budget: {},
      perspective_discovery: [],
      coordinator_decisions: [],
      pair_debates: [],
      cross_pollination: [],
      forum: {
        nodes: [],
        contradictions: [],
      },
      synthesis: null,
      events: [],
    },
    user_reactions: {
      steer_notes: [],
      follow_up_topic: null,
    },
    ...extras,
  };
}

function appendEvent(idea, stage, details) {
  if (!idea.investigation || typeof idea.investigation !== 'object') {
    idea.investigation = {};
  }
  if (!Array.isArray(idea.investigation.events)) {
    idea.investigation.events = [];
  }
  idea.investigation.events.push({
    at: new Date().toISOString(),
    stage,
    details,
  });
  idea.last_action_at = new Date().toISOString();
  return idea;
}

async function writeIdea(idea) {
  await ensureStorageDirs();
  await atomicWriteJson(ideaFilePath(idea.id), idea);
}

async function readIdea(id) {
  await ensureStorageDirs();
  return readJsonFile(ideaFilePath(id));
}

async function listIdeas() {
  await ensureStorageDirs();
  const entries = await fs.readdir(IDEAS_DIR, { withFileTypes: true });
  const ideaFiles = entries.filter((entry) => entry.isFile() && entry.name.endsWith('.json'));
  const ideas = await Promise.all(
    ideaFiles.map((entry) => readJsonFile(path.join(IDEAS_DIR, entry.name)))
  );
  return ideas.sort((a, b) => a.captured_at.localeCompare(b.captured_at));
}

async function listIdeasByStatus(status) {
  const ideas = await listIdeas();
  return ideas.filter((idea) => idea.status === status);
}

async function archiveIdea(id) {
  await ensureStorageDirs();
  const source = ideaFilePath(id);
  const target = archivedIdeaFilePath(id);
  await fs.rename(source, target);
}

module.exports = {
  ROOT_DIR,
  IDEAS_DIR,
  ARCHIVE_DIR,
  ensureStorageDirs,
  atomicWriteJson,
  readJsonFile,
  createIdea,
  appendEvent,
  writeIdea,
  readIdea,
  listIdeas,
  listIdeasByStatus,
  archiveIdea,
  ideaFilePath,
  archivedIdeaFilePath,
};
