// The one queue interface the rest of the server codes against.
//
// BullMQ is not a dependency yet (it arrives with the workers in S08), so the
// seam lives here: producers call `JobQueue.add(...)` and never import
// bullmq. Today the only implementation that runs is the in-memory one, which
// records what was enqueued so tests can assert the payload. `createBullQueue`
// in bull.ts is the documented slot the Redis-backed version drops into.

import { assertQueueName } from './names.js';
import type { QueueName } from './names.js';

export interface JobOptions {
  /** De-duplication key: adding the same jobId twice is one job in BullMQ. */
  jobId?: string;
  attempts?: number;
  delayMs?: number;
}

export interface EnqueuedJob<T = unknown> {
  queue: QueueName;
  /** The job name inside the queue, e.g. 'level-complete'. */
  name: string;
  data: T;
  opts: JobOptions;
  enqueuedAt: number;
}

export interface JobQueue {
  add(queue: QueueName, name: string, data: unknown, opts?: JobOptions): Promise<void>;
  close(): Promise<void>;
}

export interface InMemoryJobQueue extends JobQueue {
  /** Everything enqueued since the last clear(), oldest first. */
  readonly jobs: readonly EnqueuedJob[];
  /** Jobs on one queue, narrowed to the payload type the caller expects. */
  jobsOn<T>(queue: QueueName): EnqueuedJob<T>[];
  clear(): void;
}

export interface InMemoryQueueOptions {
  now?: () => number;
}

/**
 * Development and test queue. Jobs are kept in an array and never executed:
 * the consumers land in S08. Used automatically when REDIS_URL is unset, so
 * `npm run dev` works without Redis and an API test can assert that passing
 * Level 1 enqueued exactly one manager-notify job with the right payload.
 *
 * `jobId` is honoured the way BullMQ honours it: a second add() with a jobId
 * already present is ignored, so a retried request cannot double-notify.
 */
export function createInMemoryQueue(options: InMemoryQueueOptions = {}): InMemoryJobQueue {
  const now = options.now ?? Date.now;
  const jobs: EnqueuedJob[] = [];
  const seen = new Set<string>();

  return {
    jobs,
    // async so an illegal queue name comes back as a rejected promise, the
    // way a real BullMQ add() would fail, not as a synchronous throw.
    async add(queue, name, data, opts = {}) {
      assertQueueName(queue);
      if (opts.jobId !== undefined) {
        const key = `${queue}/${opts.jobId}`;
        if (seen.has(key)) return;
        seen.add(key);
      }
      jobs.push({ queue, name, data, opts, enqueuedAt: now() });
    },
    jobsOn<T>(queue: QueueName): EnqueuedJob<T>[] {
      return jobs.filter((job) => job.queue === queue) as EnqueuedJob<T>[];
    },
    clear() {
      jobs.length = 0;
      seen.clear();
    },
    close() {
      return Promise.resolve();
    },
  };
}
