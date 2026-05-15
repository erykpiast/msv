const readline = require('node:readline/promises');
const { stdin, stdout } = require('node:process');
const { archiveIdea, createIdea, listIdeasByStatus, writeIdea } = require('../storage');
const { renderSteerCard, renderSynthesis } = require('../render');

async function runReviewCommand() {
  const readyIdeas = await listIdeasByStatus('ready');
  if (readyIdeas.length === 0) {
    process.stdout.write('No ready investigations.\n');
    return;
  }

  const rl = readline.createInterface({ input: stdin, output: stdout });
  try {
    for (const idea of readyIdeas) {
      process.stdout.write(`${renderSteerCard(idea)}\n`);
      const action = (await rl.question('Select action [r/d/k/n/q]: ')).trim().toLowerCase();

      if (action === 'q') {
        break;
      }

      if (action === 'r') {
        process.stdout.write(`${renderSynthesis(idea)}\n`);
        continue;
      }

      if (action === 'n') {
        const note = (await rl.question('Steer note: ')).trim();
        if (note) {
          if (!idea.user_reactions || typeof idea.user_reactions !== 'object') {
            idea.user_reactions = { steer_notes: [], follow_up_topic: null };
          }
          if (!Array.isArray(idea.user_reactions.steer_notes)) {
            idea.user_reactions.steer_notes = [];
          }
          idea.user_reactions.steer_notes.push({
            at: new Date().toISOString(),
            note,
          });
          idea.last_action_at = new Date().toISOString();
          await writeIdea(idea);
          process.stdout.write('Note added.\n');
        }
        continue;
      }

      if (action === 'd') {
        const topic = (await rl.question('Follow-up topic: ')).trim();
        if (!topic) {
          process.stdout.write('Skipped: empty follow-up topic.\n');
          continue;
        }

        const followUpIdea = createIdea(topic, {
          user_reactions: {
            steer_notes: [],
            follow_up_topic: null,
          },
          linked_from_idea_id: idea.id,
        });
        await writeIdea(followUpIdea);

        if (!idea.user_reactions || typeof idea.user_reactions !== 'object') {
          idea.user_reactions = { steer_notes: [], follow_up_topic: null };
        }
        idea.user_reactions.follow_up_topic = topic;
        idea.last_action_at = new Date().toISOString();
        await writeIdea(idea);

        process.stdout.write(`Created follow-up idea: ${followUpIdea.id}\n`);
        continue;
      }

      if (action === 'k') {
        idea.status = 'archived';
        idea.last_action_at = new Date().toISOString();
        await writeIdea(idea);
        await archiveIdea(idea.id);
        process.stdout.write(`Archived idea ${idea.id}\n`);
        continue;
      }

      process.stdout.write('Unknown action; skipping.\n');
    }
  } finally {
    rl.close();
  }
}

module.exports = {
  runReviewCommand,
};
