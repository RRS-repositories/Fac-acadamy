import type { StageState, TrackResponse, TrackStage } from '@fac-academy/shared';
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
  if (visible.track === null) return { track: null, waitingForTrack: true, stages: [] };

  const ids = visible.stages.map((s) => s.id);
  const [progression, counts, stats] = await Promise.all([
    loadProgression(deps.db, traineeId, visible.stages, deps.stage1AuthRequired),
    loadStageCounts(deps.db, ids),
    loadAttemptStats(deps.db, traineeId, ids),
  ]);
  const states = stageStates(visible.stages, progression, deps.stage1AuthRequired);

  return {
    track: visible.track,
    waitingForTrack: false,
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
