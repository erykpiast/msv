const { listIdeas, listIdeasByStatus, listArchivedIdeas } = require('../storage');

const PREVIEW_LEN = 60;

function preview(text) {
  const oneline = text.replace(/\s+/g, ' ').trim();
  return oneline.length > PREVIEW_LEN ? `${oneline.slice(0, PREVIEW_LEN)}…` : oneline;
}

function formatDate(iso) {
  return iso ? iso.slice(0, 10) : '?';
}

function renderIdeas(ideas) {
  if (ideas.length === 0) {
    process.stdout.write('no ideas\n');
    return;
  }
  for (const idea of ideas) {
    const status = (idea.status || 'unknown').padEnd(13);
    const date = formatDate(idea.captured_at);
    process.stdout.write(`${idea.id}  ${status}  ${date}  ${preview(idea.raw_capture)}\n`);
  }
}

async function runListCommand(args) {
  const filterArg = args.find((a) => a.startsWith('--filter='));
  const filter = filterArg ? filterArg.slice('--filter='.length) : null;

  if (filter !== null && filter !== 'pending' && filter !== 'archived') {
    process.stderr.write(`msv list: unknown filter "${filter}". Valid values: pending, archived\n`);
    process.exitCode = 1;
    return;
  }

  if (filter === 'archived') {
    renderIdeas(await listArchivedIdeas());
  } else if (filter === 'pending') {
    renderIdeas(await listIdeasByStatus('pending'));
  } else {
    renderIdeas(await listIdeas());
  }
}

module.exports = { runListCommand };
