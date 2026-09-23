// manager-notify: the job payloads. The consumer (a Mattermost DM to the
// trainee's manager) is wired in S08; nothing in this file sends anything.
//
// Payloads carry ids and codes only — never a name, an email or a score
// comment — so a queue dump is not a staff-data leak.

import type { TrackCode } from '@fac-academy/shared';

/** Job names inside the manager-notify queue. */
export const MANAGER_NOTIFY_JOBS = {
  /** A trainee finished every visible stage of a level. */
  levelComplete: 'level-complete',
  /** A trainee finished both modules of their department academy. */
  deptComplete: 'dept-complete',
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
