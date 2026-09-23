// The notification rules, against a real Postgres (MIGRATION_TEST_DB_NAME).
// Skips cleanly when no test database is configured.
//
// What it proves, in the checklist's words:
//   * "Level-1 pass triggers manager DM with correct name/track"
//   * "3 consecutive fails on one stage → one manager DM (not three)" — and
//     that a fourth fail arriving at the same instant as the third still
//     produces ONE record
//   * shadow mode records the notification in audit_events and sends nothing
//
// Every name and address here is invented. Nothing is read from the prototype.

import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseEnv } from 'node:util';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { pgConfig } from '../../src/db/connection.js';
import { applyMigrations, settingsFromEnv } from '../../src/db/migrate.js';
import { createManagerNotifyHandler, MANAGER_NOTIFY_JOBS } from '../../src/jobs/managerNotify.js';
import {
  createManagerRecipients,
  createNotificationRules,
  createNotifier,
  NOTIFICATION_KINDS,
  wasNotified,
} from '../../src/modules/notifications/index.js';
import type { NotificationMessage, NotifyMode } from '../../src/modules/notifications/index.js';
import { silentLogger } from '../../src/queues/logging.js';

function envWithDotenv(): NodeJS.ProcessEnv {
  const candidates = process.env.ENV_FILE
    ? [resolve(process.env.ENV_FILE)]
    : [resolve(process.cwd(), '.env'), resolve(process.cwd(), '..', '.env')];
  const file = candidates.find((f) => existsSync(f));
  const fromFile = file ? parseEnv(readFileSync(file, 'utf8')) : {};
  return { ...fromFile, ...process.env };
}

const env = envWithDotenv();
const TEST_DB = env.MIGRATION_TEST_DB_NAME?.trim() ?? '';
const quiet = (): undefined => undefined;

/** Unique per run, so two runs never collide on an email or a stage code. */
const tag = Math.random().toString(36).slice(2, 8);

describe.skipIf(!TEST_DB)('notification rules', () => {
  let pool: pg.Pool;
  let traineeId: number;
  let managerId: number;
  let stageId: number;
  let quizId: number;
  const managerCrmId = 900_000 + Math.floor(Math.random() * 90_000);

  beforeAll(async () => {
    const settings = { ...settingsFromEnv(env), DB_NAME: TEST_DB };
    pool = new pg.Pool(pgConfig(settings, { applicationName: 'academy-notify-test', max: 4 }));
    // 0006 creates notifications_sent; the suite needs it.
    await applyMigrations({ commit: true, expectDb: TEST_DB, settings, log: quiet });

    const trainee = await pool.query<{ id: string }>(
      `INSERT INTO academy.trainees (full_name, email, track)
       VALUES ($1, $2, 'ADMIN') RETURNING id`,
      [`Dana Notify-${tag}`, `dana.notify.${tag}@example.invalid`],
    );
    traineeId = Number(trainee.rows[0]!.id);

    const manager = await pool.query<{ id: string }>(
      `INSERT INTO academy.trainees (full_name, email, track, crm_user_id)
       VALUES ($1, $2, 'ADMIN', $3) RETURNING id`,
      [`Morgan Manager-${tag}`, `morgan.manager.${tag}@example.invalid`, managerCrmId],
    );
    managerId = Number(manager.rows[0]!.id);
    await pool.query(
      `INSERT INTO academy.role_overrides (crm_user_id, role, granted_by)
       VALUES ($1, 'MANAGER', 'ops:test')`,
      [managerCrmId],
    );

    // A department module of our own, so the suite does not depend on the seed
    // having run and cannot disturb it.
    const stage = await pool.query<{ id: string }>(
      `INSERT INTO academy.stages (position, title, code, track, dept)
       VALUES ($1, $2, $3, 'FULL', 'ADMIN') RETURNING id`,
      [20_000 + Math.floor(Math.random() * 10_000), `Notify test stage ${tag}`, `nt-${tag}`],
    );
    stageId = Number(stage.rows[0]!.id);
    const quiz = await pool.query<{ id: string }>(
      'INSERT INTO academy.quizzes (stage_id, pass_mark) VALUES ($1, 80) RETURNING id',
      [stageId],
    );
    quizId = Number(quiz.rows[0]!.id);
  }, 120_000);

  afterAll(async () => {
    if (pool === undefined) return;
    await pool.query(
      'DELETE FROM academy.notifications_sent WHERE trainee_id = ANY($1::bigint[])',
      [[traineeId, managerId]],
    );
    await pool.query('DELETE FROM academy.audit_events WHERE trainee_id = ANY($1::bigint[])', [
      [traineeId, managerId],
    ]);
    await pool.query('DELETE FROM academy.quiz_attempts WHERE quiz_id = $1', [quizId]);
    await pool.query('DELETE FROM academy.quizzes WHERE id = $1', [quizId]);
    await pool.query('DELETE FROM academy.stages WHERE id = $1', [stageId]);
    await pool.query('DELETE FROM academy.role_overrides WHERE crm_user_id = $1', [managerCrmId]);
    await pool.query('DELETE FROM academy.trainees WHERE id = ANY($1::bigint[])', [
      [traineeId, managerId],
    ]);
    await pool.end();
  });

  /** A notifier that records what it was given instead of writing anywhere. */
  function spyNotifier(mode: NotifyMode = 'shadow'): {
    mode: NotifyMode;
    sent: NotificationMessage[];
    send: (message: NotificationMessage) => Promise<void>;
  } {
    const sent: NotificationMessage[] = [];
    return {
      mode,
      sent,
      send: (message) => {
        sent.push(message);
        return Promise.resolve();
      },
    };
  }

  function rulesWith(notifier: ReturnType<typeof spyNotifier>) {
    return createNotificationRules({
      db: pool,
      notifier,
      recipients: createManagerRecipients(pool),
      logger: silentLogger,
    });
  }

  async function recordAttempt(attemptNumber: number, passed: boolean): Promise<number> {
    const { rows } = await pool.query<{ id: string }>(
      `INSERT INTO academy.quiz_attempts
         (trainee_id, quiz_id, attempt_number, score_pct, passed, started_at)
       VALUES ($1, $2, $3, $4, $5, now()) RETURNING id`,
      [traineeId, quizId, attemptNumber, passed ? 90 : 20, passed],
    );
    return Number(rows[0]!.id);
  }

  it('resolves every MANAGER account as the recipient (the documented default)', async () => {
    const recipients = await createManagerRecipients(pool).forTrainee(traineeId);
    const mine = recipients.find((r) => r.email === `morgan.manager.${tag}@example.invalid`);
    expect(mine).toBeDefined();
    expect(mine?.name).toBe(`Morgan Manager-${tag}`);
    expect(mine?.audience).toBe('MANAGER');
    // A trainee with no MANAGER override is never a recipient.
    expect(recipients.map((r) => r.email)).not.toContain(`dana.notify.${tag}@example.invalid`);
  });

  it('composes ONE Level-1 message with the right name and track', async () => {
    const notifier = spyNotifier();
    const rules = rulesWith(notifier);

    expect(await rules.onLevelComplete({ traineeId, level: 1, track: 'ADMIN' })).toBe(true);
    // The retry, the double submit, the restarted worker: all the same job.
    expect(await rules.onLevelComplete({ traineeId, level: 1, track: 'ADMIN' })).toBe(false);

    expect(notifier.sent).toHaveLength(1);
    const message = notifier.sent[0]!;
    // The build pack's wording, with the track's label, not its code.
    expect(message.subject).toBe(`Dana Notify-${tag} is ready to start work — Admin`);
    expect(message.kind).toBe(NOTIFICATION_KINDS.levelComplete);
    expect(message.refs).toEqual({ traineeId, ref: 'level-1', track: 'ADMIN' });
    expect(message.to.map((r) => r.email)).toContain(`morgan.manager.${tag}@example.invalid`);

    expect(
      await wasNotified(pool, {
        kind: NOTIFICATION_KINDS.levelComplete,
        traineeId,
        ref: 'level-1',
      }),
    ).toBe(true);
  });

  it('says nothing until the third fail, then says it once', async () => {
    const notifier = spyNotifier();
    const rules = rulesWith(notifier);

    const first = await recordAttempt(1, false);
    expect(await rules.onStageFail({ traineeId, stageId, attemptId: first, track: 'ADMIN' })).toBe(
      false,
    );
    const second = await recordAttempt(2, false);
    expect(await rules.onStageFail({ traineeId, stageId, attemptId: second, track: 'ADMIN' })).toBe(
      false,
    );
    expect(notifier.sent).toHaveLength(0);

    // The third and a fourth fail land at the same instant — two workers, or
    // one worker with two jobs in flight. The UNIQUE key decides.
    const third = await recordAttempt(3, false);
    const fourth = await recordAttempt(4, false);
    const results = await Promise.all([
      rules.onStageFail({ traineeId, stageId, attemptId: third, track: 'ADMIN' }),
      rules.onStageFail({ traineeId, stageId, attemptId: fourth, track: 'ADMIN' }),
    ]);

    expect(results.filter(Boolean)).toHaveLength(1); // exactly one of them won
    expect(notifier.sent).toHaveLength(1);
    expect(notifier.sent[0]?.kind).toBe(NOTIFICATION_KINDS.stageFailStreak);
    expect(notifier.sent[0]?.subject).toContain(`Notify test stage ${tag}`);
    expect(notifier.sent[0]?.body).toMatch(/times in a row/);

    // ONE row, not three, not four.
    const { rows } = await pool.query<{ n: string }>(
      `SELECT count(*) AS n FROM academy.notifications_sent
        WHERE trainee_id = $1 AND kind = $2`,
      [traineeId, NOTIFICATION_KINDS.stageFailStreak],
    );
    expect(Number(rows[0]!.n)).toBe(1);

    // A fifth fail after the message: still nothing new.
    const fifth = await recordAttempt(5, false);
    expect(await rules.onStageFail({ traineeId, stageId, attemptId: fifth, track: 'ADMIN' })).toBe(
      false,
    );
    expect(notifier.sent).toHaveLength(1);
  });

  it('counts the streak from the last pass, not from the beginning of time', async () => {
    // A pass resets the run: the next fail is fail number one again.
    await recordAttempt(6, true);
    const after = await recordAttempt(7, false);
    const notifier = spyNotifier();
    const rules = rulesWith(notifier);
    expect(await rules.onStageFail({ traineeId, stageId, attemptId: after, track: 'ADMIN' })).toBe(
      false,
    );
    expect(notifier.sent).toHaveLength(0);
  });

  it('shadow mode writes the audit row and sends nothing', async () => {
    const notifier = createNotifier({ mode: 'shadow', db: pool, logger: silentLogger });
    const rules = createNotificationRules({
      db: pool,
      notifier,
      recipients: createManagerRecipients(pool),
      logger: silentLogger,
    });

    expect(await rules.onLevelComplete({ traineeId, level: 2, track: 'ADMIN' })).toBe(true);

    const { rows } = await pool.query<{ payload: Record<string, unknown>; actor: string }>(
      `SELECT payload, actor FROM academy.audit_events
        WHERE trainee_id = $1 AND event_type = 'NOTIFICATION_SHADOW'
        ORDER BY id DESC LIMIT 1`,
      [traineeId],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.actor).toBe('system');
    expect(rows[0]?.payload).toMatchObject({
      kind: NOTIFICATION_KINDS.levelComplete,
      ref: 'level-2',
      mode: 'shadow',
      delivered: false,
    });
    // The record proves a message was composed; it never carries an address.
    expect(JSON.stringify(rows[0]?.payload)).not.toContain('@');
    expect(Number(rows[0]?.payload.recipientCount)).toBeGreaterThan(0);
  });

  it("'off' composes nothing and writes nothing", async () => {
    const notifier = createNotifier({ mode: 'off', db: pool, logger: silentLogger });
    const rules = createNotificationRules({
      db: pool,
      notifier,
      recipients: createManagerRecipients(pool),
      logger: silentLogger,
    });
    const before = await pool.query<{ n: string }>(
      `SELECT count(*) AS n FROM academy.audit_events
        WHERE trainee_id = $1 AND event_type = 'NOTIFICATION_SHADOW'`,
      [traineeId],
    );
    expect(await rules.onLevelComplete({ traineeId, level: 3, track: 'ADMIN' })).toBe(true);
    const after = await pool.query<{ n: string }>(
      `SELECT count(*) AS n FROM academy.audit_events
        WHERE trainee_id = $1 AND event_type = 'NOTIFICATION_SHADOW'`,
      [traineeId],
    );
    expect(after.rows[0]!.n).toBe(before.rows[0]!.n);
  });

  it('the manager-notify handler routes each job name, and refuses an unknown one', async () => {
    const notifier = spyNotifier();
    const handler = createManagerNotifyHandler(rulesWith(notifier));

    await handler({
      id: 'level-x-4',
      name: MANAGER_NOTIFY_JOBS.levelComplete,
      data: { traineeId, level: 4, track: 'ADMIN' },
      attemptsMade: 1,
    });
    expect(notifier.sent.map((m) => m.kind)).toEqual([NOTIFICATION_KINDS.levelComplete]);

    await expect(
      handler({ id: 'x', name: 'not-a-job', data: {}, attemptsMade: 1 }),
    ).rejects.toThrow(/unknown job name/);
  });
});
