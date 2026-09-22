import { createApp } from '../app.js';

// S01 replaces this with zod-validated config (config/env.ts) that refuses to
// start when a required variable is missing.
const port = Number(process.env.PORT ?? 4100);
const host = process.env.HOST ?? '127.0.0.1';

const server = createApp().listen(port, host, () => {
  console.log(`[academy-api] listening on http://${host}:${port}`);
});

function shutdown(signal: NodeJS.Signals): void {
  console.log(`[academy-api] ${signal} received, closing`);
  server.close((err) => {
    if (err) {
      console.error('[academy-api] error while closing', err);
      process.exit(1);
    }
    process.exit(0);
  });
}

process.once('SIGTERM', shutdown);
process.once('SIGINT', shutdown);
