import type { Pool, PoolClient } from 'pg';
import type { StuckResponse, StuckTrainee } from '@fac-academy/shared';
import { toTrackCode } from '../training/repo.js';
import { toIso } from './deps.js';

// The "needs a hand" panel (S07 task 1). The rule lives in the database, in
// academy.v_stuck_trainees (migration 0002, defect X8): an ACTIVE, not-disabled
// trainee with either
//   * 3 or more failed attempts on a stage they have not passed, or
//   * no activity for 7 days — counted from started_at when there has been no
//     activity at all, so someone who signed up and never began is flagged.
// This file adds only what the view cannot carry: the stage CODE behind
// stuck_stage_id, and the inactivity in whole days.

type Db = Pool | PoolClient;

interface StuckRow {
  id: string;
  full_name: string;
  track: string | null;
  stuck_code: string | null;
  stage_fails: number;
  repeated_fails: boolean;
  inactive: boolean;
  inactive_days: number;
  last_activity: Date | null;
}

const STUCK_SQL = `
  SELECT v.id,
         v.full_name,
         v.track,
         s.code                                   AS stuck_code,
         v.stage_fails::int                       AS stage_fails,
         v.repeated_fails,
         v.inactive,
         v.last_activity,
         GREATEST(
           0,
           floor(EXTRACT(EPOCH FROM (now() - v.inactive_since)) / 86400)
         )::int                                   AS inactive_days
    FROM academy.v_stuck_trainees v
    LEFT JOIN academy.stages s ON s.id = v.stuck_stage_id
   ORDER BY v.repeated_fails DESC, v.stage_fails DESC, v.inactive_since, v.full_name`;

function reasonOf(r: StuckRow): StuckTrainee['reason'] {
  if (r.repeated_fails && r.inactive) return 'both';
  return r.repeated_fails ? 'repeated_fails' : 'inactive';
}

export async function loadStuck(db: Db): Promise<StuckTrainee[]> {
  const { rows } = await db.query<StuckRow>(STUCK_SQL);
  return rows.map((r) => ({
    id: Number(r.id),
    fullName: r.full_name,
    track: toTrackCode(r.track),
    reason: reasonOf(r),
    // Only meaningful when repeated fails are (part of) the reason.
    stuckStageCode: r.repeated_fails ? r.stuck_code : null,
    stageFails: r.stage_fails,
    inactiveDays: r.inactive_days,
    lastActivityAt: toIso(r.last_activity),
  }));
}

export async function buildStuck(db: Db): Promise<StuckResponse> {
  return { trainees: await loadStuck(db) };
}
