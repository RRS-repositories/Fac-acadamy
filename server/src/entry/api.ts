import { createApp } from '../app.js';
import { closeCertificateRenderer, createCertificateIssuer } from '../certs/index.js';
import { loadDotenvIfPresent } from '../config/dotenv.js';
import { ConfigError, loadConfig } from '../config/env.js';
import type { Config } from '../config/env.js';
import { checkDb, createPool } from '../db/pool.js';
import { createHttpCrmClient } from '../integrations/crm/crmClient.js';
import type { CrmClient } from '../integrations/crm/crmClient.js';
import { createMockCrmClient } from '../integrations/crm/mockCrm.js';
import { checkRedis, createRedis } from '../integrations/redis.js';
import { ensureMediaRoot } from '../media/root.js';
import { createLocalMediaStore } from '../media/store.js';
import { createLoginLimiters } from '../modules/auth/limits.js';
import {
  MemoryPendingMfaStore,
  MemorySessionStore,
  RedisPendingMfaStore,
  RedisSessionStore,
  createSessionManager,
} from '../modules/auth/sessions.js';
import { createJobQueue, createProducers, verifyJobQueue } from '../queues/index.js';

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

// Media lives on this server's own disk (D15). The folder has to be there
// before the first request, so it is checked — and created if missing — now,
// and the path is logged once. A folder we cannot use is as fatal as a missing
// environment variable: nothing would stream, and failing here says why.
try {
  const { created } = await ensureMediaRoot(config.MEDIA_ROOT);
  console.log(
    `[academy-api] media root: ${config.MEDIA_ROOT}${created ? ' (created)' : ''}` +
      ` (max upload ${String(config.MEDIA_MAX_UPLOAD_MB)} MB)`,
  );
} catch (err) {
  console.error(`[academy-api] Refusing to start: ${(err as Error).message}`);
  process.exit(1);
}
const mediaStore = createLocalMediaStore(config.MEDIA_ROOT);
// Certificates are stored the same way (D15): under MEDIA_ROOT, in
// academy/certs/, streamed by the API and never served by nginx.

const pool = createPool(config);
const redis = createRedis(config.REDIS_URL);
// Open the connection now so sessions and rate limits work from the first request.
redis?.connect().catch(() => {
  // The client's own 'error' listener logs the cause; it keeps retrying.
});

let crm: CrmClient;
if (config.CRM_AUTH_MODE === 'mock') {
  // Config refuses 'mock' in production; this is the second guard.
  crm = createMockCrmClient();
  const bar = '*'.repeat(60);
  for (const line of [
    bar,
    'MOCK CRM — local development only. Sign-in accepts invented',
    '@example.com accounts (password dev-password). Never use this outside a laptop.',
    bar,
  ]) {
    console.warn(`[academy-api] ${line}`);
  }
} else {
  // Config guarantees the key in http mode.
  crm = createHttpCrmClient({ url: config.CRM_AUTH_URL, key: config.CRM_AUTH_KEY ?? '' });
}

if (redis === null) {
  console.warn('[academy-api] REDIS_URL not set: sessions and rate limits are in memory');
}
const sessionStore = redis ? new RedisSessionStore(redis) : new MemorySessionStore();
const pendingStore = redis ? new RedisPendingMfaStore(redis) : new MemoryPendingMfaStore();

const sessions = createSessionManager({ db: pool, store: sessionStore });

// One queue for the whole API: manager notifications (S04) and the media
// follow-up jobs (S06). With no REDIS_URL this is the in-memory queue, so
// local development runs without Redis and nothing pretends a job was sent.
const jobQueue = createJobQueue({ redisUrl: config.REDIS_URL, nodeEnv: config.NODE_ENV });
// S08: an unreachable Redis is fatal in production (the API would look healthy
// and silently drop every manager notification) and a loud warning everywhere
// else. ioredis reconnects by itself afterwards, so only a Redis that is down
// at boot stops the API starting.
try {
  await verifyJobQueue(jobQueue, { nodeEnv: config.NODE_ENV });
} catch (err) {
  console.error(`[academy-api] Refusing to start: ${(err as Error).message}`);
  process.exit(1);
}

// S09 certificates. The Chromium that renders the PDFs is launched lazily by
// the first certificate and closed in the shutdown path below, so a server
// that never issues one never starts a browser.
const certificateIssuer = createCertificateIssuer({
  db: pool,
  store: mediaStore,
  publicBaseUrl: config.PUBLIC_BASE_URL,
});

const app = createApp({
  flagEnabled: config.ACADEMY_V2,
  provisioningEnabled: config.ACADEMY_PROVISIONING,
  mediaStore,
  mediaUpload: {
    queue: jobQueue,
    maxUploadBytes: config.MEDIA_MAX_UPLOAD_MB * 1024 * 1024,
  },
  checkDb: () => checkDb(pool),
  checkRedis: () => checkRedis(redis),
  auth: {
    db: pool,
    sessions,
    pending: pendingStore,
    crm,
    limiters: createLoginLimiters(redis),
    mfaKey: config.MFA_ENCRYPTION_KEY,
    cookieSecure: config.COOKIE_SECURE,
    now: Date.now,
  },
  training: {
    db: pool,
    sessions,
    cookieSecure: config.COOKIE_SECURE,
    stage1AuthRequired: config.STAGE1_AUTH_REQUIRED,
    // Level and department completions enqueue the manager-notify job.
    producers: createProducers(jobQueue),
    // ... and issue the certificate for the milestone they just completed.
    certificates: certificateIssuer,
  },
  certificates: { db: pool, issuer: certificateIssuer, redis },
});

const server = app.listen(config.PORT, config.HOST, () => {
  console.log(
    `[academy-api] listening on http://${config.HOST}:${config.PORT}` +
      ` (NODE_ENV=${config.NODE_ENV}, ACADEMY_V2=${config.ACADEMY_V2},` +
      ` CRM_AUTH_MODE=${config.CRM_AUTH_MODE},` +
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
    // A render must never leave a browser running: close the shared Chromium
    // before the process goes, and never let that hold the shutdown up.
    void closeCertificateRenderer().catch((err: unknown) => {
      console.error('[academy-api] error while closing the certificate renderer', err);
    });
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
