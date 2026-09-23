import type { Pool, PoolClient } from 'pg';
import { DEFAULT_PASS_MARK, TRACK_CODES } from '@fac-academy/shared';
import type { StageLesson, StageRecording, TrackCode } from '@fac-academy/shared';
import type { CertificateIssuer } from '../../certs/issue.js';
import type { RequireAuthDeps } from '../../middleware/auth.js';
import type { Producers } from '../../queues/producers.js';
import { sanitizeLessonHtml } from './sanitize.js';

// Every SQL statement the training module runs lives here or in gate.ts, so
// there is one place to read when checking what the server exposes. Nothing in
// this file decides access: that is gate.ts alone.

export type Db = Pool | PoolClient;

/**
 * S06 turned this on: a stage's quiz now needs every lesson read AND every
 * recording that HAS media listened right through (server-proved, see
 * media/coverage.ts). Slots with no `media_key` — the "coming soon" entries of
 * decision D4 — are never counted, so they can never hold a quiz up.
 * One constant, used by the stage detail and by the quiz router.
 */
export const RECORDINGS_GATE_ENABLED = true;

export interface TrainingDeps extends RequireAuthDeps {
  db: Pool;
  /** Config STAGE1_AUTH_REQUIRED: a manager must authorise past stage 1. */
  stage1AuthRequired: boolean;
  /**
   * Job producers for the quiz routes (manager-notify on a level or
   * department completion). Optional: when it is omitted the quiz router
   * falls back to an in-memory queue, so a test or a dev server without
   * Redis still works and nothing is silently dropped on the floor.
   */
  producers?: Producers;
  /**
   * S09: the certificate issuer. When a quiz pass completes a level or a
   * department academy, the quiz router issues the certificate right after the
   * commit. Optional: without it the pass still records and the certificate
   * job is still queued, so the worker produces the certificate instead.
   */
  certificates?: CertificateIssuer;
  /** Injectable clock, for tests. Defaults to Date.now. */
  now?: () => number;
}

/** A stage as this trainee sees it: stage columns + their track position. */
export interface StageRow {
  id: number;
  code: string;
  title: string;
  blurb: string;
  displayNum: string;
  level: number | null;
  dept: string | null;
  /** 1-based position in the trainee's track_visibility list. */
  position: number;
  passMark: number;
}

export interface VisibleStages {
  track: TrackCode | null;
  /** In track_visibility.position order. Empty when there is no track. */
  stages: StageRow[];
}

export interface StageCounts {
  lessonCount: number;
  recordingCount: number;
  recordingsWithMedia: number;
}

export interface AttemptStats {
  attempts: number;
  /** Best score, null when there are no attempts. */
  best: number | null;
}

export const NO_ATTEMPTS: AttemptStats = { attempts: 0, best: null };

export function toTrackCode(value: string | null): TrackCode | null {
  return value !== null && (TRACK_CODES as readonly string[]).includes(value)
    ? (value as TrackCode)
    : null;
}

// ---------------------------------------------------------------------------
// Stages
// ---------------------------------------------------------------------------

interface DbStage {
  id: string;
  code: string;
  title: string;
  blurb: string;
  display_num: string;
  level_number: number | null;
  dept: string | null;
  position: number;
  pass_mark: number;
}

export function toStageRow(r: DbStage): StageRow {
  return {
    id: Number(r.id),
    code: r.code,
    title: r.title,
    blurb: r.blurb,
    displayNum: r.display_num,
    level: r.level_number,
    dept: r.dept,
    position: r.position,
    passMark: r.pass_mark,
  };
}

/**
 * The stages of one track, in unlock order. The pass mark falls back the way
 * the schema intends: the quiz's, else the stage's, else the level's default,
 * else the shared default.
 */
export const VISIBLE_STAGES_SQL = `
  SELECT s.id,
         s.code,
         s.title,
         COALESCE(s.blurb, '')                              AS blurb,
         COALESCE(s.display_num, '')                        AS display_num,
         l.level_number,
         s.dept,
         v.position::int                                    AS position,
         COALESCE(q.pass_mark, s.pass_mark, l.default_pass_mark, $2)::int AS pass_mark
    FROM academy.track_visibility v
    JOIN academy.stages s  ON s.id = v.stage_id AND s.is_active
    LEFT JOIN academy.levels l  ON l.id = s.level_id
    LEFT JOIN academy.quizzes q ON q.stage_id = s.id
   WHERE v.track_code = $1
   ORDER BY v.position`;

export async function loadTrack(db: Db, traineeId: number): Promise<TrackCode | null> {
  const { rows } = await db.query<{ track: string | null }>(
    'SELECT track FROM academy.trainees WHERE id = $1',
    [traineeId],
  );
  return toTrackCode(rows[0]?.track ?? null);
}

export async function loadStagesForTrack(db: Db, track: TrackCode): Promise<StageRow[]> {
  const { rows } = await db.query<DbStage>(VISIBLE_STAGES_SQL, [track, DEFAULT_PASS_MARK]);
  return rows.map(toStageRow);
}

/** Does this stage code exist at all? Used to tell 404 from "another track". */
export async function stageExists(db: Db, code: string): Promise<boolean> {
  const { rows } = await db.query<{ ok: number }>(
    'SELECT 1 AS ok FROM academy.stages WHERE code = $1',
    [code],
  );
  return rows.length > 0;
}

// ---------------------------------------------------------------------------
// Progress
// ---------------------------------------------------------------------------

export async function loadCompletedStageIds(
  db: Db,
  traineeId: number,
  stageIds: number[],
): Promise<Set<number>> {
  if (stageIds.length === 0) return new Set();
  const { rows } = await db.query<{ stage_id: string }>(
    `SELECT stage_id FROM academy.stage_completions
      WHERE trainee_id = $1 AND stage_id = ANY($2::bigint[])`,
    [traineeId, stageIds],
  );
  return new Set(rows.map((r) => Number(r.stage_id)));
}

/** progression_authorisations.authorised, false when there is no row. */
export async function loadStage1Authorised(db: Db, traineeId: number): Promise<boolean> {
  const { rows } = await db.query<{ authorised: boolean }>(
    'SELECT authorised FROM academy.progression_authorisations WHERE trainee_id = $1',
    [traineeId],
  );
  return rows[0]?.authorised ?? false;
}

/** Attempts and best score per stage, for the stages asked about. */
export async function loadAttemptStats(
  db: Db,
  traineeId: number,
  stageIds: number[],
): Promise<Map<number, AttemptStats>> {
  const out = new Map<number, AttemptStats>();
  if (stageIds.length === 0) return out;
  const { rows } = await db.query<{ stage_id: string; attempts: string; best: string | null }>(
    `SELECT q.stage_id, count(*) AS attempts, max(a.score_pct) AS best
       FROM academy.quiz_attempts a
       JOIN academy.quizzes q ON q.id = a.quiz_id
      WHERE a.trainee_id = $1 AND q.stage_id = ANY($2::bigint[])
      GROUP BY q.stage_id`,
    [traineeId, stageIds],
  );
  for (const r of rows) {
    out.set(Number(r.stage_id), {
      attempts: Number(r.attempts),
      best: r.best === null ? null : Number(r.best),
    });
  }
  return out;
}

/** Lesson, recording and "has media" counts per stage. */
export async function loadStageCounts(
  db: Db,
  stageIds: number[],
): Promise<Map<number, StageCounts>> {
  const out = new Map<number, StageCounts>();
  if (stageIds.length === 0) return out;
  const { rows } = await db.query<{
    stage_id: string;
    lessons: string;
    recordings: string;
    with_media: string;
  }>(
    `SELECT s.id AS stage_id,
            (SELECT count(*) FROM academy.lessons l
              WHERE l.stage_id = s.id) AS lessons,
            (SELECT count(*) FROM academy.call_recordings r
              WHERE r.stage_id = s.id AND r.is_active) AS recordings,
            (SELECT count(*) FROM academy.call_recordings r
              WHERE r.stage_id = s.id AND r.is_active AND r.media_key IS NOT NULL) AS with_media
       FROM academy.stages s
      WHERE s.id = ANY($1::bigint[])`,
    [stageIds],
  );
  for (const r of rows) {
    out.set(Number(r.stage_id), {
      lessonCount: Number(r.lessons),
      recordingCount: Number(r.recordings),
      recordingsWithMedia: Number(r.with_media),
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Stage contents
// ---------------------------------------------------------------------------

/**
 * Lesson HTML comes from here and nowhere else: never from the bundle.
 * This is also the one place it is sanitised (sanitize.ts), so the contract's
 * "sanitised lesson HTML" is true of every row, however it reached the table.
 */
export async function loadLessons(
  db: Db,
  traineeId: number,
  stageId: number,
): Promise<StageLesson[]> {
  const { rows } = await db.query<{
    id: string;
    title: string;
    body_html: string;
    position: number;
    read: boolean;
  }>(
    `SELECT l.id, l.title, l.body_html, l.position::int AS position,
            (p.lesson_id IS NOT NULL) AS read
       FROM academy.lessons l
       LEFT JOIN academy.lesson_progress p
              ON p.lesson_id = l.id AND p.trainee_id = $1
      WHERE l.stage_id = $2
      ORDER BY l.position`,
    [traineeId, stageId],
  );
  return rows.map((r) => ({
    id: Number(r.id),
    title: r.title,
    bodyHtml: sanitizeLessonHtml(r.body_html),
    position: r.position,
    read: r.read,
  }));
}

export async function loadRecordings(
  db: Db,
  traineeId: number,
  stageId: number,
): Promise<StageRecording[]> {
  const { rows } = await db.query<{
    id: string;
    title: string;
    description: string;
    duration_secs: number | null;
    media_type: string;
    coming_soon: boolean;
    listened: boolean;
  }>(
    `SELECT r.id,
            r.title,
            COALESCE(r.description, '') AS description,
            r.duration_secs,
            r.media_type,
            (r.media_key IS NULL) AS coming_soon,
            (lp.completed_at IS NOT NULL) AS listened
       FROM academy.call_recordings r
       LEFT JOIN academy.listen_progress lp
              ON lp.recording_id = r.id AND lp.trainee_id = $1
      WHERE r.stage_id = $2 AND r.is_active
      ORDER BY r.position NULLS LAST, r.id`,
    [traineeId, stageId],
  );
  return rows.map((r) => ({
    id: Number(r.id),
    title: r.title,
    description: r.description,
    durationSecs: r.duration_secs,
    mediaType: r.media_type === 'VIDEO' ? 'VIDEO' : 'AUDIO',
    comingSoon: r.coming_soon,
    listened: r.listened,
  }));
}

// ---------------------------------------------------------------------------
// The quiz prerequisite (lessons read, and from S06 recordings heard)
// ---------------------------------------------------------------------------

export interface QuizPrerequisite {
  unlocked: boolean;
  blockedBy: 'lessons' | 'recordings' | null;
  lessonsTotal: number;
  lessonsRead: number;
  /** Recordings WITH media. "Coming soon" slots never count (D4). */
  mediaTotal: number;
  mediaListened: number;
}

/**
 * Whether this trainee may open the stage's quiz. Unlocking a quiz is not the
 * same as unlocking a stage: gate() decides the stage, this decides the quiz
 * inside it. Both the stage detail and the quiz router use this one function.
 */
export async function loadQuizPrerequisite(
  db: Db,
  traineeId: number,
  stageId: number,
): Promise<QuizPrerequisite> {
  const { rows } = await db.query<{
    lessons_total: string;
    lessons_read: string;
    media_total: string;
    media_listened: string;
  }>(
    `SELECT (SELECT count(*) FROM academy.lessons l WHERE l.stage_id = $2) AS lessons_total,
            (SELECT count(*) FROM academy.lessons l
               JOIN academy.lesson_progress p
                 ON p.lesson_id = l.id AND p.trainee_id = $1
              WHERE l.stage_id = $2) AS lessons_read,
            (SELECT count(*) FROM academy.call_recordings r
              WHERE r.stage_id = $2 AND r.is_active AND r.media_key IS NOT NULL) AS media_total,
            (SELECT count(*) FROM academy.call_recordings r
               JOIN academy.listen_progress lp
                 ON lp.recording_id = r.id AND lp.trainee_id = $1
              WHERE r.stage_id = $2 AND r.is_active AND r.media_key IS NOT NULL
                AND lp.completed_at IS NOT NULL) AS media_listened`,
    [traineeId, stageId],
  );
  const r = rows[0];
  const lessonsTotal = Number(r?.lessons_total ?? 0);
  const lessonsRead = Number(r?.lessons_read ?? 0);
  const mediaTotal = Number(r?.media_total ?? 0);
  const mediaListened = Number(r?.media_listened ?? 0);

  const lessonsDone = lessonsRead >= lessonsTotal;
  const recordingsDone = !RECORDINGS_GATE_ENABLED || mediaListened >= mediaTotal;
  const blockedBy = !lessonsDone ? 'lessons' : !recordingsDone ? 'recordings' : null;
  return {
    unlocked: blockedBy === null,
    blockedBy,
    lessonsTotal,
    lessonsRead,
    mediaTotal,
    mediaListened,
  };
}

// ---------------------------------------------------------------------------
// Lessons
// ---------------------------------------------------------------------------

export interface LessonLocation {
  lessonId: number;
  stageId: number;
  stageCode: string;
}

export async function findLesson(db: Db, lessonId: number): Promise<LessonLocation | null> {
  const { rows } = await db.query<{ id: string; stage_id: string; code: string }>(
    `SELECT l.id, l.stage_id, s.code
       FROM academy.lessons l
       JOIN academy.stages s ON s.id = l.stage_id
      WHERE l.id = $1`,
    [lessonId],
  );
  const row = rows[0];
  if (row === undefined) return null;
  return { lessonId: Number(row.id), stageId: Number(row.stage_id), stageCode: row.code };
}

/** Idempotent: true only on the first read, so the audit row is written once. */
export async function markLessonRead(
  db: Db,
  traineeId: number,
  lessonId: number,
): Promise<boolean> {
  const res = await db.query(
    `INSERT INTO academy.lesson_progress (trainee_id, lesson_id)
     VALUES ($1, $2)
     ON CONFLICT (trainee_id, lesson_id) DO NOTHING`,
    [traineeId, lessonId],
  );
  return res.rowCount === 1;
}

/** Active, approved questions only — the same set the grader scores. */
export async function countQuestions(db: Db, stageId: number): Promise<number> {
  const { rows } = await db.query<{ n: string }>(
    `SELECT count(*) AS n
       FROM academy.questions q
       JOIN academy.quizzes z ON z.id = q.quiz_id
      WHERE z.stage_id = $1 AND q.is_active AND q.approval_state = 'APPROVED'`,
    [stageId],
  );
  return Number(rows[0]?.n ?? 0);
}
