import type {
  StageState,
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

export async function buildTrack(deps: TrainingDeps, traineeId: number): Promise<TrackResponse> {
  const visible = await visibleStages(deps.db, traineeId);
  // D13: no track yet. The home page says "waiting for a manager".
  if (visible.track === null)
    return { track: null, waitingForTrack: true, stages: [], levels: [], depts: [] };

  const ids = visible.stages.map((s) => s.id);
  const [progression, counts, stats, headings] = await Promise.all([
    loadProgression(deps.db, traineeId, visible.stages, deps.stage1AuthRequired),
    loadStageCounts(deps.db, ids),
    loadAttemptStats(deps.db, traineeId, ids),
    loadHeadings(deps, visible.stages),
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
 * Level and department headings for the stages this trainee can see. The
 * wording (names, weeks, accomplishments) is seeded from the prototype, so it
 * lives in the database and never in the browser bundle.
 */
async function loadHeadings(
  deps: TrainingDeps,
  stages: { level: number | null; dept: string | null }[],
): Promise<{ levels: TrackLevel[]; depts: TrackDept[] }> {
  const levelNumbers = [
    ...new Set(stages.map((s) => s.level).filter((n): n is number => n !== null)),
  ];
  const deptCodes = [...new Set(stages.map((s) => s.dept).filter((d): d is string => d !== null))];

  const [levels, depts] = await Promise.all([
    levelNumbers.length === 0
      ? Promise.resolve({ rows: [] as TrackLevel[] })
      : deps.db.query<TrackLevel>(
          `SELECT level_number AS level, name, weeks_label AS weeks, accomplishment, description
             FROM academy.levels WHERE level_number = ANY($1::int[]) ORDER BY level_number`,
          [levelNumbers],
        ),
    deptCodes.length === 0
      ? Promise.resolve({ rows: [] as TrackDept[] })
      : deps.db.query<TrackDept>(
          `SELECT code, academy_name AS name, icon, accomplishment, description
             FROM academy.departments WHERE code = ANY($1::text[]) ORDER BY sort`,
          [deptCodes],
        ),
  ]);
  return { levels: levels.rows, depts: depts.rows };
}
