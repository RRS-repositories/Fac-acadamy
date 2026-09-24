// The Redis-backed queue (S08). One `Queue` per name, all of them sharing a
// single ioredis connection, all of them under prefix 'academy'.
//
// Two rules from CLAUDE.md are enforced here rather than trusted:
//
//   * queue names never contain ':' — BullMQ 6 throws on one (it builds its
//     keys as `<prefix>:<name>:<...>`), so the build spec's
//     `academy:signin-events` is prefix 'academy' + name 'signin-events'.
//     assertQueueName() runs on every add().
//   * `maxRetriesPerRequest: null` on the connection, which BullMQ requires:
//     a blocking BRPOPLPUSH must not be abandoned after N retries.
//
// Defaults for every job: 5 attempts, exponential backoff from 2 s, completed
// jobs trimmed to a small window, failed jobs KEPT (they are the evidence a
// dead-letter entry points back at).

import { Queue } from 'bullmq';
import { Redis } from 'ioredis';
import type { JobsOptions, RedisOptions } from 'bullmq';
import { QUEUE_PREFIX, assertQueueName } from './names.js';
import type { QueueName } from './names.js';
import type { JobQueue } from './queue.js';

/** Applied to every job unless the producer overrides it. */
export const DEFAULT_JOB_OPTIONS: JobsOptions = {
  attempts: 5,
  backoff: { type: 'exponential', delay: 2_000 },
  // Bounded history: enough to debug this morning, not a growing Redis bill.
  removeOnComplete: { age: 24 * 60 * 60, count: 1_000 },
  // Failures are kept. The dead-letter entry records the payload separately,
  // but the failed job itself carries BullMQ's own stack trace.
  removeOnFail: false,
};

export interface BullQueueOptions {
  redisUrl: string;
  /** Always QUEUE_PREFIX; exposed so a test copy can namespace its keys. */
  prefix?: string;
  /** Share an existing connection (the worker process does this). */
  connection?: Redis;
  /** Override the defaults above, e.g. fewer attempts in a test. */
  defaultJobOptions?: JobsOptions;
}

/** A JobQueue that also hands out the BullMQ pieces the worker needs. */
export interface BullJobQueue extends JobQueue {
  readonly connection: Redis;
  readonly prefix: string;
  /** The `Queue` for one name, created on first use. */
  queueFor(name: QueueName): Queue;
  /** PING. False when Redis is unreachable; never throws. */
  ping(): Promise<boolean>;
}

/**
 * An ioredis client configured the way BullMQ needs it.
 *
 * `maxRetriesPerRequest: null` is not optional: BullMQ's blocking reads would
 * otherwise be killed by ioredis' retry ceiling. The URL is never logged — it
 * can carry a password.
 */
export function createQueueRedis(url: string, extra: RedisOptions = {}): Redis {
  // ioredis does not reject a nonsense URL: anything it cannot parse is taken
  // as a socket path, and the mistake only shows up as a connection that never
  // comes up. A wrong scheme in REDIS_URL is a configuration error, so it is
  // refused here, at start-up, where the message can name the variable.
  assertRedisUrl(url);
  const client = new Redis(url, {
    maxRetriesPerRequest: null,
    enableReadyCheck: true,
    lazyConnect: true,
    connectTimeout: 5_000,
    ...extra,
  });
  // Without a listener ioredis prints every reconnect failure. Log each
  // distinct error once, until the connection recovers.
  let lastError = '';
  client.on('error', (err: Error) => {
    if (err.message !== lastError) {
      lastError = err.message;
      console.error(`[academy-queues] redis: ${err.message}`);
    }
  });
  client.on('ready', () => {
    lastError = '';
  });
  return client;
}

/** How long a start-up PING and a shutdown QUIT may take before we give up. */
const PING_TIMEOUT_MS = 3_000;
const QUIT_TIMEOUT_MS = 3_000;

/** Run `work`, but answer `fallback` if it has not finished in `ms`. */
async function withDeadline<T>(ms: number, fallback: T, work: () => Promise<T>): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const deadline = new Promise<T>((resolve) => {
    timer = setTimeout(() => resolve(fallback), ms);
    timer.unref();
  });
  try {
    return await Promise.race([work().catch(() => fallback), deadline]);
  } finally {
    clearTimeout(timer);
  }
}

/** The schemes ioredis understands. Anything else is a typo, not a host. */
const REDIS_SCHEMES = new Set(['redis:', 'rediss:', 'unix:']);

export function assertRedisUrl(url: string): void {
  let scheme: string;
  try {
    scheme = new URL(url).protocol;
  } catch {
    throw new Error(`REDIS_URL is not a URL (expected redis://host:port, got ${describe(url)})`);
  }
  if (!REDIS_SCHEMES.has(scheme)) {
    throw new Error(`REDIS_URL has the wrong scheme ${scheme} (expected redis:// or rediss://)`);
  }
}

/** A URL can carry a password, so only its shape is ever put in a message. */
function describe(url: string): string {
  return `${String(url.length)} characters`;
}

export class RedisUnavailableError extends Error {
  constructor(cause: string) {
    super(`Redis is not reachable: ${cause}`);
    this.name = 'RedisUnavailableError';
  }
}

/**
 * The real queue. Queues are created lazily, so a process that only ever
 * enqueues manager notifications does not open seven sets of Redis keys.
 */
export function createBullQueue(options: BullQueueOptions): BullJobQueue {
  const prefix = options.prefix ?? QUEUE_PREFIX;
  const connection = options.connection ?? createQueueRedis(options.redisUrl);
  const defaultJobOptions = { ...DEFAULT_JOB_OPTIONS, ...options.defaultJobOptions };
  const ownsConnection = options.connection === undefined;
  const queues = new Map<QueueName, Queue>();

  function queueFor(name: QueueName): Queue {
    assertQueueName(name);
    let queue = queues.get(name);
    if (queue === undefined) {
      queue = new Queue(name, { connection, prefix, defaultJobOptions });
      // A Queue with no error listener makes a Redis blip an unhandled 'error'
      // event, which kills the process.
      queue.on('error', (err: Error) => {
        console.error(`[academy-queues] queue ${name}: ${err.message}`);
      });
      queues.set(name, queue);
    }
    return queue;
  }

  return {
    connection,
    prefix,
    queueFor,

    async add(queue, name, data, opts = {}) {
      assertQueueName(queue);
      const jobOptions: JobsOptions = {
        ...(opts.jobId !== undefined && { jobId: opts.jobId }),
        ...(opts.attempts !== undefined && { attempts: opts.attempts }),
        ...(opts.delayMs !== undefined && { delay: opts.delayMs }),
      };
      // BullMQ de-duplicates on jobId by itself: a second add() with a jobId
      // that already exists returns the existing job and enqueues nothing.
      await queueFor(queue).add(name, data, jobOptions);
    },

    async ping() {
      // ioredis retries a refused connection for ever and, with
      // maxRetriesPerRequest null, queues the PING behind it — so without a
      // deadline this start-up check would hang instead of answering "no".
      return await withDeadline(PING_TIMEOUT_MS, false, async () => {
        if (connection.status === 'wait') await connection.connect();
        return (await connection.ping()) === 'PONG';
      });
    },

    async close() {
      await Promise.all([...queues.values()].map((queue) => queue.close()));
      queues.clear();
      // Only close a connection this queue opened: the worker process shares
      // one and closes it itself, after its workers have stopped.
      if (!ownsConnection) return;
      // QUIT waits for a reply, which never comes from a Redis that is down.
      const quit = await withDeadline(QUIT_TIMEOUT_MS, false, async () => {
        await connection.quit();
        return true;
      });
      if (!quit) connection.disconnect();
    },
  };
}
