// The Redis-backed queue: a documented seam, not an implementation.
//
// S04 only needs to *produce* jobs, and BullMQ is not installed yet
// (`bullmq` is deliberately absent from server/package.json until S08 adds
// the workers that consume these queues). Rather than pretend, this factory
// throws a clear error, so a misconfigured environment fails loudly at
// start-up instead of silently dropping a manager notification.
//
// When S08 lands, the only change here is:
//   import { Queue } from 'bullmq';
//   const queues = new Map<QueueName, Queue>();
//   ... new Queue(name, { connection: { url: options.redisUrl }, prefix: QUEUE_PREFIX })
// The rest of the server keeps talking to the JobQueue interface, and
// QUEUE_PREFIX / QUEUE_NAMES stay the single source of the Redis key names
// (prefix 'academy', plain names, never a ':' inside a name).

import { QUEUE_PREFIX } from './names.js';
import type { JobQueue } from './queue.js';

export interface BullQueueOptions {
  redisUrl: string;
  /** Always QUEUE_PREFIX; exposed so a test copy can namespace its keys. */
  prefix?: string;
}

export function createBullQueue(options: BullQueueOptions): JobQueue {
  void options.redisUrl;
  void (options.prefix ?? QUEUE_PREFIX);
  throw new Error(
    'BullMQ arrives in S08: createBullQueue() is a seam, not an implementation. ' +
      'Until then leave REDIS_URL unset for the in-memory queue, or wire the real ' +
      'queue in server/src/queues/bull.ts.',
  );
}
