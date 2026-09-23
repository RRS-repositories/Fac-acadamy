import type { StageQuizSummary, StageResponse } from '@fac-academy/shared';
import {
  NO_ATTEMPTS,
  countQuestions,
  loadAttemptStats,
  loadCompletedStageIds,
  loadLessons,
  loadQuizPrerequisite,
  loadRecordings,
  loadStageCounts,
} from './repo.js';
import type { StageCounts, StageRow, TrainingDeps } from './repo.js';
import { toTrackStage } from './track.js';

// GET /api/stage/:code, for a stage gate() has already allowed. The lesson
// HTML served here is the ONLY place the browser can get it from.

const NO_COUNTS: StageCounts = { lessonCount: 0, recordingCount: 0, recordingsWithMedia: 0 };

export async function buildStage(
  deps: TrainingDeps,
  traineeId: number,
  stage: StageRow,
): Promise<StageResponse> {
  const ids = [stage.id];
  const [counts, stats, completed, lessons, recordings, prerequisite, questionCount] =
    await Promise.all([
      loadStageCounts(deps.db, ids),
      loadAttemptStats(deps.db, traineeId, ids),
      loadCompletedStageIds(deps.db, traineeId, ids),
      loadLessons(deps.db, traineeId, stage.id),
      loadRecordings(deps.db, traineeId, stage.id),
      loadQuizPrerequisite(deps.db, traineeId, stage.id),
      countQuestions(deps.db, stage.id),
    ]);

  const passed = completed.has(stage.id);
  const attemptStats = stats.get(stage.id) ?? NO_ATTEMPTS;
  const quiz: StageQuizSummary = {
    questionCount,
    passMark: stage.passMark,
    attempts: attemptStats.attempts,
    best: attemptStats.best,
    passed,
    unlocked: prerequisite.unlocked,
    blockedBy: prerequisite.blockedBy,
  };

  return {
    // gate() allowed this stage, so it is 'done' or 'available', never locked.
    stage: toTrackStage(
      stage,
      passed ? 'done' : 'available',
      attemptStats,
      counts.get(stage.id) ?? NO_COUNTS,
    ),
    lessons,
    recordings,
    quiz,
  };
}
