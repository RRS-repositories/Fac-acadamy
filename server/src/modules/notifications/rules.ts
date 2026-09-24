// The notification rules from SECTION-08 task 3, with Mattermost removed.
//
//   (a) Level 1 passed        → "<name> is ready to start work — <track>"
//   (b) 3 fails on one stage  → ONE message, not three
//   (c) account disabled/re-enabled → an IT-facing note
//
// Every rule follows the same shape:
//
//   1. read the facts out of the database (names, labels, the fail streak);
//   2. decide — a rule that does not apply stops here and claims nothing;
//   3. in ONE transaction: claim the marker, and only if the claim won,
//      hand the composed message to the notifier.
//
// Step 3 is what makes "3 fails → ONE message" survive a restart, a retry and
// a third and fourth failure landing at the same instant. The marker and the
// shadow-mode audit row are written by the same transaction, so there is no
// state where one exists without the other.

import type { Pool } from 'pg';
import {
  accountStatusMessage,
  deptCompleteMessage,
  levelCompleteMessage,
  stageFailStreakMessage,
} from './messages.js';
import type { RecipientResolver } from './recipients.js';
import { claimNotification } from './sent.js';
import type { NotificationKind, NotificationMessage, Notifier } from './types.js';

/** The streak that gets a manager involved (checklist 08). */
export const FAIL_STREAK_THRESHOLD = 3;

export interface LevelCompleteInput {
  traineeId: number;
  level: number;
  track: string;
}

export interface DeptCompleteInput {
  traineeId: number;
  dept: string;
  track: string;
}

export interface StageFailInput {
  traineeId: number;
  stageId: number;
  attemptId: number;
  track: string;
}

export interface AccountStatusInput {
  traineeId: number;
  enabled: boolean;
  /** 'manager:12' | 'system'. */
  actor: string;
  /** What makes this change unique: an audit event id, or an ISO timestamp. */
  eventRef: string;
}

export interface NotificationRules {
  onLevelComplete(input: LevelCompleteInput): Promise<boolean>;
  onDeptComplete(input: DeptCompleteInput): Promise<boolean>;
  onStageFail(input: StageFailInput): Promise<boolean>;
  onAccountStatusChange(input: AccountStatusInput): Promise<boolean>;
}

export interface LoggerLike {
  info(message: string): void;
  warn(message: string): void;
  error(message: string): void;
}

export interface NotificationRulesOptions {
  db: Pool;
  notifier: Notifier;
  recipients: RecipientResolver;
  logger?: LoggerLike;
  /** Overridable so a test can prove the rule, not the number 3. */
  failStreakThreshold?: number;
}

interface TraineeFacts {
  full_name: string;
  track_code: string;
  track_label: string;
}

export function createNotificationRules(options: NotificationRulesOptions): NotificationRules {
  const { db, notifier, recipients } = options;
  const log = options.logger ?? {
    info: (m: string) => console.log(`[academy-notify] ${m}`),
    warn: (m: string) => console.warn(`[academy-notify] ${m}`),
    error: (m: string) => console.error(`[academy-notify] ${m}`),
  };
  const threshold = options.failStreakThreshold ?? FAIL_STREAK_THRESHOLD;

  async function traineeFacts(
    traineeId: number,
    fallbackTrack: string,
  ): Promise<TraineeFacts | null> {
    const { rows } = await db.query<TraineeFacts>(
      `SELECT t.full_name,
              COALESCE(t.track, $2)            AS track_code,
              COALESCE(tr.label, t.track, $2)  AS track_label
         FROM academy.trainees t
         LEFT JOIN academy.tracks tr ON tr.code = t.track
        WHERE t.id = $1`,
      [traineeId, fallbackTrack],
    );
    return rows[0] ?? null;
  }

  /**
   * Claim, then send, in one transaction. Returns true when this call is the
   * one that composed the message; false when somebody (or some earlier
   * attempt) already had.
   */
  async function sendOnce(
    kind: NotificationKind,
    traineeId: number,
    ref: string,
    message: NotificationMessage,
  ): Promise<boolean> {
    const client = await db.connect();
    try {
      await client.query('BEGIN');
      const won = await claimNotification(client, { kind, traineeId, ref, mode: notifier.mode });
      if (!won) {
        await client.query('ROLLBACK');
        log.info(`${kind} trainee=${String(traineeId)} ref=${ref} already notified, skipping`);
        return false;
      }
      await notifier.send(message, client);
      await client.query('COMMIT');
      return true;
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
  }

  return {
    async onLevelComplete(input) {
      const facts = await traineeFacts(input.traineeId, input.track);
      if (facts === null) {
        log.warn(`level-complete: trainee ${String(input.traineeId)} no longer exists, skipping`);
        return false;
      }
      const to = await recipients.forTrainee(input.traineeId);
      const message = levelCompleteMessage(
        {
          traineeId: input.traineeId,
          fullName: facts.full_name,
          level: input.level,
          trackCode: facts.track_code,
          trackLabel: facts.track_label,
        },
        to,
      );
      return await sendOnce(message.kind, input.traineeId, message.refs.ref, message);
    },

    async onDeptComplete(input) {
      const facts = await traineeFacts(input.traineeId, input.track);
      if (facts === null) {
        log.warn(`dept-complete: trainee ${String(input.traineeId)} no longer exists, skipping`);
        return false;
      }
      const { rows } = await db.query<{ label: string }>(
        'SELECT label FROM academy.departments WHERE code = $1',
        [input.dept],
      );
      const message = deptCompleteMessage(
        {
          traineeId: input.traineeId,
          fullName: facts.full_name,
          deptCode: input.dept,
          deptLabel: rows[0]?.label ?? input.dept,
          trackCode: facts.track_code,
        },
        await recipients.forTrainee(input.traineeId),
      );
      return await sendOnce(message.kind, input.traineeId, message.refs.ref, message);
    },

    async onStageFail(input) {
      // The streak is counted here, against the database, rather than trusted
      // from the request that happened to be third: attempts can arrive out of
      // order, and a job can be retried long after the attempt was recorded.
      // "Consecutive" means "since the last pass on this stage, if any".
      const { rows } = await db.query<{ fails: number; code: string; title: string }>(
        `WITH q AS (
             SELECT id FROM academy.quizzes WHERE stage_id = $2
         ),
         last_pass AS (
             SELECT COALESCE(MAX(a.attempt_number), 0) AS n
               FROM academy.quiz_attempts a
              WHERE a.trainee_id = $1
                AND a.quiz_id IN (SELECT id FROM q)
                AND a.passed
         )
         SELECT (SELECT count(*)::int
                   FROM academy.quiz_attempts a, last_pass lp
                  WHERE a.trainee_id = $1
                    AND a.quiz_id IN (SELECT id FROM q)
                    AND NOT a.passed
                    AND a.attempt_number > lp.n)          AS fails,
                s.code,
                s.title
           FROM academy.stages s
          WHERE s.id = $2`,
        [input.traineeId, input.stageId],
      );
      const row = rows[0];
      if (row === undefined) {
        log.warn(`stage-fail: stage ${String(input.stageId)} no longer exists, skipping`);
        return false;
      }
      if (row.fails < threshold) return false;

      const facts = await traineeFacts(input.traineeId, input.track);
      if (facts === null) {
        log.warn(`stage-fail: trainee ${String(input.traineeId)} no longer exists, skipping`);
        return false;
      }
      const message = stageFailStreakMessage(
        {
          traineeId: input.traineeId,
          fullName: facts.full_name,
          stageId: input.stageId,
          stageCode: row.code,
          stageTitle: row.title,
          fails: row.fails,
          trackCode: facts.track_code,
        },
        await recipients.forTrainee(input.traineeId),
      );
      // The ref is the STAGE, not the attempt: that is what turns "three
      // fails, then a fourth" into one message.
      return await sendOnce(message.kind, input.traineeId, message.refs.ref, message);
    },

    async onAccountStatusChange(input) {
      const facts = await traineeFacts(input.traineeId, '');
      if (facts === null) {
        log.warn(`account-status: trainee ${String(input.traineeId)} no longer exists, skipping`);
        return false;
      }
      const message = accountStatusMessage(
        {
          traineeId: input.traineeId,
          fullName: facts.full_name,
          enabled: input.enabled,
          actor: input.actor,
          eventRef: input.eventRef,
          trackCode: facts.track_code,
        },
        await recipients.forIt(),
      );
      return await sendOnce(message.kind, input.traineeId, message.refs.ref, message);
    },
  };
}
