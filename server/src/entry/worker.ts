// academy-worker: the background job process (S08).
//
// It consumes every queue that has a handler, parks jobs that exhaust their
// attempts in the dead-letter bay, and shuts down gracefully: on SIGTERM or
// SIGINT it stops taking new work, lets the jobs already running finish, then
// closes Redis and Postgres. A second signal stops waiting and exits.
//
// It is NOT the API. Nothing here listens on a port. Run it beside the API
// (`npm run start:worker -w @fac-academy/server`, or a second pm2 process).
//
// Redis is required: a worker with an in-memory queue would consume nothing
// and still look healthy, so a missing REDIS_URL is a refusal to start.

import {
  closeCertificateRenderer,
  createCertificateIssuer,
  createCertificateJobHandler,
} from '../certs/index.js';
import { loadDotenvIfPresent } from '../config/dotenv.js';
import { ConfigError, loadConfig } from '../config/env.js';
import type { Config } from '../config/env.js';
import { createPool } from '../db/pool.js';
import { createHandlers } from '../jobs/handlers.js';
import { createLocalMediaStore } from '../media/store.js';
import {
  createNotificationRules,
  createManagerRecipients,
  createNotifier,
} from '../modules/notifications/index.js';
import type { BullJobQueue } from '../queues/bull.js';
import { createDeadLetterStore } from '../queues/deadLetter.js';
import { requireBullQueue } from '../queues/index.js';
import { consoleLogger } from '../queues/logging.js';
import { createWorkerRuntime } from '../queues/runtime.js';

const log = consoleLogger('academy-worker');

try {
  loadDotenvIfPresent();
} catch (err) {
  console.error(`[academy-worker] Refusing to start: ${(err as Error).message}`);
  process.exit(1);
}

let config: Config;
try {
  config = loadConfig();
} catch (err) {
  if (err instanceof ConfigError) {
    console.error(`[academy-worker] Refusing to start: ${err.message}`);
    process.exit(1);
  }
  throw err;
}

// An unhandled rejection anywhere in a handler must not leave a half-dead
// process quietly not consuming anything. Log it and stop; the supervisor
// restarts us and BullMQ re-delivers whatever was in flight.
process.on('unhandledRejection', (reason: unknown) => {
  const message = reason instanceof Error ? (reason.stack ?? reason.message) : String(reason);
  console.error(`[academy-worker] unhandled rejection, stopping: ${message}`);
  void stop('unhandledRejection', 1);
});
process.on('uncaughtException', (err: Error) => {
  console.error(`[academy-worker] uncaught exception, stopping: ${err.stack ?? err.message}`);
  void stop('uncaughtException', 1);
});

const pool = createPool(config);

function openQueue(): BullJobQueue {
  try {
    return requireBullQueue(config.REDIS_URL);
  } catch (err) {
    console.error(`[academy-worker] Refusing to start: ${(err as Error).message}`);
    process.exit(1);
  }
}

const queue = openQueue();

if (!(await queue.ping())) {
  console.error(
    '[academy-worker] Refusing to start: REDIS_URL is set but Redis did not answer PING.',
  );
  process.exit(1);
}

const deadLetter = createDeadLetterStore(queue);

// Delivery seam: shadow by default. Nothing is sent until a provider is
// chosen and Brad signs it off.
const notifier = createNotifier({ mode: config.ACADEMY_NOTIFY_MODE, db: pool, logger: log });
const rules = createNotificationRules({
  db: pool,
  notifier,
  // Documented default: every MANAGER account. See notifications/recipients.ts
  // for the one-function swap to a per-trainee manager.
  recipients: createManagerRecipients(pool),
  logger: log,
});

// S09: the certificate renderer. The PDFs are stored beside the media, under
// MEDIA_ROOT (D15), and Chromium is launched lazily by the first job and
// closed in stop() below.
const certificates = createCertificateJobHandler({
  db: pool,
  issuer: createCertificateIssuer({
    db: pool,
    store: createLocalMediaStore(config.MEDIA_ROOT),
    publicBaseUrl: config.PUBLIC_BASE_URL,
  }),
  publicBaseUrl: config.PUBLIC_BASE_URL,
});

const runtime = createWorkerRuntime({
  queue,
  handlers: createHandlers({ rules, logger: log, certificates }),
  deadLetter,
  logger: log,
});

await runtime.ready();

const parked = await deadLetter.count().catch(() => -1);
log.info(
  `started: ${String(runtime.workers.size)} queues (${[...runtime.workers.keys()].join(', ')})` +
    `, prefix '${queue.prefix}', notify mode '${notifier.mode}'` +
    `, dead-letter ${parked < 0 ? 'unreadable' : String(parked)}`,
);

let stopping = false;

async function stop(signal: string, code = 0): Promise<void> {
  if (stopping) {
    console.error(`[academy-worker] ${signal} again: exiting now, jobs in flight will be retried`);
    process.exit(code === 0 ? 1 : code);
  }
  stopping = true;
  log.info(`${signal} received: no new jobs, finishing what is running`);
  try {
    // close(false): stop taking work, wait for running jobs.
    await runtime.close(false);
    // A render must never leave a browser running.
    await closeCertificateRenderer();
    await queue.close();
    await queue.connection.quit().catch(() => queue.connection.disconnect());
    await pool.end();
    log.info('stopped cleanly');
  } catch (err) {
    console.error(`[academy-worker] error while stopping: ${(err as Error).message}`);
    process.exit(1);
  }
  process.exit(code);
}

process.once('SIGTERM', () => void stop('SIGTERM'));
process.once('SIGINT', () => void stop('SIGINT'));
// Windows has no SIGTERM; Ctrl+Break is how a console process is asked to stop
// there. Harmless everywhere else.
process.once('SIGBREAK', () => void stop('SIGBREAK'));
