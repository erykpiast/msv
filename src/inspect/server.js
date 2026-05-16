const fs = require('node:fs/promises');
const path = require('node:path');

function viewMiddlewarePlugin(ideaDir) {
  // A Vite plugin's configureServer hook lets us register middlewares
  // BEFORE Vite's built-in SPA fallback / static handler. Without this,
  // /inspect-view.json gets caught by index.html fallback.
  return {
    name: 'msv-inspect-view-middleware',
    configureServer(server) {
      server.middlewares.use('/inspect-view.json', async (req, res) => {
        if (req.method !== 'GET' && req.method !== 'HEAD') {
          res.statusCode = 405;
          res.setHeader('Allow', 'GET, HEAD');
          res.end();
          return;
        }
        try {
          const body = await fs.readFile(path.join(ideaDir, 'inspect-view.json'));
          res.setHeader('Content-Type', 'application/json');
          res.setHeader('Cache-Control', 'no-store');
          res.end(body);
        } catch (err) {
          // Generic message — `err.message` would leak the absolute ideaDir path.
          process.stderr.write(`inspect-view.json read failed: ${err.message}\n`);
          res.statusCode = 500;
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify({ error: 'failed to read inspect-view.json' }));
        }
      });
    },
  };
}

async function startInspectServer({ ideaDir, port }) {
  // Lazy-require so the rest of the CLI doesn't pay Vite's import cost.
  const { createServer } = require('vite');
  const repoRoot = path.resolve(__dirname, '..', '..');

  const server = await createServer({
    root: repoRoot,
    configFile: path.join(repoRoot, 'vite.config.ts'),
    plugins: [viewMiddlewarePlugin(ideaDir)],
    server: {
      port: typeof port === 'number' ? port : 5180,
      strictPort: typeof port === 'number',
      host: '127.0.0.1',
      fs: { allow: [ideaDir, repoRoot] },
    },
  });

  await server.listen();
  return server;
}

module.exports = { startInspectServer };
