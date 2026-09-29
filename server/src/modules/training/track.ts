import type {
  StageState,
  TrackCode,
  TrackDept,
  TrackLevel,
  TrackResponse,
  TrackStage,
} from '@fac-academy/shared';
import { loadProgression, stageStates, visibleStages } from './gate.js';
import { NO_ATTEMPTS, loadAttemptStats, loadStageCounts } from './repo.js';
import type { AttemptStats, StageCounts, StageRow, TrainingDeps } from './repo.js';

// GET /api/track: the trainee's journey. The order is their track's
// track_visibility order, and the state of every stage comes from the same
// gate rule the content routes use (gate.ts: stageStates).

const NO_COUNTS: StageCounts = { lessonCount: 0, recordingCount: 0, recordingsWithMedia: 0 };

/**
 * Only what building the track actually needs. A full `TrainingDeps` satisfies
 * it, so routes.ts passes its own deps straight through, but a test does not
 * have to build a session manager to ask what a trainee's journey looks like.
 * Same shape of narrowing as `QuizRouterDeps`.
 */
export type TrackDeps = Pick<TrainingDeps, 'db' | 'stage1AuthRequired'>;

export function toTrackStage(
  stage: StageRow,
  state: StageState,
  stats: AttemptStats,
  counts: StageCounts,
): TrackStage {
  return {
    code: stage.code,
    title: stage.title,
    blurb: stage.blurb,
    displayNum: stage.displayNum,
    level: stage.level,
    dept: stage.dept,
    position: stage.position,
    state,
    pct: stats.best ?? 0,
    attempts: stats.attempts,
    best: stats.best,
    passMark: stage.passMark,
    ...counts,
  };
}

export async function buildTrack(deps: TrackDeps, traineeId: number): Promise<TrackResponse> {
  const visible = await visibleStages(deps.db, traineeId);
  // D13: no track yet. The home page says "waiting for a manager".
  if (visible.track === null)
    return { track: null, waitingForTrack: true, stages: [], levels: [], depts: [] };

  const ids = visible.stages.map((s) => s.id);
  const [progression, counts, stats, headings] = await Promise.all([
    loadProgression(deps.db, traineeId, visible.stages, deps.stage1AuthRequired),
    loadStageCounts(deps.db, ids),
    loadAttemptStats(deps.db, traineeId, ids),
    loadHeadings(deps, traineeId, visible.track, visible.stages),
  ]);
  const states = stageStates(visible.stages, progression, deps.stage1AuthRequired);

  return {
    track: visible.track,
    waitingForTrack: false,
    levels: headings.levels,
    depts: headings.depts,
    stages: visible.stages.map((stage, i) =>
      toTrackStage(
        stage,
        states[i] ?? 'locked',
        stats.get(stage.id) ?? NO_ATTEMPTS,
        counts.get(stage.id) ?? NO_COUNTS,
      ),
    ),
  };
}

/**
 * Level and department headings for the stages this trainee can see, plus what
 * they have already finished there.
 *
 * The wording (names, weeks, accomplishments) is training content, so it comes
 * from the database and never from a constant in the bundle.
 *
 * The completion facts alongside it answer one question the dashboard could
 * not previously answer: an academy that has GROWN since the trainee finished
 * it shows them "2 of 3" and a module waiting, with nothing to say why. So the
 * server sends what it already knows — when they finished it, how much that
 * covered, and how much it covers now — and the browser only draws it.
 *
 * `currentCount` is counted over academy.track_visibility for THIS trainee's
 * track, which is the same basis the completion rule itself uses
 * (completions.ts). Counting it any other way would let the notice disagree
 * with the rule that decides whether they are finished.
 */
async function loadHeadings(
  deps: TrackDeps,
  traineeId: number,
  track: TrackCode,
  stages: { level: number | null; dept: string | null }[],
): Promise<{ levels: TrackLevel[]; depts: TrackDept[] }> {
  const levelNumbers = [
    ...new Set(stages.map((s) => s.level).filter((n): n is number => n !== null)),
  ];
  const deptCodes = [...new Set(stages.map((s) => s.dept).filter((d): d is string => d !== null))];

  const [levels, depts] = await Promise.all([
    levelNumbers.length === 0
      ? Promise.resolve({ rows: [] as DbLevelHeading[] })
      : deps.db.query<DbLevelHeading>(
          `SELECT l.level_number AS level, l.name, l.weeks_label AS weeks,
                  l.accomplishment, l.description,
                  lc.completed_at, lc.stages_covered AS covered,
                  (SELECT count(*)::int
                     FROM academy.track_visibility tv
                     JOIN academy.stages s ON s.id = tv.stage_id
                    WHERE tv.track_code = $3 AND s.level_id = l.id) AS current_count
             FROM academy.levels l
             LEFT JOIN academy.level_completions lc
                    ON lc.level_id = l.id AND lc.trainee_id = $2
            WHERE l.level_number = ANY($1::int[])
            ORDER BY l.level_number`,
          [levelNumbers, traineeId, track],
        ),
    deptCodes.length === 0
      ? Promise.resolve({ rows: [] as DbDeptHeading[] })
      : deps.db.query<DbDeptHeading>(
          `SELECT d.code, d.academy_name AS name, d.icon, d.accomplishment, d.description,
                  dc.completed_at, dc.modules_covered AS covered,
                  (SELECT count(*)::int
                     FROM academy.track_visibility tv
                     JOIN academy.stages s ON s.id = tv.stage_id
                    WHERE tv.track_code = $3 AND s.dept = d.code) AS current_count
             FROM academy.departments d
             LEFT JOIN academy.dept_completions dc
                    ON dc.dept = d.code AND dc.trainee_id = $2
            WHERE d.code = ANY($1::text[])
            ORDER BY d.sort`,
          [deptCodes, traineeId, track],
        ),
  ]);

  return {
    levels: levels.rows.map((r) => ({
      level: r.level,
      name: r.name,
      weeks: r.weeks,
      accomplishment: r.accomplishment,
      description: r.description,
      ...completionScope(r),
    })),
    depts: depts.rows.map((r) => ({
      code: r.code,
      name: r.name,
      icon: r.icon,
      accomplishment: r.accomplishment,
      description: r.description,
      ...completionScope(r),
    })),
  };
}

/** The completion columns both headings share, straight off the row. */
interface DbCompletionScope {
  completed_at: Date | null;
  /** level_completions.stages_covered / dept_completions.modules_covered. */
  covered: number | null;
  current_count: number;
}

interface DbLevelHeading extends DbCompletionScope {
  level: number;
  name: string;
  weeks: string | null;
  accomplishment: string;
  description: string | null;
}

interface DbDeptHeading extends DbCompletionScope {
  code: string;
  name: string;
  icon: string | null;
  accomplishment: string | null;
  description: string | null;
}

/**
 * Has this trainee finished it, and has it grown since?
 *
 * `grownSince` is false whenever the answer cannot be told — no completion, or
 * a completion from before migration 0013 whose scope could not be inferred
 * (`covered` null, meaning UNKNOWN rather than zero). The dashboard would
 * otherwise tell somebody their academy had grown on the strength of a guess,
 * and the completion rule would not agree with it: it does nothing on an
 * unknown scope either.
 */
function completionScope(row: DbCompletionScope): {
  completedAt: string | null;
  completedCount: number | null;
  currentCount: number;
  grownSince: boolean;
} {
  const completedAt = row.completed_at === null ? null : row.completed_at.toISOString();
  const completedCount = row.covered === null ? null : Number(row.covered);
  const currentCount = Number(row.current_count);
  return {
    completedAt,
    completedCount,
    currentCount,
    grownSince: completedAt !== null && completedCount !== null && completedCount < currentCount,
  };
}
