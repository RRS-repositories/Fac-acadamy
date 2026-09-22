// Background worker. Queues arrive in later sections: BullMQ with
// prefix 'academy' and plain queue names (BullMQ throws on names containing ':').
import { loadDotenvIfPresent } from '../config/dotenv.js';
import { ConfigError, loadConfig } from '../config/env.js';

loadDotenvIfPresent();

try {
  loadConfig();
} catch (err) {
  if (err instanceof ConfigError) {
    console.error(`[academy-worker] Refusing to start: ${err.message}`);
    process.exit(1);
  }
  throw err;
}

console.log('[academy-worker] started; no queues registered yet (they arrive in later sections)');

// Nothing is listening yet, so hold the event loop open until we are told to stop.
const keepAlive = setInterval(() => {}, 60 * 60 * 1000);

function shutdown(signal: NodeJS.Signals): void {
  console.log(`[academy-worker] ${signal} received, stopping`);
  clearInterval(keepAlive);
  process.exit(0);
}

process.once('SIGTERM', shutdown);
process.once('SIGINT', shutdown);
