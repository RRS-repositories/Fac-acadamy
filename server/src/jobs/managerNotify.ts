// manager-notify: the job payloads and the handler that turns them into a
// notification.
//
// The consumer used to be "a Mattermost DM to the trainee's manager".
// Mattermost was dropped on 23 Sep 2026 and no email provider has been chosen
// yet, so the handler composes the message, records it and logs it, and sends
// nothing (shadow mode). See modules/notifications.
//
// Payloads carry ids and codes only — never a name, an email or a score
// comment — so a queue dump is not a staff-data leak. The names the message
// needs are read out of the database by the handler, in the worker.

import type { TrackCode } from '@fac-academy/shared';
import type { NotificationRules } from '../modules/notifications/index.js';
import type { JobHandler } from '../queues/runtime.js';

/** Job names inside the manager-notify queue. */
export const MANAGER_NOTIFY_JOBS = {
  /** A trainee finished every visible stage of a level. */
  levelComplete: 'level-complete',
  /** A trainee finished both modules of their department academy. */
  deptComplete: 'dept-complete',
  /** A trainee just failed a stage quiz; the handler checks for a streak. */
  stageFail: 'stage-fail',
} as const;

export type ManagerNotifyJobName = (typeof MANAGER_NOTIFY_JOBS)[keyof typeof MANAGER_NOTIFY_JOBS];

export interface LevelCompleteJob {
  traineeId: number;
  /** levels.level_number (1..5), not the row id. */
  level: number;
  track: TrackCode;
}

export interface DeptCompleteJob {
  traineeId: number;
  /** departments.code, which is also the trainee's track code. */
  dept: string;
  track: TrackCode;
}

export interface StageFailJob {
  traineeId: number;
  /** stages.id the attempt belongs to. */
  stageId: number;
  /** quiz_attempts.id: unique, so it doubles as the job's idempotency key. */
  attemptId: number;
  track: TrackCode;
}

/**
 * The manager-notify consumer.
 *
 * Every branch is idempotent: the rules claim a row in
 * `academy.notifications_sent` (unique on kind + trainee + ref) before they
 * compose anything, so a retried job, a restarted worker or a fourth failed
 * attempt arriving at the same time as the third all end in ONE message.
 */
export function createManagerNotifyHandler(rules: NotificationRules): JobHandler {
  return async (job) => {
    switch (job.name) {
      case MANAGER_NOTIFY_JOBS.levelComplete: {
        const data = job.data as LevelCompleteJob;
        await rules.onLevelComplete(data);
        return;
      }
      case MANAGER_NOTIFY_JOBS.deptComplete: {
        const data = job.data as DeptCompleteJob;
        await rules.onDeptComplete(data);
        return;
      }
      case MANAGER_NOTIFY_JOBS.stageFail: {
        const data = job.data as StageFailJob;
        await rules.onStageFail(data);
        return;
      }
      default:
        // An unknown job name is a bug, not a transient fault. Throwing sends
        // it to the dead-letter bay, where it is visible, instead of looping.
        throw new Error(`manager-notify: unknown job name ${JSON.stringify(job.name)}`);
    }
  };
}
