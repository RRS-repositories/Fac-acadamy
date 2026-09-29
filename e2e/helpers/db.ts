import pg from 'pg';
import { loadEnv, requireEnv, targetDatabase } from './env.js';

// The suite's read-mostly window on academy_dev. Two jobs only:
//
//  * an ORACLE — which option is the correct one, which lessons a stage has,
//    which trainee id an email belongs to. A test that has to pass a quiz
//    honestly has to learn the answers from somewhere, and the database is the
//    one place that is not the thing under test;
//  * SET-UP — parking an account on a track, clearing its progress between
//    specs. Never an assertion: everything a spec claims about behaviour is
//    asserted through the app, not the tables.
//
// The same local-only guard the ops/dev scripts use (ops/dev/lib.ts): the
// database name must contain 'dev' or 'test' and must never contain 'prod' or
// 'live'. The rule is repeated here rather than imported so the suite pulls in
// no part of the server's module graph.

const LOCAL_HINTS = ['dev', 'test'];
const FORBIDDEN_HINTS = ['prod', 'live'];

export function isLocalDbName(name: string): boolean {
  const lower = name.trim().toLowerCase();
  if (!lower) return false;
  if (FORBIDDEN_HINTS.some((h) => lower.includes(h))) return false;
  return LOCAL_HINTS.some((h) => lower.includes(h));
}

let pool: pg.Pool | null = null;

export function db(): pg.Pool {
  if (pool !== null) return pool;
  loadEnv();
  const name = targetDatabase();
  if (!isLocalDbName(name)) {
    throw new Error(
      `e2e: refusing to connect to "${name}". The suite is local only: the database name must ` +
        "contain 'dev' or 'test' and must not contain 'prod' or 'live'.",
    );
  }
  pool = new pg.Pool({
    host: requireEnv('DB_HOST'),
    port: Number(requireEnv('DB_PORT')),
    database: name,
    user: requireEnv('DB_USER'),
    password: requireEnv('DB_PASSWORD'),
    ssl: process.env['DB_SSL'] === 'true' ? { rejectUnauthorized: false } : false,
    max: 4,
    application_name: 'academy-e2e',
  });
  return pool;
}

export async function closeDb(): Promise<void> {
  if (pool === null) return;
  const p = pool;
  pool = null;
  await p.end().catch(() => undefined);
}

async function rows<T extends pg.QueryResultRow>(
  sql: string,
  params: readonly unknown[] = [],
): Promise<T[]> {
  const result = await db().query<T>(sql, [...params]);
  return result.rows;
}

// ---------------------------------------------------------------------------
// Oracle
// ---------------------------------------------------------------------------

export interface Answer {
  questionId: number;
  optionId: number;
}

/** The trainee id behind a sign-in email. */
export async function traineeIdByEmail(email: string): Promise<number> {
  const found = await rows<{ id: string }>(
    'SELECT id::text AS id FROM academy.trainees WHERE email = $1',
    [email],
  );
  const id = found[0]?.id;
  if (id === undefined) throw new Error(`e2e: no trainee row for ${email}.`);
  return Number(id);
}

export async function stageIdByCode(code: string): Promise<number> {
  const found = await rows<{ id: string }>(
    'SELECT id::text AS id FROM academy.stages WHERE code = $1',
    [code],
  );
  const id = found[0]?.id;
  if (id === undefined) throw new Error(`e2e: no stage with code ${code}.`);
  return Number(id);
}

/** Lesson ids of a stage, in the order the stage page shows them. */
export async function lessonIdsForStage(code: string): Promise<number[]> {
  const found = await rows<{ id: string }>(
    `SELECT l.id::text AS id
       FROM academy.lessons l
       JOIN academy.stages s ON s.id = l.stage_id
      WHERE s.code = $1
      ORDER BY l.position NULLS LAST, l.id`,
    [code],
  );
  return found.map((r) => Number(r.id));
}

/**
 * The correct option for every active, approved question of a stage's quiz,
 * in the order the quiz serves them. This is the answer key: it never reaches
 * the browser, and the suite uses it only to answer a quiz the way a trainee
 * who had read the lessons would.
 */
export async function correctAnswersForStage(code: string): Promise<Answer[]> {
  const found = await rows<{ question_id: string; option_id: string }>(
    `SELECT q.id::text AS question_id, o.id::text AS option_id
       FROM academy.questions q
       JOIN academy.quizzes z ON z.id = q.quiz_id
       JOIN academy.stages s ON s.id = z.stage_id
       JOIN academy.question_options o ON o.question_id = q.id AND o.is_correct
      WHERE s.code = $1 AND q.is_active AND q.approval_state = 'APPROVED'
      ORDER BY q.position NULLS LAST, q.id`,
    [code],
  );
  return found.map((r) => ({ questionId: Number(r.question_id), optionId: Number(r.option_id) }));
}

/** One WRONG option per question: the deliberate fail. */
export async function wrongAnswersForStage(code: string): Promise<Answer[]> {
  const found = await rows<{ question_id: string; option_id: string }>(
    `SELECT DISTINCT ON (q.id) q.id::text AS question_id, o.id::text AS option_id
       FROM academy.questions q
       JOIN academy.quizzes z ON z.id = q.quiz_id
       JOIN academy.stages s ON s.id = z.stage_id
       JOIN academy.question_options o ON o.question_id = q.id AND NOT o.is_correct
      WHERE s.code = $1 AND q.is_active AND q.approval_state = 'APPROVED'
      ORDER BY q.id, o.position`,
    [code],
  );
  return found.map((r) => ({ questionId: Number(r.question_id), optionId: Number(r.option_id) }));
}

/** The text of the correct option of every question in a stage's quiz. */
export async function correctOptionTextsForStage(code: string): Promise<string[]> {
  const found = await rows<{ body: string }>(
    `SELECT o.body
       FROM academy.questions q
       JOIN academy.quizzes z ON z.id = q.quiz_id
       JOIN academy.stages s ON s.id = z.stage_id
       JOIN academy.question_options o ON o.question_id = q.id AND o.is_correct
      WHERE s.code = $1 AND q.is_active AND q.approval_state = 'APPROVED'`,
    [code],
  );
  return found.map((r) => r.body);
}

/**
 * A run of real lesson text from a stage's first lesson, used both ways: to
 * prove a locked page carries none of it, and to prove an unlocked one does.
 *
 * It is one whole text node with no entity in it, so the string appears in the
 * rendered page exactly as it appears in the database — no guessing about how
 * `&amp;` or a tag boundary came out the other end.
 */
export async function lessonTextSampleForStage(code: string): Promise<string> {
  const found = await rows<{ body_html: string }>(
    `SELECT l.body_html
       FROM academy.lessons l
       JOIN academy.stages s ON s.id = l.stage_id
      WHERE s.code = $1
      ORDER BY l.position NULLS LAST, l.id
      LIMIT 1`,
    [code],
  );
  const html = found[0]?.body_html;
  if (html === undefined) throw new Error(`e2e: stage ${code} has no lesson.`);
  const sample = html
    .split(/<[^>]+>/)
    .map((part) => part.replace(/\s+/g, ' ').trim())
    .find((part) => part.length >= 40 && !part.includes('&'));
  if (sample === undefined) throw new Error(`e2e: stage ${code} lesson has no usable text node.`);
  return sample;
}

/** Recordings of a stage that really have media behind them. */
export async function playableRecordings(
  code: string,
): Promise<{ id: number; durationSecs: number | null }[]> {
  const found = await rows<{ id: string; duration_secs: number | null }>(
    `SELECT r.id::text AS id, r.duration_secs
       FROM academy.call_recordings r
       JOIN academy.stages s ON s.id = r.stage_id
      WHERE s.code = $1 AND r.is_active AND r.media_key IS NOT NULL
      ORDER BY r.position NULLS LAST, r.id`,
    [code],
  );
  return found.map((r) => ({ id: Number(r.id), durationSecs: r.duration_secs }));
}

/** Every text field a trainee can be served, for the PII sweep's DB half. */
export async function allContentText(): Promise<string[]> {
  const parts: string[] = [];
  for (const sql of [
    'SELECT body_html AS t FROM academy.lessons',
    'SELECT prompt AS t FROM academy.questions',
    'SELECT body AS t FROM academy.question_options',
    'SELECT title AS t FROM academy.call_recordings',
    "SELECT COALESCE(description, '') AS t FROM academy.call_recordings",
    'SELECT title AS t FROM academy.stages',
    'SELECT blurb AS t FROM academy.stages',
  ]) {
    for (const row of await rows<{ t: string }>(sql)) parts.push(row.t);
  }
  return parts;
}

// ---------------------------------------------------------------------------
// Set-up
// ---------------------------------------------------------------------------

const PROGRESS_TABLES = [
  'attempt_answers',
  'quiz_attempts',
  'lesson_progress',
  'stage_completions',
  'level_completions',
  'dept_completions',
  'listen_progress',
] as const;

/**
 * Puts one sign-in account back to "day one": no progress, no certificates,
 * enabled, parked on `track`. Scoped to the one trainee id, never a pattern.
 */
export async function resetTrainee(traineeId: number, track: string | null): Promise<void> {
  const client = await db().connect();
  try {
    await client.query('BEGIN');
    for (const t of PROGRESS_TABLES) {
      const sql =
        t === 'attempt_answers'
          ? `DELETE FROM academy.attempt_answers
              WHERE attempt_id IN (SELECT id FROM academy.quiz_attempts WHERE trainee_id = $1)`
          : `DELETE FROM academy.${t} WHERE trainee_id = $1`;
      await client.query(sql, [traineeId]);
    }
    await client.query('DELETE FROM academy.certificates WHERE trainee_id = $1', [traineeId]);
    await client.query(
      `UPDATE academy.trainees
          SET track = $2, is_disabled = FALSE, disabled_by = NULL, disabled_at = NULL,
              status = 'ACTIVE'
        WHERE id = $1`,
      [traineeId, track],
    );
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Marks every playable recording of a stage fully listened, for ONE trainee.
 * The listening gate's equivalent of `readLesson` in the fast-forward: it is
 * set-up, never an assertion, and it is only ever used to reach a stage a spec
 * is not there to watch.
 *
 * Why it cannot be done through the beacon endpoint. The gate is deliberately
 * bound to cumulative wall clock (server/src/media/coverage.ts, and the
 * first_beacon_at column migration 0008 added for it): the media time credited
 * to a listen may never exceed the real time that has passed since that
 * listen's first beacon. The core stages now carry real call recordings of six
 * to seventeen minutes, so paying that gate honestly on the way past s1 would
 * cost the suite the better part of an hour. The rule is the point and it is
 * not weakened here — the same skip the suite already makes for lessons and
 * quizzes in `fastForwardStages` is simply extended to listening, by writing
 * the per-trainee state a completed listen leaves behind.
 *
 * What it writes is the row the real beacon route writes, in the same shape,
 * so nothing downstream can tell the two apart: coverage is the single
 * interval [0, duration] that `spansDuration` accepts, `seconds_heard` is that
 * total rounded as progress.ts rounds it, `completed_at` is what `gate()` and
 * `loadQuizPrerequisite` actually read, and `first_beacon_at` is set a full
 * duration in the past — which is exactly where an honest listen of that
 * length would have started it, and which leaves any later real beacon on the
 * recording with the same budget it would have had anyway. `first_beacon_at`
 * and `completed_at` are written with COALESCE, as progress.ts writes them, so
 * a listen already under way keeps the clock it started on.
 *
 * `except` is how the one spec that proves the real thing keeps proving it:
 * journey-cs.spec.ts listens to the 20-second fixture recording on s4 through
 * the real beacon endpoint, at the pace the real rule allows, so that
 * recording is named here and its state is never written by this helper.
 *
 * Scoped to the one trainee id: the primary key of academy.listen_progress is
 * (trainee_id, recording_id) and both are bound parameters, so no statement
 * here can reach a row belonging to another account. The connection itself is
 * the local-only `db()` pool, which refuses any database whose name does not
 * look like a developer's.
 */
export async function creditFullListen(
  traineeId: number,
  code: string,
  options: { except?: readonly number[] } = {},
): Promise<number[]> {
  const except = new Set(options.except ?? []);
  const targets = (await playableRecordings(code)).filter((r) => !except.has(r.id));
  const credited: number[] = [];
  for (const { id, durationSecs } of targets) {
    if (durationSecs === null || !Number.isFinite(durationSecs) || durationSecs <= 0) {
      // A recording of unknown length can never be listened in full — the
      // server's `spansDuration` has no end to reach — so a row claiming it was
      // would be a state no beacon could ever produce. Better to stop and say
      // so than to invent one.
      throw new Error(
        `e2e: recording ${String(id)} on ${code} has no duration, so a full listen of it ` +
          'cannot be represented. The seed is wrong, not the test.',
      );
    }
    const now = Date.now();
    await db().query(
      `INSERT INTO academy.listen_progress
         (trainee_id, recording_id, seconds_heard, coverage,
          first_beacon_at, last_beacon_at, completed_at)
       VALUES ($1, $2, $3, $4::jsonb, $5::timestamptz, $6::timestamptz, $6::timestamptz)
       ON CONFLICT (trainee_id, recording_id) DO UPDATE
          SET seconds_heard   = EXCLUDED.seconds_heard,
              coverage        = EXCLUDED.coverage,
              first_beacon_at = COALESCE(academy.listen_progress.first_beacon_at,
                                         EXCLUDED.first_beacon_at),
              last_beacon_at  = EXCLUDED.last_beacon_at,
              completed_at    = COALESCE(academy.listen_progress.completed_at,
                                         EXCLUDED.completed_at)`,
      [
        traineeId,
        id,
        Math.round(durationSecs),
        JSON.stringify([[0, durationSecs]]),
        new Date(now - durationSecs * 1000).toISOString(),
        new Date(now).toISOString(),
      ],
    );
    credited.push(id);
  }
  return credited;
}

/** Set-up only. The manager UI doing this for real is manager.spec.ts's job. */
export async function setTrack(traineeId: number, track: string): Promise<void> {
  await db().query('UPDATE academy.trainees SET track = $2 WHERE id = $1', [traineeId, track]);
}

export async function certificatesOf(
  traineeId: number,
): Promise<{ publicId: string; kind: string; mediaKey: string | null }[]> {
  const found = await rows<{ public_id: string; kind: string; media_key: string | null }>(
    `SELECT public_id, kind, media_key FROM academy.certificates
      WHERE trainee_id = $1 AND revoked_at IS NULL ORDER BY issued_at`,
    [traineeId],
  );
  return found.map((r) => ({ publicId: r.public_id, kind: r.kind, mediaKey: r.media_key }));
}
