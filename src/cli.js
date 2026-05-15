const { runAddCommand } = require('./commands/add');
const { runRunCommand } = require('./commands/run');
const { runReviewCommand } = require('./commands/review');

const HELP_TEXT = `msv <command> [options]

Commands:
  add                Read idea text from stdin, create pending idea
  run [--all | <id>] Run investigation pipeline scaffold for pending ideas
  review             Review ready investigations
`;

async function main(argv = process.argv.slice(2)) {
  const [command, ...args] = argv;

  if (!command || command === '--help' || command === '-h') {
    process.stdout.write(`${HELP_TEXT}\n`);
    return;
  }

  if (command === 'add') {
    await runAddCommand();
    return;
  }

  if (command === 'run') {
    await runRunCommand(args);
    return;
  }

  if (command === 'review') {
    await runReviewCommand();
    return;
  }

  throw new Error(`Unknown command: ${command}`);
}

module.exports = {
  main,
};
