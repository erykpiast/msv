const path = require('node:path');
const fs = require('node:fs/promises');
const {
  ideaDir,
  archivedIdeaDir,
  atomicWriteText,
} = require('../storage');
const { buildLoaderInput } = require('../inspect/loader');
const { buildView } = require('../inspect/view/build');
const { startInspectServer } = require('../inspect/server');
const { openBrowser } = require('../inspect/openBrowser');

function parseArgs(args) {
  let id = null;
  let noOpen = false;
  let port = null;

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === '--no-open') {
      noOpen = true;
      continue;
    }
    if (arg === '--port') {
      const next = args[i + 1];
      if (!next || Number.isNaN(Number(next))) {
        return { error: '--port requires a numeric value' };
      }
      port = Number(next);
      i += 1;
      continue;
    }
    if (arg.startsWith('--port=')) {
      const value = arg.slice('--port='.length);
      if (Number.isNaN(Number(value))) {
        return { error: '--port requires a numeric value' };
      }
      port = Number(value);
      continue;
    }
    if (arg.startsWith('--')) {
      return { error: `Unknown flag: ${arg}` };
    }
    if (id !== null) {
      return { error: 'Only one idea id is supported per invocation' };
    }
    id = arg;
  }

  if (!id) return { error: 'idea id is required' };
  return { id, noOpen, port };
}

async function resolveIdeaDir(id) {
  for (const dir of [ideaDir(id), archivedIdeaDir(id)]) {
    try {
      await fs.access(path.join(dir, 'index.json'));
      return dir;
    } catch {
      // Try next candidate.
    }
  }
  return null;
}

async function runInspectCommand(args) {
  const opts = parseArgs(args);
  if (opts.error) {
    process.stderr.write(`${opts.error}\nUsage: msv inspect <id> [--no-open] [--port <n>]\n`);
    process.exitCode = 1;
    return;
  }

  const resolvedDir = await resolveIdeaDir(opts.id);
  if (!resolvedDir) {
    process.stderr.write(`idea not found: ${opts.id}\n`);
    process.exitCode = 1;
    return;
  }

  let view;
  try {
    const loaderInput = await buildLoaderInput(resolvedDir);
    view = buildView(loaderInput);
  } catch (err) {
    process.stderr.write(`view build error: ${err.message}\n`);
    process.exitCode = 2;
    return;
  }

  const outPath = path.join(resolvedDir, 'inspect-view.json');
  try {
    await atomicWriteText(outPath, `${JSON.stringify(view, null, 2)}\n`);
  } catch (err) {
    process.stderr.write(`failed to write ${outPath}: ${err.message}\n`);
    process.exitCode = 2;
    return;
  }

  const stageCount = view.stages.length;
  const moveCount = Object.values(view.debates).reduce((acc, d) => acc + (d.moves?.length ?? 0), 0);
  const forumNodeCount = view.forum.nodes.length;
  process.stdout.write(
    `→ built view: ${stageCount} stages, ${moveCount} moves, ${forumNodeCount} forum nodes\n`
  );
  process.stdout.write(`→ wrote ${outPath}\n`);

  let server;
  try {
    server = await startInspectServer({ ideaDir: resolvedDir, port: opts.port });
  } catch (err) {
    process.stderr.write(`vite failed to start: ${err.message}\n`);
    if (err.code === 'EADDRINUSE') {
      process.stderr.write('Try a different port with: msv inspect <id> --port <n>\n');
    }
    process.exitCode = 3;
    return;
  }

  const address = server.httpServer?.address?.();
  const port = typeof address === 'object' && address ? address.port : opts.port;
  const url = `http://localhost:${port}/?id=${encodeURIComponent(opts.id)}`;
  process.stdout.write(`→ Vite dev server ready on ${url}\n`);

  // Trigger Vite's dep pre-bundling before opening the browser so the user
  // doesn't see a blank page during the 2–4s cold-bundle on first run.
  if (typeof server.warmupRequest === 'function') {
    try {
      await server.warmupRequest('/src/inspect-app/main.tsx');
    } catch {
      // Warmup is best-effort; the browser will still bundle on first load.
    }
  }

  if (!opts.noOpen) {
    openBrowser(url);
    process.stdout.write('→ opened browser\n');
  }
  process.stdout.write('\n  ➜  press Ctrl-C to stop\n');

  await new Promise((resolve) => {
    const shutdown = async () => {
      try {
        await server.close();
      } finally {
        resolve();
      }
    };
    process.once('SIGINT', shutdown);
    process.once('SIGTERM', shutdown);
  });
}

module.exports = { runInspectCommand, parseArgs };
