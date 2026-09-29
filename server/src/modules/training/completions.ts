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
// - A DEPARTMENT is complete when every module of it that the track can see is
//   passed. That used to be written down as "both of its modules", which was
//   true right up until Admin gained a third.
//
// Visibility is read straight from `academy.track_visibility` here rather than
// through the track/stage repository, so a completion can never disagree with
// the table the unlock order itself is built from, and a completion check is
// one round trip inside the transaction.
//
// ---------------------------------------------------------------------------
// WHAT A COMPLETION COVERS, AND WHY IT IS NOW WRITTEN DOWN (29 Sep 2026)
// ---------------------------------------------------------------------------
// An academy can grow. Admin went from two modules to three, with the new one
// inserted in the middle, and people had already finished it. Their completion
// row survives — but the dashboard recomputes live, so it shows them "2 of 3",
// and the old `ON CONFLICT ... DO NOTHING` meant that going and doing the new
// module wrote nothing, returned nothing, and earned them nothing.
//
// So a completion now records its SCOPE: how many modules (or stages) it
// covered, counted over what the trainee's track could see at the time. With
// that one number the cases separate cleanly:
//
//   no row yet                 the first completion. Unchanged behaviour.
//   now bigger than recorded   the academy grew and they have now finished the
//                              bigger one. Move the scope up, stamp
//                              recompleted_at, and let the caller issue a NEW
//                              certificate. The old one stays valid — it is a
//                              true record of the academy they finished.
//   now equal to recorded      nothing new happened (a retake). Write nothing.
//   now smaller than recorded  the academy shrank. Leave the row alone: a
//                              scope is never written downwards, or growing
//                              back to the old size would mint a duplicate.
//   recorded scope UNKNOWN     a row from before migration 0013 whose scope
//                              could not be inferred. We cannot tell a grown
//                              academy from an unchanged one, so we do nothing
//                              rather than guess. 0013 counts these when it
//                              runs; the expected count is zero.
//
// Idempotency is the database's job, not a read-then-write here: the insert is
// `ON CONFLICT ... DO UPDATE ... WHERE <the scope really grew>`, so two submits
// that finish the same academy at the same moment leave one row and exactly one
// of them is told it was the one that did it. Passing the same stage twice can
// never mint a second certificate, because the second pass finds the scope
// already at its new value and writes nothing.

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
  /** How many stages of the level this completion covers. */
  stagesCovered: number;
  /**
   * True when this completion replaced a smaller one, i.e. the level had
   * gained a stage since they finished it. False on a first completion.
   */
  afterGrowth: boolean;
}

export interface DeptCompletion {
  /** departments.code. */
  dept: string;
  /** How many modules of the academy this completion covers. */
  modulesCovered: number;
  /** True when the academy had grown since an earlier completion. */
  afterGrowth: boolean;
}

export interface CompletionOutcome {
  /** True the first time this stage is passed; false on a later retake. */
  stageNewlyPassed: boolean;
  /** Set only when THIS pass completed the level, or re-completed a grown one. */
  level: LevelCompletion | null;
  /**
   * Set only when THIS pass completed the department academy, or re-completed
   * one that has grown since.
   */
  dept: DeptCompletion | null;
}

/**
 * Record a passing attempt and recompute what it completes.
 *
 * Concurrency: every write is an `INSERT ... ON CONFLICT`, so two submits that
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
 *
 * That last part carries more weight than it used to: migration 0013 infers
 * what an old completion covered from the stage passes recorded before it,
 * which is only sound because a retake leaves `completed_at` where it was.
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
 * Is every stage of `levelId` that `track` can see passed? If so, write (or
 * widen) the level_completions row. Returns the level only when this call
 * wrote it: the first completion, or a re-completion of a level that has
 * gained a stage since.
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

  const written = await writeCompletion(
    client,
    `INSERT INTO academy.level_completions (trainee_id, level_id, stages_covered)
     VALUES ($1, $2, $3)
     ON CONFLICT (trainee_id, level_id) DO UPDATE
        SET stages_covered = EXCLUDED.stages_covered,
            recompleted_at = now()
      WHERE level_completions.stages_covered IS NOT NULL
        AND level_completions.stages_covered < EXCLUDED.stages_covered
     RETURNING (xmax = 0) AS first_time`,
    [traineeId, row.level_id, row.visible],
  );
  if (written === null) return null;

  return {
    levelId: row.level_id,
    levelNumber: row.level_number,
    stagesCovered: row.visible,
    afterGrowth: !written.firstTime,
  };
}

/**
 * Every module of the department academy that `track` can see passed? If so,
 * write (or widen) dept_completions (the department certificate in S09).
 * Returns the department only when this call wrote the row: the first
 * completion, or a re-completion of an academy that has gained a module since.
 */
export async function completeDeptIfDone(
  client: PoolClient,
  traineeId: number,
  track: TrackCode,
  dept: string,
): Promise<DeptCompletion | null> {
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

  const written = await writeCompletion(
    client,
    `INSERT INTO academy.dept_completions (trainee_id, dept, modules_covered)
     VALUES ($1, $2, $3)
     ON CONFLICT (trainee_id, dept) DO UPDATE
        SET modules_covered = EXCLUDED.modules_covered,
            recompleted_at  = now()
      WHERE dept_completions.modules_covered IS NOT NULL
        AND dept_completions.modules_covered < EXCLUDED.modules_covered
     RETURNING (xmax = 0) AS first_time`,
    [traineeId, dept, row.modules],
  );
  if (written === null) return null;

  return { dept, modulesCovered: row.modules, afterGrowth: !written.firstTime };
}

/**
 * Run one of the two completion upserts above and say what it did.
 *
 * `null` means the statement changed nothing, which folds every "no news" case
 * into one: the completion is already recorded at this scope (a retake), the
 * academy has shrunk, or the recorded scope is unknown and cannot be compared.
 * None of those may issue a certificate, so none of them is worth telling
 * apart here.
 *
 * `firstTime` comes from `xmax = 0` — true only when the row was inserted, as
 * opposed to widened — so the caller can tell a first completion from a
 * re-completion without reading the row back.
 */
async function writeCompletion(
  client: PoolClient,
  sql: string,
  params: unknown[],
): Promise<{ firstTime: boolean } | null> {
  const { rows } = await client.query<{ first_time: boolean }>(sql, params);
  const row = rows[0];
  return row === undefined ? null : { firstTime: row.first_time };
}
