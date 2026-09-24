// The worker runtime: one BullMQ Worker per work queue, sharing one Redis
// connection, with the dead-letter bay wired to the 'failed' event.
//
// It lives here rather than in entry/worker.ts so a test can start and stop
// workers in-process — which is how the "kill the worker mid-job, restart,
// the job completes exactly once" proof (checklist 08) is run.
//
// Exactly-once is NOT provided by BullMQ and is not claimed here. BullMQ is
// at-least-once: a worker killed with a job in flight loses its lock, another
// worker picks the job up and runs the handler again. Every handler therefore
// has to be idempotent AND leave a durable marker — the notification rules use
// the `academy.notifications_sent` unique key, and `once.ts` offers a Redis
// marker for handlers with no table of their own.

import { Worker } from 'bullmq';
import type { Job, WorkerOptions } from 'bullmq';
import type { BullJobQueue } from './bull.js';
import type { DeadLetterStore } from './deadLetter.js';
import { consoleLogger } from './logging.js';
import type { QueueLogger } from './logging.js';
import { WORK_QUEUE_NAMES } from './names.js';
import type { QueueName } from './names.js';

/** What a handler is given: BullMQ's Job, narrowed to what we use. */
export interface JobContext<T = unknown> {
  id: string;
  /** The job name inside the queue, e.g. 'level-complete'. */
  name: string;
  data: T;
  attemptsMade: number;
}

export type JobHandler = (job: JobContext) => Promise<void>;

/** A handler per queue. A queue with no handler gets no worker. */
export type JobHandlers = Partial<Record<QueueName, JobHandler>>;

/** How many jobs one worker runs at a time. Defaults to CONCURRENCY. */
export type QueueConcurrency = Partial<Record<QueueName, number>>;

/**
 * Deliberately small. These jobs talk to Postgres and (later) an email
 * provider; ten notifications at once would be ten pool connections.
 */
export const DEFAULT_CONCURRENCY: Record<string, number> = {
  'manager-notify': 2,
  'signin-events': 4,
  transcription: 1,
  'question-gen': 1,
  provisioning: 1,
  emails: 2,
  certificates: 1,
};

export interface WorkerRuntimeOptions {
  queue: BullJobQueue;
  handlers: JobHandlers;
  deadLetter: DeadLetterStore;
  logger?: QueueLogger;
  concurrency?: QueueConcurrency;
  /**
   * Passed straight to BullMQ. The defaults are its own (30 s lock, 30 s
   * stalled check); the exactly-once test shortens both so a killed job is
   * reclaimed in a second rather than in half a minute.
   */
  lockDurationMs?: number;
  stalledIntervalMs?: number;
  /** Heartbeat interval. 0 turns it off (tests). */
  heartbeatMs?: number;
}

export interface WorkerRuntime {
  readonly workers: ReadonlyMap<QueueName, Worker>;
  /** Wait until every worker has finished starting up. */
  ready(): Promise<void>;
  /**
   * Stop taking work, let running jobs finish, close Redis.
   * `force` abandons running jobs — that is the "killed worker" case, and it
   * is what SIGTERM does NOT do.
   */
  close(force?: boolean): Promise<void>;
}

function isFinalAttempt(job: Job): boolean {
  const attempts = job.opts.attempts ?? 1;
  return job.attemptsMade >= attempts;
}

export function createWorkerRuntime(options: WorkerRuntimeOptions): WorkerRuntime {
  const log = options.logger ?? consoleLogger('academy-worker');
  const { queue, handlers, deadLetter } = options;
  const workers = new Map<QueueName, Worker>();

  for (const name of WORK_QUEUE_NAMES) {
    const handler = handlers[name];
    if (handler === undefined) {
      log.warn(`queue ${name}: no handler registered, no worker started`);
      continue;
    }

    const workerOptions: WorkerOptions = {
      connection: queue.connection,
      prefix: queue.prefix,
      concurrency: options.concurrency?.[name] ?? DEFAULT_CONCURRENCY[name] ?? 1,
      ...(options.lockDurationMs !== undefined && { lockDuration: options.lockDurationMs }),
      ...(options.stalledIntervalMs !== undefined && {
        stalledInterval: options.stalledIntervalMs,
      }),
    };

    const worker = new Worker(
      name,
      async (job: Job) => {
        await handler({
          id: job.id ?? '',
          name: job.name,
          data: job.data,
          attemptsMade: job.attemptsMade,
        });
      },
      workerOptions,
    );

    worker.on('completed', (job) => {
      log.info(`${name}/${job.name} ${job.id ?? '?'} done`);
    });

    worker.on('failed', (job, err) => {
      if (job === undefined) {
        log.error(`${name}: a job failed and was already gone (${err.message})`);
        return;
      }
      const where = `${name}/${job.name} ${job.id ?? '?'}`;
      if (!isFinalAttempt(job)) {
        log.warn(`${where} attempt ${String(job.attemptsMade)} failed, will retry: ${err.message}`);
        return;
      }
      log.error(`${where} failed for the last time, parking it: ${err.message}`);
      void deadLetter
        .record({
          queue: name,
          jobName: job.name,
          jobId: job.id ?? null,
          data: job.data,
          failedReason: err.message,
          attemptsMade: job.attemptsMade,
          enqueuedAt: job.timestamp,
          failedAt: Date.now(),
        })
        .catch((deadLetterErr: Error) => {
          log.error(`${where} could not be parked in dead-letter: ${deadLetterErr.message}`);
        });
    });

    // A Worker with no 'error' listener turns a Redis blip into an unhandled
    // 'error' event, which kills the process.
    worker.on('error', (err: Error) => {
      log.error(`queue ${name}: ${err.message}`);
    });

    workers.set(name, worker);
  }

  const heartbeatMs = options.heartbeatMs ?? 60_000;
  const heartbeat =
    heartbeatMs > 0
      ? setInterval(() => {
          log.info(`heartbeat: ${String(workers.size)} queues running`);
        }, heartbeatMs)
      : null;
  heartbeat?.unref();

  return {
    workers,
    async ready() {
      await Promise.all([...workers.values()].map((worker) => worker.waitUntilReady()));
    },
    async close(force = false) {
      if (heartbeat !== null) clearInterval(heartbeat);
      await Promise.all([...workers.values()].map((worker) => worker.close(force)));
      workers.clear();
    },
  };
}
