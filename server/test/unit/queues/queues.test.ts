import { describe, expect, it } from 'vitest';
import {
  ALL_QUEUE_NAMES,
  QUEUE_NAMES,
  QUEUE_PREFIX,
  assertQueueName,
  createInMemoryQueue,
  createJobQueue,
  createProducers,
  requireBullQueue,
  assertRedisUrl,
  verifyJobQueue,
} from '../../../src/queues/index.js';
import type { BullJobQueue } from '../../../src/queues/index.js';
import type { LevelCompleteJob } from '../../../src/jobs/managerNotify.js';

describe('queue names', () => {
  it('never contains a colon: BullMQ 6 throws on one', () => {
    for (const name of ALL_QUEUE_NAMES) expect(name).not.toContain(':');
    expect(() => assertQueueName('academy:signin-events')).toThrow(/':'/);
    expect(() => assertQueueName('')).toThrow();
    expect(assertQueueName('signin-events')).toBeUndefined();
  });

  it('puts the namespace in the prefix instead', () => {
    expect(QUEUE_PREFIX).toBe('academy');
    expect(QUEUE_NAMES.managerNotify).toBe('manager-notify');
  });
});

describe('in-memory queue', () => {
  it('records what was enqueued, in order', async () => {
    const queue = createInMemoryQueue({ now: () => 1_700_000_000_000 });
    await queue.add(QUEUE_NAMES.managerNotify, 'level-complete', { traineeId: 7 });
    await queue.add(QUEUE_NAMES.emails, 'welcome', { to: 1 });

    expect(queue.jobs).toHaveLength(2);
    expect(queue.jobs[0]).toMatchObject({
      queue: 'manager-notify',
      name: 'level-complete',
      data: { traineeId: 7 },
      enqueuedAt: 1_700_000_000_000,
    });
    expect(queue.jobsOn(QUEUE_NAMES.emails)).toHaveLength(1);

    queue.clear();
    expect(queue.jobs).toHaveLength(0);
  });

  it('de-duplicates on jobId, the way BullMQ does', async () => {
    const queue = createInMemoryQueue();
    await queue.add(QUEUE_NAMES.managerNotify, 'level-complete', { n: 1 }, { jobId: 'level-1-1' });
    await queue.add(QUEUE_NAMES.managerNotify, 'level-complete', { n: 2 }, { jobId: 'level-1-1' });
    expect(queue.jobs).toHaveLength(1);
    expect(queue.jobs[0]?.data).toEqual({ n: 1 });
  });

  it('refuses an illegal queue name', async () => {
    const queue = createInMemoryQueue();
    await expect(
      queue.add('bad:name' as (typeof ALL_QUEUE_NAMES)[number], 'x', {}),
    ).rejects.toThrow(/':'/);
  });
});

describe('producers', () => {
  it('enqueues manager-notify with the level payload and a per-milestone jobId', async () => {
    const queue = createInMemoryQueue();
    const producers = createProducers(queue);

    await producers.enqueueManagerNotify({ traineeId: 42, level: 1, track: 'ADMIN' });
    await producers.enqueueManagerNotify({ traineeId: 42, level: 1, track: 'ADMIN' });

    const jobs = queue.jobsOn<LevelCompleteJob>(QUEUE_NAMES.managerNotify);
    expect(jobs).toHaveLength(1); // the retry is the same milestone
    expect(jobs[0]?.name).toBe('level-complete');
    expect(jobs[0]?.data).toEqual({ traineeId: 42, level: 1, track: 'ADMIN' });
    expect(jobs[0]?.opts.jobId).toBe('level-42-1');
  });

  it('keeps a department completion separate from a level completion', async () => {
    const queue = createInMemoryQueue();
    const producers = createProducers(queue);
    await producers.enqueueManagerNotify({ traineeId: 9, level: 1, track: 'FOS' });
    await producers.enqueueDeptNotify({ traineeId: 9, dept: 'FOS', track: 'FOS' });
    expect(queue.jobs.map((j) => j.name)).toEqual(['level-complete', 'dept-complete']);
  });
});

describe('choosing an implementation', () => {
  it('uses the in-memory queue when REDIS_URL is unset or blank', async () => {
    for (const redisUrl of [undefined, '', '   ']) {
      const queue = createJobQueue({ redisUrl });
      await expect(queue.add(QUEUE_NAMES.emails, 'x', {})).resolves.toBeUndefined();
      await queue.close();
    }
  });

  it('uses the Redis-backed queue when REDIS_URL is set', async () => {
    // Nothing connects here: ioredis is lazy and BullMQ creates its queues on
    // first use, so this only proves which implementation was chosen.
    const queue = createJobQueue({ redisUrl: 'redis://127.0.0.1:6379' }) as BullJobQueue;
    expect(queue.prefix).toBe(QUEUE_PREFIX);
    expect(typeof queue.queueFor).toBe('function');
    await queue.close();
  });

  it('catches a REDIS_URL with the wrong scheme, without printing it', () => {
    // ioredis takes anything it cannot parse as a socket path, so a typo would
    // otherwise show up only as a connection that never comes up.
    expect(() => assertRedisUrl('http://localhost:6379')).toThrow(/scheme/);
    expect(() => assertRedisUrl('localhost:6379')).toThrow(/scheme/);
    // The message says how long it was, never what it said: it can carry a password.
    expect(() => assertRedisUrl('sekrit')).toThrow(/not a URL/);
    expect(() => assertRedisUrl('sekrit')).toThrow(/6 characters/);
    expect(assertRedisUrl('redis://127.0.0.1:6379')).toBeUndefined();
    expect(assertRedisUrl('rediss://cache.example:6380')).toBeUndefined();
  });

  it('refuses to fall back to the in-memory queue in production', () => {
    // A production API that enqueued into a process-local array would look
    // healthy and deliver nothing, so an unusable REDIS_URL is fatal there.
    expect(() =>
      createJobQueue({ redisUrl: 'http://localhost:6379', nodeEnv: 'production' }),
    ).toThrow(/Refusing to fall back/);
  });

  it('falls back to the in-memory queue, loudly, outside production', () => {
    const warnings: string[] = [];
    const warn = console.warn;
    console.warn = (...args: unknown[]) => void warnings.push(args.join(' '));
    try {
      const queue = createJobQueue({ redisUrl: 'http://localhost:6379', nodeEnv: 'development' });
      expect(queue).toBeDefined();
      expect(warnings.join(' ')).toMatch(/in-memory queue/i);
      expect(warnings.join(' ')).toMatch(/lost/i);
    } finally {
      console.warn = warn;
    }
  });

  it('an unreachable Redis is fatal in production and a warning elsewhere', async () => {
    // Port 1 answers nothing. The queue object is built either way; the check
    // is the PING.
    const queue = createJobQueue({ redisUrl: 'redis://127.0.0.1:1' });
    const warnings: string[] = [];
    await expect(verifyJobQueue(queue, { nodeEnv: 'production' })).rejects.toThrow(/PING/);
    await expect(
      verifyJobQueue(queue, {
        nodeEnv: 'development',
        logger: (m) => void warnings.push(m),
      }),
    ).resolves.toBe(false);
    expect(warnings.join(' ')).toMatch(/PING/);
    await queue.close();

    // The in-memory queue has nothing to verify and never blocks a start-up.
    await expect(verifyJobQueue(createInMemoryQueue(), { nodeEnv: 'production' })).resolves.toBe(
      false,
    );
  }, 30_000);

  it('gives the worker a real queue or nothing at all', () => {
    expect(() => requireBullQueue(undefined)).toThrow(/REDIS_URL/);
    expect(() => requireBullQueue('  ')).toThrow(/REDIS_URL/);
  });
});
