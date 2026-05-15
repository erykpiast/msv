const { appendEvent, listIdeasByStatus, readIdea, writeIdea } = require('../storage');

const STAGE_SEQUENCE = [
  'perspective_discovery',
  'diversity_aware_selection',
  'coordinator',
  'working_groups',
  'cross_pollination',
  'forum_aggregation',
  'synthesizer',
];

function parseRunSelection(args) {
  if (args.length === 0 || args[0] === '--all') {
    return { mode: 'all' };
  }
  return { mode: 'single', id: args[0] };
}

async function runStageScaffold(idea, stageName) {
  appendEvent(idea, stageName, {
    state: 'started',
    note: 'Scaffold placeholder; orchestration to be implemented iteratively.',
  });

  if (stageName === 'working_groups') {
    await Promise.all([]);
  }

  appendEvent(idea, stageName, {
    state: 'deferred',
    note: 'Pipeline orchestration intentionally not auto-implemented.',
  });
}

async function runIdeaScaffold(idea) {
  idea.status = 'investigating';
  appendEvent(idea, 'run', { state: 'started' });
  await writeIdea(idea);

  try {
    for (const stageName of STAGE_SEQUENCE) {
      await runStageScaffold(idea, stageName);
      await writeIdea(idea);
    }
  } catch (error) {
    appendEvent(idea, 'run', {
      state: 'failed',
      error: error instanceof Error ? error.message : String(error),
    });
    await writeIdea(idea);
    throw error;
  }

  appendEvent(idea, 'run', {
    state: 'deferred',
    note: 'Investigation left in investigating state until real orchestration is implemented.',
  });
  await writeIdea(idea);
}

async function runRunCommand(args) {
  const selection = parseRunSelection(args);
  const pendingIdeas = await listIdeasByStatus('pending');

  if (selection.mode === 'all') {
    if (pendingIdeas.length === 0) {
      process.stdout.write('No pending ideas found.\n');
      return;
    }

    for (const idea of pendingIdeas) {
      await runIdeaScaffold(idea);
      process.stdout.write(`Investigated scaffold for ${idea.id}\n`);
    }
    return;
  }

  const selectedId = selection.id;
  const exactPending = pendingIdeas.find((idea) => idea.id === selectedId);
  if (exactPending) {
    await runIdeaScaffold(exactPending);
    process.stdout.write(`Investigated scaffold for ${selectedId}\n`);
    return;
  }

  const anyIdea = await readIdea(selectedId);
  if (anyIdea.status !== 'pending') {
    process.stdout.write(`Idea ${selectedId} is not pending; current status: ${anyIdea.status}\n`);
    return;
  }

  await runIdeaScaffold(anyIdea);
  process.stdout.write(`Investigated scaffold for ${selectedId}\n`);
}

module.exports = {
  STAGE_SEQUENCE,
  runRunCommand,
};
