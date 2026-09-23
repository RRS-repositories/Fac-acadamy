// The dead-letter queue (checklist 08: "dead-letter queue visible and empty
// after tests").
//
// When a job has used up every attempt, the worker writes what it was — queue,
// job name, jobId, payload, the error, when it was enqueued and when it died —
// into the `dead-letter` queue. Nothing consumes that queue: its jobs sit in
// `waiting` so a person can read them, count them and put them back.
//
// Why a BullMQ queue rather than a table: it is durable, it survives a
// restart, it is already namespaced under prefix 'academy', and it needs no
// migration. The payloads that reach it are the same id-and-code payloads the
// producers enqueue — no names, no emails — so a dump of it is not a leak.

import type { Job, Queue } from 'bullmq';
import type { BullJobQueue } from './bull.js';
import { DEAD_LETTER_QUEUE } from './names.js';
import type { QueueName } from './names.js';

export interface DeadLetterEntry {
  /** The queue the job died on. */
  queue: QueueName;
  /** The job name inside that queue, e.g. 'level-complete'. */
  jobName: string;
  /** The job's BullMQ id, which for our producers is the idempotency key. */
  jobId: string | null;
  data: unknown;
  /** The last error message. Stacks are kept on the failed job itself. */
  failedReason: string;
  attemptsMade: number;
  /** Job.timestamp: when it was first enqueued. */
  enqueuedAt: number | null;
  failedAt: number;
}

/** An entry as it comes back out, with the id needed to re-drive or drop it. */
export interface DeadLetterRecord extends DeadLetterEntry {
  /** The dead-letter job's own id. */
  id: string;
}

export interface DeadLetterStore {
  /** Park a job that has exhausted its attempts. */
  record(entry: DeadLetterEntry): Promise<void>;
  /** Everything parked, newest first. */
  list(limit?: number): Promise<DeadLetterRecord[]>;
  count(): Promise<number>;
  /** Put one entry back on its original queue. False when it is already gone. */
  redrive(id: string): Promise<boolean>;
  /** Drop one entry without re-running it. */
  drop(id: string): Promise<boolean>;
  /** Empty the bay. Used by tests and after a deliberate clear-out. */
  clear(): Promise<void>;
}

/** Job states a parked entry can be in: nothing consumes this queue. */
const PARKED_STATES = ['waiting', 'delayed', 'prioritized'] as const;

/**
 * jobIds must not contain ':' (BullMQ builds keys with it), and the id has to
 * be stable so the same failure parked twice is one entry, not two.
 */
function deadLetterJobId(entry: DeadLetterEntry): string {
  const key = entry.jobId ?? `${entry.jobName}-${String(entry.enqueuedAt ?? entry.failedAt)}`;
  return `dl-${entry.queue}-${key}`.replace(/:/g, '-');
}

export function createDeadLetterStore(queue: BullJobQueue): DeadLetterStore {
  const bay = (): Queue => queue.queueFor(DEAD_LETTER_QUEUE);

  function toRecord(job: Job): DeadLetterRecord | null {
    const data = job.data as DeadLetterEntry | undefined;
    if (data === undefined || typeof data.queue !== 'string') return null;
    return { ...data, id: job.id ?? '' };
  }

  return {
    async record(entry) {
      // attempts: 1 and no backoff — a parked job is never retried by BullMQ.
      await bay().add(entry.queue, entry, {
        jobId: deadLetterJobId(entry),
        attempts: 1,
        removeOnComplete: false,
        removeOnFail: false,
      });
    },

    async list(limit = 100) {
      const jobs = await bay().getJobs([...PARKED_STATES], 0, limit - 1, false);
      return jobs
        .map(toRecord)
        .filter((record): record is DeadLetterRecord => record !== null)
        .sort((a, b) => b.failedAt - a.failedAt);
    },

    async count() {
      const counts = await bay().getJobCounts(...PARKED_STATES);
      return Object.values(counts).reduce((total, n) => total + n, 0);
    },

    async redrive(id) {
      const job = await bay().getJob(id);
      if (job === undefined) return false;
      const entry = toRecord(job);
      if (entry === null) {
        await job.remove();
        return false;
      }
      const original = queue.queueFor(entry.queue);
      // The failed original is still in the queue under the same jobId, and
      // BullMQ would treat a re-add as a duplicate. Remove it first, so the
      // re-drive really re-runs rather than silently doing nothing.
      if (entry.jobId !== null) await original.remove(entry.jobId).catch(() => 0);
      await original.add(entry.jobName, entry.data, {
        ...(entry.jobId !== null && { jobId: entry.jobId }),
      });
      await job.remove();
      return true;
    },

    async drop(id) {
      const job = await bay().getJob(id);
      if (job === undefined) return false;
      await job.remove();
      return true;
    },

    async clear() {
      const bayQueue = bay();
      await bayQueue.drain(true);
      for (const state of ['completed', 'failed'] as const) {
        await bayQueue.clean(0, 1_000, state);
      }
    },
  };
}
