import { z } from 'zod';
import { TRACK_CODES } from '../constants.js';
import type { TrackCode } from '../constants.js';

// Manager contract (S07): the roster, the stuck list, one trainee's detail,
// the "preview as track" stage list and the read-only config view.
//
// This file ships to the browser, so it holds SHAPES only. Nothing here can
// carry lesson HTML or a correct answer, and the manager screens never get
// either: a manager who wants to read a lesson signs in and takes the track.
//
// Every route behind this contract is requireAuth + requireRole('MANAGER')
// behind the ACADEMY_V2 flag. A STAFF session gets 403 { error: 'forbidden' }.

const TrackSchema = z.enum(TRACK_CODES as [TrackCode, ...TrackCode[]]);

/** academy.trainees.status (0001 CHECK). */
export const TRAINEE_STATUSES = ['ACTIVE', 'PAUSED', 'LEFT', 'COMPLETED'] as const;
export const TraineeStatusSchema = z.enum(TRAINEE_STATUSES);
export type TraineeStatus = z.infer<typeof TraineeStatusSchema>;

/** A trainee is "online now" when a live session was seen this recently. */
export const ONLINE_WINDOW_MINUTES = 3;

/**
 * One stage chip on a roster row: how many goes it took, the best mark and how
 * many of those goes failed. Only stages the trainee has actually attempted are
 * sent, in their own track's order — the roster shows a record, not a syllabus.
 *
 * No title, no lesson, no question: the roster names the stage by its badge
 * number only ("S3"), so nothing content-shaped travels with the list.
 */
export const RosterStageSchema = z.object({
  code: z.string(),
  /** The badge text: '3', 'A1', 'IT2'. */
  displayNum: z.string(),
  attempts: z.number().int(),
  best: z.number().nullable(),
  fails: z.number().int(),
  passed: z.boolean(),
});
export type RosterStage = z.infer<typeof RosterStageSchema>;

/** One row of the manager roster. Timestamps are ISO 8601 strings. */
export const RosterTraineeSchema = z.object({
  id: z.number().int(),
  fullName: z.string(),
  email: z.string(),
  /** null while the manager has not assigned a track yet (D13). */
  track: TrackSchema.nullable(),
  status: TraineeStatusSchema,
  isDisabled: z.boolean(),
  /** A live session seen in the last ONLINE_WINDOW_MINUTES minutes. */
  onlineNow: z.boolean(),
  lastSeenAt: z.string().nullable(),
  /** Latest of quiz, lesson, listening and heartbeat activity. */
  lastActivityAt: z.string().nullable(),
  /** Stages this trainee's track makes visible (0 while waiting for a track). */
  stagesTotal: z.number().int(),
  /** Of those, the ones passed. */
  stagesDone: z.number().int(),
  /** The first visible stage they have not passed: where they are now. */
  currentStageCode: z.string().nullable(),
  currentStageTitle: z.string().nullable(),
  /** That stage's badge text, so the roster can read "Stage 6 · …". */
  currentStageDisplayNum: z.string().nullable(),
  /** Quiz attempts across every stage. */
  attempts: z.number().int(),
  /** Attempts that did not pass. */
  fails: z.number().int(),
  /** Mean of their best score per attempted stage, null with no attempts. */
  bestAverage: z.number().nullable(),
  /**
   * academy.progression_authorisations. Only meaningful while
   * STAGE1_AUTH_REQUIRED is on; the roster hides the column when it is off.
   */
  stage1Authorised: z.boolean(),
  /** Attempted stages only, in track order, never longer than the track. */
  stages: z.array(RosterStageSchema),
  startedAt: z.string(),
});
export type RosterTrainee = z.infer<typeof RosterTraineeSchema>;

/** The counts describe the rows in THIS response, after any filter. */
export const RosterCountsSchema = z.object({
  total: z.number().int(),
  active: z.number().int(),
  disabled: z.number().int(),
  onlineNow: z.number().int(),
  waitingForTrack: z.number().int(),
});
export type RosterCounts = z.infer<typeof RosterCountsSchema>;

/** GET /api/manager/roster */
export const RosterResponseSchema = z.object({
  trainees: z.array(RosterTraineeSchema),
  counts: RosterCountsSchema,
});
export type RosterResponse = z.infer<typeof RosterResponseSchema>;

export const StuckReasonSchema = z.enum(['repeated_fails', 'inactive', 'both']);
export type StuckReason = z.infer<typeof StuckReasonSchema>;

/**
 * A trainee the dashboard flags: 3+ fails on a stage they have not passed, or
 * 7 days with no activity at all (counted from their start date, so someone
 * who never began is flagged too).
 */
export const StuckTraineeSchema = z.object({
  id: z.number().int(),
  fullName: z.string(),
  track: TrackSchema.nullable(),
  reason: StuckReasonSchema,
  /** The uncompleted stage with the most fails, null when that is not the reason. */
  stuckStageCode: z.string().nullable(),
  stageFails: z.number().int(),
  /** Whole days since their last activity (or their start date). */
  inactiveDays: z.number().int().nullable(),
  lastActivityAt: z.string().nullable(),
});
export type StuckTrainee = z.infer<typeof StuckTraineeSchema>;

/** GET /api/manager/stuck */
export const StuckResponseSchema = z.object({
  trainees: z.array(StuckTraineeSchema),
});
export type StuckResponse = z.infer<typeof StuckResponseSchema>;

/** One chip on the trainee detail: a stage and how they did on it. */
export const TraineeStageSchema = z.object({
  code: z.string(),
  title: z.string(),
  displayNum: z.string(),
  level: z.number().int().nullable(),
  dept: z.string().nullable(),
  /** Exactly the state the trainee sees: the same server-side unlock rule. */
  state: z.enum(['locked', 'available', 'done']),
  attempts: z.number().int(),
  best: z.number().nullable(),
  fails: z.number().int(),
  lastAttemptAt: z.string().nullable(),
});
export type TraineeStage = z.infer<typeof TraineeStageSchema>;

/** GET /api/manager/trainee/:id */
export const TraineeDetailSchema = z.object({
  trainee: RosterTraineeSchema,
  stages: z.array(TraineeStageSchema),
});
export type TraineeDetail = z.infer<typeof TraineeDetailSchema>;

/** One stage of a previewed track. No lesson bodies, no questions, no answers. */
export const PreviewStageSchema = z.object({
  code: z.string(),
  title: z.string(),
  displayNum: z.string(),
  level: z.number().int().nullable(),
  dept: z.string().nullable(),
  /** 1-based position in that track's unlock order. */
  position: z.number().int(),
  lessonCount: z.number().int(),
  recordingCount: z.number().int(),
  questionCount: z.number().int(),
  passMark: z.number().int(),
});
export type PreviewStage = z.infer<typeof PreviewStageSchema>;

/** GET /api/manager/preview/:track — read only, writes no progress for anyone. */
export const PreviewTrackResponseSchema = z.object({
  track: TrackSchema,
  stages: z.array(PreviewStageSchema),
});
export type PreviewTrackResponse = z.infer<typeof PreviewTrackResponseSchema>;

/**
 * GET /api/manager/config — S07 task 4. The gate switch is SURFACED, not
 * editable: these are environment flags, changed by ops and nobody else.
 */
export const ManagerConfigSchema = z.object({
  stage1AuthRequired: z.boolean(),
  academyV2: z.boolean(),
  provisioning: z.boolean(),
});
export type ManagerConfig = z.infer<typeof ManagerConfigSchema>;

/** Every manager failure is { error: ManagerErrorCode }, status as noted. */
export const MANAGER_ERROR_CODES = [
  'forbidden', // 403 a STAFF session, or no manager role
  'not_found', // 404 no such trainee or track
  'invalid_request', // 400 malformed parameter or body
  'rate_limited', // 429 too many exports in a row
] as const;
export const ManagerErrorSchema = z.object({ error: z.enum(MANAGER_ERROR_CODES) });
export type ManagerError = z.infer<typeof ManagerErrorSchema>;
