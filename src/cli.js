const { runAddCommand } = require('./commands/add');
const { runRunCommand } = require('./commands/run');
const { runReviewCommand } = require('./commands/review');
const { runInspectCommand } = require('./commands/inspect');

const HELP_TEXT = `msv <command> [options]

Commands:
  add                Read idea text from stdin, capture as a pending idea
  run --all          Run the investigation pipeline on every pending idea
  run <id>           Run the investigation pipeline on a single idea
  review             Step through ready investigations one at a time
  inspect <id>       Boot the local visual inspector for an investigation
`;

async function main(argv = process.argv.slice(2)) {
  const [command, ...args] = argv;

  if (!command || command === '--help' || command === '-h') {
    process.stdout.write(HELP_TEXT);
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

  if (command === 'inspect') {
    await runInspectCommand(args);
    return;
  }

  process.stderr.write(`Unknown command: ${command}\n${HELP_TEXT}`);
  process.exitCode = 1;
}

module.exports = {
  main,
};
