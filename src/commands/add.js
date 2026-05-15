const { createIdea, writeIdea, ensureStorageDirs } = require('../storage');

async function readStdin() {
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
    throw new Error('No idea text received on stdin');
  }

  const idea = createIdea(rawCapture);
  await writeIdea(idea);
  process.stdout.write(`${idea.id}\n`);
}

module.exports = {
  runAddCommand,
};
