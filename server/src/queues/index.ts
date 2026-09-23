// Picking a queue implementation. One rule: no REDIS_URL, no Redis — the
// in-memory queue takes over, so local development and the test suite run
// without Redis and without pretending a job was sent somewhere real.

import { createBullQueue } from './bull.js';
import { createInMemoryQueue } from './queue.js';
import type { JobQueue } from './queue.js';

export { QUEUE_NAMES, QUEUE_PREFIX, ALL_QUEUE_NAMES, assertQueueName } from './names.js';
export type { QueueName } from './names.js';
export { createInMemoryQueue } from './queue.js';
export type { EnqueuedJob, InMemoryJobQueue, JobOptions, JobQueue } from './queue.js';
export { createBullQueue } from './bull.js';
export { createProducers } from './producers.js';
export type { Producers } from './producers.js';

export interface JobQueueOptions {
  /** config.REDIS_URL. Undefined or empty selects the in-memory queue. */
  redisUrl?: string | undefined;
}

export function createJobQueue(options: JobQueueOptions = {}): JobQueue {
  const url = options.redisUrl?.trim();
  if (url === undefined || url === '') return createInMemoryQueue();
  return createBullQueue({ redisUrl: url });
}
