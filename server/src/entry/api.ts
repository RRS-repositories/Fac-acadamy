import { createApp } from '../app.js';
import { loadDotenvIfPresent } from '../config/dotenv.js';
import { ConfigError, loadConfig } from '../config/env.js';
import type { Config } from '../config/env.js';
import { checkDb, createPool } from '../db/pool.js';
import { checkRedis, createRedis } from '../integrations/redis.js';

loadDotenvIfPresent();

let config: Config;
try {
  config = loadConfig();
} catch (err) {
  if (err instanceof ConfigError) {
    console.error(`[academy-api] Refusing to start: ${err.message}`);
    process.exit(1);
  }
  throw err;
}

const pool = createPool(config);
const redis = createRedis(config.REDIS_URL);

const app = createApp({
  flagEnabled: config.ACADEMY_V2,
  checkDb: () => checkDb(pool),
  checkRedis: () => checkRedis(redis),
});

const server = app.listen(config.PORT, config.HOST, () => {
  console.log(
    `[academy-api] listening on http://${config.HOST}:${config.PORT}` +
      ` (NODE_ENV=${config.NODE_ENV}, ACADEMY_V2=${config.ACADEMY_V2},` +
      ` redis ${redis ? 'configured' : 'not configured'})`,
  );
});

let closing = false;
function shutdown(signal: NodeJS.Signals): void {
  if (closing) return;
  closing = true;
  console.log(`[academy-api] ${signal} received, closing`);
  server.close((serverErr) => {
    redis?.disconnect();
    pool.end().then(
      () => process.exit(serverErr ? 1 : 0),
      (poolErr: unknown) => {
        console.error('[academy-api] error while closing the database pool', poolErr);
        process.exit(1);
      },
    );
    if (serverErr) console.error('[academy-api] error while closing', serverErr);
  });
}

process.once('SIGTERM', shutdown);
process.once('SIGINT', shutdown);
