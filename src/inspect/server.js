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

function liveMiddlewarePlugin({ ideaDir, ideaId }) {
  return {
    name: 'msv-inspect-live',
    async configureServer(server) {
      const { createBroker } = require('./live/eventBroker');
      const { createViewRebuilder } = require('./live/viewRebuilder');
      const { seedBrokerFromDisk } = require('./live/seed');

      const broker = createBroker({ ideaId });
      const rebuilder = createViewRebuilder({ ideaDir, broker });

      // ORDERING INVARIANT: seed completes BEFORE middlewares register.
      // Moving middleware registration above this await breaks the invariant.
      await seedBrokerFromDisk({ ideaDir, broker, ideaId });
      await rebuilder.flushNow();

      server.middlewares.use('/events', (req, res) => {
        if (req.method === 'POST') {
          let body = '';
          let bytesReceived = 0;
          let aborted = false;
          req.on('error', () => {}); // absorb ECONNRESET from destroy()
          req.on('data', (chunk) => {
            if (aborted) return;
            bytesReceived += chunk.length; // Buffer.length is always byte count
            if (bytesReceived > 1_000_000) {
              aborted = true;
              res.statusCode = 413;
              res.end();
              req.destroy();
              return;
            }
            body += chunk;
          });
          req.on('end', () => {
            if (aborted) return;
            try {
              const env = JSON.parse(body);
              const ok = broker.publishEvent(env);
              if (ok) {
                if (env.name === 'pipeline.complete' || env.name === 'pipeline.failed') {
                  void rebuilder.flushNow();
                } else {
                  rebuilder.requestRebuild();
                }
              }
            } catch {
              // Drop malformed.
            }
            res.statusCode = 204;
            res.end();
          });
          return;
        }
        res.statusCode = 405;
        res.end();
      });

      server.middlewares.use('/events/stream', (req, res) => {
        if (req.method !== 'GET') {
          res.statusCode = 405;
          res.end();
          return;
        }
        res.statusCode = 200;
        res.setHeader('Content-Type', 'text/event-stream');
        res.setHeader('Cache-Control', 'no-store');
        res.setHeader('Connection', 'keep-alive');
        res.flushHeaders?.();
        const unsubscribe = broker.subscribe(res);
        res.on('close', unsubscribe);
      });
    },
  };
}

async function startInspectServer({ ideaDir, ideaId, port }) {
  // Lazy-require so the rest of the CLI doesn't pay Vite's import cost.
  const { createServer } = require('vite');
  const repoRoot = path.resolve(__dirname, '..', '..');

  const server = await createServer({
    root: repoRoot,
    configFile: path.join(repoRoot, 'vite.config.ts'),
    plugins: [
      viewMiddlewarePlugin(ideaDir),
      liveMiddlewarePlugin({ ideaDir, ideaId }),
    ],
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
