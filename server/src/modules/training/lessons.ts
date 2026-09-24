import { actor, writeAudit } from '../audit/audit.js';
import { gate } from './gate.js';
import type { GateDenial } from './gate.js';
import { findLesson, markLessonRead } from './repo.js';
import type { TrainingDeps } from './repo.js';

// POST /api/lesson/:id/read. Idempotent, gated, audited.

export type LessonReadResult =
  | { ok: true; stageCode: string; firstRead: boolean }
  | { ok: false; reason: GateDenial; requires?: string };

export async function readLesson(
  deps: TrainingDeps,
  traineeId: number,
  lessonId: number,
): Promise<LessonReadResult> {
  const lesson = await findLesson(deps.db, lessonId);
  if (lesson === null) return { ok: false, reason: 'not_found' };

  // The same gate as the content routes: a lesson is only as open as its stage.
  const allowed = await gate(deps.db, traineeId, lesson.stageCode, {
    stage1AuthRequired: deps.stage1AuthRequired,
  });
  if (!allowed.allowed) {
    return allowed.requires === undefined
      ? { ok: false, reason: allowed.reason }
      : { ok: false, reason: allowed.reason, requires: allowed.requires };
  }

  const firstRead = await markLessonRead(deps.db, traineeId, lessonId);
  // Audited once: a repeated call is a no-op, not a second event.
  if (firstRead) {
    await writeAudit(deps.db, {
      traineeId,
      eventType: 'LESSON_READ',
      actor: actor.trainee(traineeId),
      payload: { lessonId, stage: lesson.stageCode },
    });
  }
  return { ok: true, stageCode: lesson.stageCode, firstRead };
}
