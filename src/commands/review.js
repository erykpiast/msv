const readline = require('node:readline/promises');
const { spawn } = require('node:child_process');
const { stdin, stdout } = require('node:process');
const {
  archiveIdea,
  createIdea,
  listIdeasByStatus,
  writeIdea,
} = require('../storage');
const { renderSteerCard, renderSynthesis, renderQuestionLandscape, renderDeadEnds } = require('../render');
const { runInspectCommand } = require('./inspect');

function clearScreen() {
  process.stdout.write('\x1B[2J\x1B[0f');
}

function pageReport(text) {
  return new Promise((resolve) => {
    const pager = spawn('less', ['-R'], { stdio: ['pipe', 'inherit', 'inherit'] });
    let resolved = false;
    pager.on('error', () => {
      if (resolved) return;
      resolved = true;
      // Fallback: print the report directly.
      process.stdout.write(`${text}\n`);
      resolve();
    });
    pager.on('close', () => {
      if (resolved) return;
      resolved = true;
      resolve();
    });
    pager.stdin.on('error', () => {
      /* swallow EPIPE; less may exit before we finish writing */
    });
    pager.stdin.end(text);
  });
}

function ensureUserReactions(idea) {
  if (!idea.user_reactions || typeof idea.user_reactions !== 'object') {
    idea.user_reactions = { steer_notes: [], follow_up_topic: null };
  }
  if (!Array.isArray(idea.user_reactions.steer_notes)) {
    idea.user_reactions.steer_notes = [];
  }
}

async function steerLoop(rl, idea) {
  while (true) {
    const action = (await rl.question('> ')).trim().toLowerCase();

    if (action === 'r') {
      await pageReport(renderSynthesis(idea));
      clearScreen();
      process.stdout.write(`${renderSteerCard(idea)}\n`);
      continue;
    }

    if (action === 'k') {
      idea.status = 'archived';
      await writeIdea(idea);
      await archiveIdea(idea.id);
      process.stdout.write(`archived ${idea.id}\n`);
      return { action: 'kill' };
    }

    if (action === 'n') {
      const note = (await rl.question('note: ')).trim();
      if (note) {
        ensureUserReactions(idea);
        idea.user_reactions.steer_notes.push({
          at: new Date().toISOString(),
          text: note,
        });
        await writeIdea(idea);
        process.stdout.write('note added.\n');
      }
      continue;
    }

    if (action === 'q') {
      const landscape = renderQuestionLandscape(idea);
      await pageReport(landscape);
      clearScreen();
      process.stdout.write(`${renderSteerCard(idea)}\n`);
      continue;
    }

    if (action === 'e') {
      const deadEnds = renderDeadEnds(idea);
      await pageReport(`DEAD ENDS\n\n${deadEnds}`);
      clearScreen();
      process.stdout.write(`${renderSteerCard(idea)}\n`);
      continue;
    }

    if (action === 'i') {
      process.stdout.write(`booting msv inspect ${idea.id} — Ctrl-C to return\n`);
      try {
        await runInspectCommand([idea.id]);
      } catch (err) {
        process.stdout.write(`inspect failed: ${err.message}\n`);
      }
      clearScreen();
      process.stdout.write(`${renderSteerCard(idea)}\n`);
      continue;
    }

    if (action === 'd') {
      const topic = (await rl.question('refined topic: ')).trim();
      if (!topic) {
        process.stdout.write('skipped: empty topic.\n');
        continue;
      }
      ensureUserReactions(idea);
      idea.user_reactions.follow_up_topic = topic;
      const followUp = createIdea(topic, { parent_id: idea.id });
      await writeIdea(followUp);
      idea.status = 'archived';
      await writeIdea(idea);
      await archiveIdea(idea.id);
      process.stdout.write(`spawned ${followUp.id}, archived ${idea.id}\n`);
      return { action: 'deeper', followUpId: followUp.id };
    }

    process.stdout.write('unknown action. [r]ead  [q]uestions  [e]dead-ends  [d]eeper  [k]ill  [n]otes  [i]nspect\n');
  }
}

async function runReviewCommand() {
  const readyIdeas = await listIdeasByStatus('ready');
  readyIdeas.sort((a, b) => (a.last_action_at || '').localeCompare(b.last_action_at || ''));

  if (readyIdeas.length === 0) {
    process.stdout.write('nothing to review\n');
    return;
  }

  const rl = readline.createInterface({ input: stdin, output: stdout });
  let followUpCount = 0;
  try {
    for (const idea of readyIdeas) {
      clearScreen();
      process.stdout.write(`${renderSteerCard(idea)}\n`);
      const result = await steerLoop(rl, idea);
      if (result.action === 'deeper') followUpCount += 1;
    }
  } finally {
    rl.close();
  }

  process.stdout.write('no more ready ideas\n');
  if (followUpCount > 0) {
    process.stdout.write(
      `${followUpCount} follow-up investigation(s) queued — run msv run --all to process\n`
    );
  }
}

module.exports = {
  runReviewCommand,
};
