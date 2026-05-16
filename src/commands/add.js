const { createIdea, writeIdea, ensureStorageDirs } = require('../storage');

async function readStdin() {
  if (process.stdin.isTTY) {
    process.stderr.write('msv: reading idea from stdin (Ctrl-D to end)\n');
  }
  const chunks = [];
  for await (const chunk of process.stdin) {
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8').trim();
}

async function runAddCommand() {
  await ensureStorageDirs();
  const rawCapture = await readStdin();
  if (!rawCapture) {
    process.stderr.write('no input\n');
    process.exitCode = 1;
    return;
  }

  const idea = createIdea(rawCapture);
  await writeIdea(idea);
  process.stdout.write(`captured ${idea.id}\n`);
}

module.exports = {
  runAddCommand,
};
