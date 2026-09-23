// The queue, for real: a live Redis, real BullMQ Queues and Workers.
//
// It runs against redis://127.0.0.1:6379 (Memurai locally, the redis service
// in CI) and SKIPS CLEANLY when nothing answers, so a machine without Redis
// still passes the suite. Every run uses its own key prefix, so two runs — or
// a run beside a real worker — never see each other's jobs.
//
// What it proves, in the checklist's words:
//   * a job added is a job consumed
//   * jobId de-duplication: the same milestone twice is one job
//   * a handler that always throws lands in the dead-letter list, which can
//     be read, re-driven and cleared
//   * "kill the worker mid-job, restart → the job completes exactly once"
//   * queue names still contain no ':'

import { Redis } from 'ioredis';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createBullQueue, createQueueRedis } from '../../../src/queues/bull.js';
import type { BullJobQueue } from '../../../src/queues/bull.js';
import { createDeadLetterStore } from '../../../src/queues/deadLetter.js';
import type { DeadLetterStore } from '../../../src/queues/deadLetter.js';
import { silentLogger } from '../../../src/queues/logging.js';
import { ALL_QUEUE_NAMES, QUEUE_NAMES } from '../../../src/queues/names.js';
import { createRedisOnceMarker } from '../../../src/queues/once.js';
import { createWorkerRuntime } from '../../../src/queues/runtime.js';
import type { JobHandlers } from '../../../src/queues/runtime.js';

const REDIS_URL = process.env.REDIS_TEST_URL ?? process.env.REDIS_URL ?? 'redis://127.0.0.1:6379';

/** Is anything listening? Decided once, before the suite is defined. */
async function redisAvailable(): Promise<boolean> {
  const probe = new Redis(REDIS_URL, {
    lazyConnect: true,
    maxRetriesPerRequest: 1,
    connectTimeout: 1_500,
    retryStrategy: () => null,
  });
  probe.on('error', () => undefined);
  try {
    await probe.connect();
    return (await probe.ping()) === 'PONG';
  } catch {
    return false;
  } finally {
    probe.disconnect();
  }
}

const HAVE_REDIS = await redisAvailable();

async function waitFor(
  what: string,
  predicate: () => boolean | Promise<boolean>,
  timeoutMs = 20_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await predicate()) return;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

describe.skipIf(!HAVE_REDIS)('BullMQ queue on a live Redis', () => {
  // A private namespace per run: 'academy-test-<random>'. The production
  // prefix is 'academy' (CLAUDE.md); only the prefix changes here, never a
  // queue NAME, because a name with ':' is what BullMQ 6 throws on.
  const prefix = `academy-test-${Math.random().toString(36).slice(2, 8)}`;
  let connection: Redis;
  let queue: BullJobQueue;
  let deadLetter: DeadLetterStore;

  beforeAll(async () => {
    connection = createQueueRedis(REDIS_URL);
    await connection.connect();
    queue = createBullQueue({
      redisUrl: REDIS_URL,
      prefix,
      connection,
      // Fast failures: the real default is 5 attempts backing off from 2 s,
      // which would make the dead-letter test a two-minute test.
      defaultJobOptions: { attempts: 2, backoff: { type: 'fixed', delay: 50 } },
    });
    deadLetter = createDeadLetterStore(queue);
  });

  afterAll(async () => {
    // Leave nothing behind: every key this run created starts with the prefix.
    if (connection !== undefined) {
      await queue.close();
      const keys = await connection.keys(`${prefix}:*`);
      if (keys.length > 0) await connection.del(...keys);
      const markers = await connection.keys(`${prefix}:once:*`);
      if (markers.length > 0) await connection.del(...markers);
      await connection.quit().catch(() => connection.disconnect());
    }
  });

  async function withWorkers(
    handlers: JobHandlers,
    body: () => Promise<void>,
    options: { lockDurationMs?: number; stalledIntervalMs?: number } = {},
  ): Promise<void> {
    const runtime = createWorkerRuntime({
      queue,
      handlers,
      deadLetter,
      logger: silentLogger,
      heartbeatMs: 0,
      ...options,
    });
    await runtime.ready();
    try {
      await body();
    } finally {
      await runtime.close(true);
    }
  }

  it('never uses a queue name with a colon in it', () => {
    for (const name of ALL_QUEUE_NAMES) expect(name).not.toContain(':');
    // And BullMQ agrees: constructing one throws.
    expect(() => queue.queueFor('bad:name' as (typeof ALL_QUEUE_NAMES)[number])).toThrow();
  });

  it('adds a job and a worker consumes it', async () => {
    const seen: { name: string; data: unknown }[] = [];
    await withWorkers(
      {
        [QUEUE_NAMES.managerNotify]: (job) => {
          seen.push({ name: job.name, data: job.data });
          return Promise.resolve();
        },
      },
      async () => {
        await queue.add(
          QUEUE_NAMES.managerNotify,
          'level-complete',
          { traineeId: 101, level: 1, track: 'ADMIN' },
          { jobId: 'consume-101' },
        );
        await waitFor('the job to be consumed', () => seen.length === 1);
        expect(seen[0]).toEqual({
          name: 'level-complete',
          data: { traineeId: 101, level: 1, track: 'ADMIN' },
        });
      },
    );
  });

  it('de-duplicates on jobId: the same milestone twice is one job', async () => {
    const seen: unknown[] = [];
    await withWorkers(
      {
        [QUEUE_NAMES.managerNotify]: (job) => {
          seen.push(job.data);
          return Promise.resolve();
        },
      },
      async () => {
        const payload = { traineeId: 202, level: 1, track: 'ADMIN' };
        await queue.add(QUEUE_NAMES.managerNotify, 'level-complete', payload, {
          jobId: 'level-202-1',
        });
        await waitFor('the first copy', () => seen.length === 1);
        // The retried request. BullMQ keeps the original and enqueues nothing.
        await queue.add(QUEUE_NAMES.managerNotify, 'level-complete', payload, {
          jobId: 'level-202-1',
        });
        await new Promise((resolve) => setTimeout(resolve, 500));
        expect(seen).toHaveLength(1);
      },
    );
  });

  it('parks a job that exhausts its attempts, and the list reads and clears', async () => {
    await deadLetter.clear();
    expect(await deadLetter.count()).toBe(0);

    let attempts = 0;
    await withWorkers(
      {
        [QUEUE_NAMES.transcription]: () => {
          attempts += 1;
          return Promise.reject(new Error('the transcription provider is on fire'));
        },
      },
      async () => {
        await queue.add(
          QUEUE_NAMES.transcription,
          'transcribe',
          { recordingId: 7, mediaKey: 'academy/media/x.mp3' },
          { jobId: 'transcribe-7' },
        );
        await waitFor('the job to be parked', async () => (await deadLetter.count()) === 1);
      },
    );

    // Both attempts ran, and the failure was recorded with enough to act on.
    expect(attempts).toBe(2);
    const parked = await deadLetter.list();
    expect(parked).toHaveLength(1);
    expect(parked[0]).toMatchObject({
      queue: 'transcription',
      jobName: 'transcribe',
      jobId: 'transcribe-7',
      data: { recordingId: 7 },
      attemptsMade: 2,
    });
    expect(parked[0]?.failedReason).toMatch(/on fire/);
    expect(parked[0]?.failedAt).toBeGreaterThan(0);

    // Re-driving puts it back on its own queue, where a working handler takes it.
    const handled: number[] = [];
    await withWorkers(
      {
        [QUEUE_NAMES.transcription]: (job) => {
          handled.push((job.data as { recordingId: number }).recordingId);
          return Promise.resolve();
        },
      },
      async () => {
        expect(await deadLetter.redrive(parked[0]!.id)).toBe(true);
        await waitFor('the re-driven job', () => handled.length === 1);
      },
    );
    expect(handled).toEqual([7]);

    // Checklist 08: dead-letter queue visible and EMPTY after the tests.
    await deadLetter.clear();
    expect(await deadLetter.count()).toBe(0);
    expect(await deadLetter.list()).toEqual([]);
  });

  it('kill the worker mid-job, restart: the work happens exactly once', async () => {
    const marker = createRedisOnceMarker(connection, { prefix: `${prefix}:once:` });
    const ledgerKey = `${prefix}:once-ledger`;
    await connection.del(ledgerKey);

    let started = 0;
    // The first run claims the marker, writes its one row, and then hangs for
    // ever — which is what "the worker was killed mid-job" looks like from the
    // outside: the lock expires and another worker picks the job up.
    const hangForEver = new Promise<void>(() => undefined);
    const handler = async (): Promise<void> => {
      started += 1;
      const first = await marker.claim('exactly-once-demo');
      if (!first) return; // the durable marker: the work is already done
      await connection.rpush(ledgerKey, 'done');
      await hangForEver;
    };

    // Short lock + stalled check so the abandoned job is reclaimed in about a
    // second instead of the default thirty.
    const timings = { lockDurationMs: 1_000, stalledIntervalMs: 500 };

    const first = createWorkerRuntime({
      queue,
      handlers: { [QUEUE_NAMES.signinEvents]: handler },
      deadLetter,
      logger: silentLogger,
      heartbeatMs: 0,
      ...timings,
    });
    await first.ready();
    await queue.add(
      QUEUE_NAMES.signinEvents,
      'session-start',
      { traineeId: 303 },
      { jobId: 'exactly-once-demo', attempts: 5 },
    );
    await waitFor('the first run to write its row', async () => {
      return (await connection.llen(ledgerKey)) === 1;
    });

    // The kill: force close abandons the running job without releasing it.
    await first.close(true);

    const completed: string[] = [];
    const second = createWorkerRuntime({
      queue,
      handlers: { [QUEUE_NAMES.signinEvents]: handler },
      deadLetter,
      logger: {
        ...silentLogger,
        info: (message: string) => void completed.push(message),
      },
      heartbeatMs: 0,
      ...timings,
    });
    await second.ready();
    try {
      await waitFor(
        'the restarted worker to finish the job',
        () => completed.some((line) => line.includes('exactly-once-demo') && line.includes('done')),
        30_000,
      );
    } finally {
      await second.close(true);
    }

    // The proof: the handler ran twice, the work happened once.
    expect(started).toBeGreaterThanOrEqual(2);
    expect(await connection.llen(ledgerKey)).toBe(1);
    expect(await deadLetter.count()).toBe(0);
    await connection.del(ledgerKey);
  }, 60_000);
});
