// What a stage pass unlocks: the stage row itself, then the level, then the
// department academy. Every function here runs on the caller's transaction
// client, so a pass and everything it completes commit together or not at all.
//
// The rules mirror the prototype:
//
// - A LEVEL is complete when every stage of that level **that this trainee's
//   track can see** is passed (the prototype's `levelDone`, which counts over
//   `visibleStages()`, not over all stages). A Customer Service trainee never
//   sees s5, so s5 must not hold their Level 1 open.
// - A DEPARTMENT is complete when both of its modules are passed.
//
// Visibility is read straight from `academy.track_visibility` here rather than
// through the track/stage repository, so a completion can never disagree with
// the table the unlock order itself is built from, and a completion check is
// one round trip inside the transaction.

import type { PoolClient } from 'pg';
import type { TrackCode } from '@fac-academy/shared';

export interface StagePassInput {
  traineeId: number;
  stageId: number;
  /** The trainee's track: the visible-stage basis for the level rule. */
  track: TrackCode;
  /** The percentage just scored (0–100). */
  pct: number;
  /** stages.level_id — null for a department module. */
  levelId: number | null;
  /** stages.dept — null for a level stage. */
  dept: string | null;
}

export interface LevelCompletion {
  levelId: number;
  /** levels.level_number (1..5), the number people use. */
  levelNumber: number;
}

export interface CompletionOutcome {
  /** True the first time this stage is passed; false on a later retake. */
  stageNewlyPassed: boolean;
  /** Set only when THIS pass completed the level (first time). */
  level: LevelCompletion | null;
  /** departments.code, set only when THIS pass completed the department. */
  dept: string | null;
}

/**
 * Record a passing attempt and recompute what it completes.
 *
 * Concurrency: both writes are `INSERT ... ON CONFLICT`, so two submits that
 * pass at the same moment leave exactly one stage_completions row and one
 * level_completions row. The "newly" flags come from the insert itself
 * (`xmax = 0` / rowCount), never from a read-then-write, so only one of the
 * two requests reports the milestone and only one job is enqueued.
 */
export async function recordStagePass(
  client: PoolClient,
  input: StagePassInput,
): Promise<CompletionOutcome> {
  const stageNewlyPassed = await upsertStageCompletion(
    client,
    input.traineeId,
    input.stageId,
    input.pct,
  );

  const level =
    input.levelId === null
      ? null
      : await completeLevelIfDone(client, input.traineeId, input.track, input.levelId);

  const dept =
    input.dept === null
      ? null
      : await completeDeptIfDone(client, input.traineeId, input.track, input.dept);

  return { stageNewlyPassed, level, dept };
}

/**
 * Idempotent stage pass. `best_score` keeps the highest percentage ever
 * scored, so a later, worse retake never lowers it (and the completion row is
 * never rewritten to a new timestamp).
 */
export async function upsertStageCompletion(
  client: PoolClient,
  traineeId: number,
  stageId: number,
  pct: number,
): Promise<boolean> {
  const { rows } = await client.query<{ inserted: boolean }>(
    `INSERT INTO academy.stage_completions (trainee_id, stage_id, best_score)
     VALUES ($1, $2, $3)
     ON CONFLICT (trainee_id, stage_id) DO UPDATE
       SET best_score = GREATEST(COALESCE(stage_completions.best_score, 0), EXCLUDED.best_score)
     RETURNING (xmax = 0) AS inserted`,
    [traineeId, stageId, pct],
  );
  return rows[0]?.inserted === true;
}

/**
 * Is every stage of `levelId` that `track` can see passed? If so, write the
 * level_completions row. Returns the level only when this call wrote it.
 */
export async function completeLevelIfDone(
  client: PoolClient,
  traineeId: number,
  track: TrackCode,
  levelId: number,
): Promise<LevelCompletion | null> {
  const { rows } = await client.query<{
    level_id: number;
    level_number: number;
    visible: number;
    passed: number;
  }>(
    `SELECT l.id AS level_id,
            l.level_number,
            count(*)::int              AS visible,
            count(sc.trainee_id)::int  AS passed
       FROM academy.track_visibility tv
       JOIN academy.stages s  ON s.id = tv.stage_id
       JOIN academy.levels l  ON l.id = s.level_id
       LEFT JOIN academy.stage_completions sc
              ON sc.stage_id = s.id AND sc.trainee_id = $1
      WHERE tv.track_code = $2
        AND s.level_id = $3
      GROUP BY l.id, l.level_number`,
    [traineeId, track, levelId],
  );

  const row = rows[0];
  if (row === undefined || row.visible === 0 || row.passed < row.visible) return null;

  const inserted = await client.query(
    `INSERT INTO academy.level_completions (trainee_id, level_id)
     VALUES ($1, $2)
     ON CONFLICT (trainee_id, level_id) DO NOTHING`,
    [traineeId, row.level_id],
  );
  if (inserted.rowCount !== 1) return null; // already recorded

  return { levelId: row.level_id, levelNumber: row.level_number };
}

/**
 * Both modules of the department academy passed? If so, write
 * dept_completions (the department certificate in S09). Returns the
 * department code only when this call wrote the row.
 */
export async function completeDeptIfDone(
  client: PoolClient,
  traineeId: number,
  track: TrackCode,
  dept: string,
): Promise<string | null> {
  const { rows } = await client.query<{ modules: number; passed: number }>(
    `SELECT count(*)::int             AS modules,
            count(sc.trainee_id)::int AS passed
       FROM academy.track_visibility tv
       JOIN academy.stages s ON s.id = tv.stage_id
       LEFT JOIN academy.stage_completions sc
              ON sc.stage_id = s.id AND sc.trainee_id = $1
      WHERE tv.track_code = $2
        AND s.dept = $3`,
    [traineeId, track, dept],
  );

  const row = rows[0];
  if (row === undefined || row.modules === 0 || row.passed < row.modules) return null;

  const inserted = await client.query(
    `INSERT INTO academy.dept_completions (trainee_id, dept)
     VALUES ($1, $2)
     ON CONFLICT (trainee_id, dept) DO NOTHING`,
    [traineeId, dept],
  );
  if (inserted.rowCount !== 1) return null;

  return dept;
}
