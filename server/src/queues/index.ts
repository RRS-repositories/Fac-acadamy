// Picking a queue implementation.
//
// Decision (S08): the API must keep serving even when Redis is having a bad
// morning, but it must never quietly throw work away in production.
//
//   * REDIS_URL unset        → the in-memory queue. Development and tests.
//   * REDIS_URL set, Redis up → BullMQ. The real thing.
//   * REDIS_URL set, Redis down:
//       - NODE_ENV !== 'production' → log loudly, degrade to in-memory, so a
//         laptop without Memurai/Redis running still boots.
//       - NODE_ENV === 'production' → throw. A production API that enqueued
//         manager notifications into a process-local array would look healthy
//         and deliver nothing.
//
// Note that ioredis reconnects by itself, so "Redis down" here means only
// "down at start-up". Once the BullMQ queue is chosen it stays chosen and
// rides out later outages.

import { createBullQueue, createQueueRedis } from './bull.js';
import type { BullJobQueue } from './bull.js';
import { createInMemoryQueue } from './queue.js';
import type { JobQueue } from './queue.js';

export {
  QUEUE_NAMES,
  QUEUE_PREFIX,
  ALL_QUEUE_NAMES,
  WORK_QUEUE_NAMES,
  DEAD_LETTER_QUEUE,
  assertQueueName,
} from './names.js';
export type { QueueName } from './names.js';
export { createInMemoryQueue } from './queue.js';
export type { EnqueuedJob, InMemoryJobQueue, JobOptions, JobQueue } from './queue.js';
export {
  assertRedisUrl,
  createBullQueue,
  createQueueRedis,
  DEFAULT_JOB_OPTIONS,
  RedisUnavailableError,
} from './bull.js';
export type { BullJobQueue, BullQueueOptions } from './bull.js';
export { createDeadLetterStore } from './deadLetter.js';
export type { DeadLetterEntry, DeadLetterRecord, DeadLetterStore } from './deadLetter.js';
export { createWorkerRuntime, DEFAULT_CONCURRENCY } from './runtime.js';
export type { JobContext, JobHandler, JobHandlers, WorkerRuntime } from './runtime.js';
export { createRedisOnceMarker, runOnce } from './once.js';
export type { OnceMarker } from './once.js';
export { consoleLogger, silentLogger } from './logging.js';
export type { QueueLogger } from './logging.js';
export { createProducers } from './producers.js';
export type { Producers } from './producers.js';

export interface JobQueueOptions {
  /** config.REDIS_URL. Undefined or empty selects the in-memory queue. */
  redisUrl?: string | undefined;
  /** config.NODE_ENV. 'production' turns an unreachable Redis into a refusal. */
  nodeEnv?: string | undefined;
}

/**
 * The queue the API process uses. Synchronous on purpose: nothing here waits
 * for a TCP connection, so start-up is not held up by Redis. The connection is
 * opened lazily and `createJobQueue` only fails when the *configuration* is
 * unusable.
 */
export function createJobQueue(options: JobQueueOptions = {}): JobQueue {
  const url = options.redisUrl?.trim();
  if (url === undefined || url === '') return createInMemoryQueue();
  try {
    return createBullQueue({ redisUrl: url });
  } catch (err) {
    const message = (err as Error).message;
    if (options.nodeEnv === 'production') {
      // Fail fast: an in-memory queue in production would lose every manager
      // notification on the next restart and nobody would notice.
      throw new Error(
        `[academy-queues] REDIS_URL is set but the Redis-backed queue could not be created (${message}). ` +
          'Refusing to fall back to the in-memory queue in production.',
      );
    }
    console.warn(
      `[academy-queues] the Redis-backed queue could not be created (${message}). ` +
        'Falling back to the in-memory queue: jobs are lost if this process restarts. ' +
        'This fallback is development-only; production refuses to start instead.',
    );
    return createInMemoryQueue();
  }
}

/**
 * Is the chosen queue actually usable? Call this once, at start-up, after
 * createJobQueue().
 *
 * In production an unreachable Redis is fatal: the API would otherwise come up
 * healthy and drop every manager notification. Everywhere else it is a loud
 * warning. Once the process is running, ioredis reconnects by itself, so a
 * later outage does not stop the API serving pages — only a Redis that is down
 * at boot stops it starting.
 */
export async function verifyJobQueue(
  queue: JobQueue,
  options: { nodeEnv?: string | undefined; logger?: (message: string) => void } = {},
): Promise<boolean> {
  const warn = options.logger ?? ((message: string) => console.warn(message));
  if (!('ping' in queue)) return false; // the in-memory queue: nothing to check
  if (await (queue as BullJobQueue).ping()) return true;
  const message =
    '[academy-queues] REDIS_URL is set but Redis did not answer PING. ' +
    'Background jobs (manager notifications, media follow-up) will not run until it does.';
  if (options.nodeEnv === 'production') throw new Error(message);
  warn(message);
  return false;
}

/**
 * The worker process's queue: BullMQ or nothing. A worker with an in-memory
 * queue would consume nothing and look fine, so this throws instead.
 */
export function requireBullQueue(redisUrl: string | undefined): ReturnType<typeof createBullQueue> {
  const url = redisUrl?.trim();
  if (url === undefined || url === '') {
    throw new Error(
      'REDIS_URL is not set. The background worker has nothing to consume without Redis.',
    );
  }
  const connection = createQueueRedis(url);
  return createBullQueue({ redisUrl: url, connection });
}
