import { z } from 'zod';
import { TRACK_CODES } from '../constants.js';
import type { TrackCode } from '../constants.js';

// Training contract (S04): the track list, a stage's detail, and the quiz.
// This file ships to the browser, so it holds SHAPES only — never lesson HTML,
// never a question's correct answer. The server is the only source of both.
//
// The stage list a trainee sees comes from academy.track_visibility in
// position order. Position 0 is always available; every later stage needs the
// previous visible stage passed (server-side `gate()`, never the client).

export const StageStateSchema = z.enum(['locked', 'available', 'done']);
export type StageState = z.infer<typeof StageStateSchema>;

/** One row of the trainee's journey: the stage plus their progress on it. */
export const TrackStageSchema = z.object({
  /** Stable stage code from the prototype: 's1', 'cscalls', 'l2s1', 'dA1'. */
  code: z.string(),
  title: z.string(),
  blurb: z.string(),
  /** Badge text: '1', 'A1', 'IT2'. */
  displayNum: z.string(),
  /** Level number (1-5), or null for a department module. */
  level: z.number().int().nullable(),
  /** Department code ('ADMIN', 'FOS', ...), or null for a level stage. */
  dept: z.string().nullable(),
  /** 1-based position in THIS trainee's track, the unlock order. */
  position: z.number().int(),
  state: StageStateSchema,
  /** Best attempt percentage, 0 when there are no attempts yet. */
  pct: z.number(),
  attempts: z.number().int(),
  /** Best attempt percentage, null when there are no attempts yet. */
  best: z.number().nullable(),
  passMark: z.number().int(),
  lessonCount: z.number().int(),
  recordingCount: z.number().int(),
  /** Recordings with media. The rest are "coming soon" slots (D4). */
  recordingsWithMedia: z.number().int(),
});
export type TrackStage = z.infer<typeof TrackStageSchema>;

/**
 * GET /api/track. A trainee with no track yet (D13) gets
 * `{ track: null, waitingForTrack: true, stages: [] }`.
 */
export const TrackResponseSchema = z.object({
  track: z.enum(TRACK_CODES as [TrackCode, ...TrackCode[]]).nullable(),
  waitingForTrack: z.boolean(),
  stages: z.array(TrackStageSchema),
});
export type TrackResponse = z.infer<typeof TrackResponseSchema>;

export const StageLessonSchema = z.object({
  id: z.number().int(),
  title: z.string(),
  /** Sanitised lesson HTML. Served only for an unlocked stage. */
  bodyHtml: z.string(),
  position: z.number().int(),
  read: z.boolean(),
});
export type StageLesson = z.infer<typeof StageLessonSchema>;

export const StageRecordingSchema = z.object({
  id: z.number().int(),
  title: z.string(),
  description: z.string(),
  durationSecs: z.number().int().nullable(),
  mediaType: z.enum(['AUDIO', 'VIDEO']),
  /** D4: an empty slot. Shown greyed out, and never blocks the quiz. */
  comingSoon: z.boolean(),
  listened: z.boolean(),
});
export type StageRecording = z.infer<typeof StageRecordingSchema>;

export const StageQuizSummarySchema = z.object({
  questionCount: z.number().int(),
  passMark: z.number().int(),
  attempts: z.number().int(),
  best: z.number().nullable(),
  passed: z.boolean(),
  /** False until the stage's lessons (and, from S06, its recordings) are done. */
  unlocked: z.boolean(),
  blockedBy: z.enum(['lessons', 'recordings']).nullable(),
});
export type StageQuizSummary = z.infer<typeof StageQuizSummarySchema>;

/** GET /api/stage/:code when the gate allows it. */
export const StageResponseSchema = z.object({
  stage: TrackStageSchema,
  lessons: z.array(StageLessonSchema),
  recordings: z.array(StageRecordingSchema),
  quiz: StageQuizSummarySchema,
});
export type StageResponse = z.infer<typeof StageResponseSchema>;

/**
 * 403 on a locked stage. `requires` is the stage code they must pass first,
 * and null when the block is their missing track (D13) rather than a stage.
 * Deliberately says nothing else about the stage.
 */
export const LockedResponseSchema = z.object({
  error: z.literal('locked'),
  requires: z.string().nullable(),
});
export type LockedResponse = z.infer<typeof LockedResponseSchema>;

/** A quiz question as the browser sees it: NEVER a correct flag. */
export const QuizQuestionSchema = z.object({
  id: z.number().int(),
  prompt: z.string(),
  options: z.array(z.object({ id: z.number().int(), text: z.string() })),
});
export type QuizQuestion = z.infer<typeof QuizQuestionSchema>;

export const QuizResponseSchema = z.object({
  stageCode: z.string(),
  passMark: z.number().int(),
  questions: z.array(QuizQuestionSchema),
});
export type QuizResponse = z.infer<typeof QuizResponseSchema>;

export const QuizSubmitRequestSchema = z.object({
  answers: z
    .array(z.object({ questionId: z.number().int(), optionId: z.number().int() }))
    .min(1)
    .max(200),
});
export type QuizSubmitRequest = z.infer<typeof QuizSubmitRequestSchema>;

/**
 * The graded result. D3: after a FAIL the trainee sees right/wrong only
 * (`correctOptionId` is null); the correct answers are revealed only once they
 * have passed, to stop "fail once, copy the answers, pass".
 */
export const QuizResultSchema = z.object({
  attemptId: z.number().int(),
  pct: z.number(),
  passed: z.boolean(),
  correctCount: z.number().int(),
  total: z.number().int(),
  perQuestion: z.array(
    z.object({
      questionId: z.number().int(),
      correct: z.boolean(),
      correctOptionId: z.number().int().nullable(),
    }),
  ),
});
export type QuizResult = z.infer<typeof QuizResultSchema>;

/** Every training failure is { error: TrainingErrorCode }, status as noted. */
export const TRAINING_ERROR_CODES = [
  'locked', // 403 the stage is not unlocked yet (LockedResponse adds `requires`)
  'not_found', // 404 no such stage or lesson, or it is not in this track
  'lessons_incomplete', // 403 quiz requested before every lesson was read
  'recordings_incomplete', // 403 quiz requested before every recording was heard (S06)
  'invalid_request', // 400 malformed body or parameter
  'no_track', // 403 no track assigned yet (D13)
] as const;
export const TrainingErrorSchema = z.object({ error: z.enum(TRAINING_ERROR_CODES) });
export type TrainingError = z.infer<typeof TrainingErrorSchema>;
