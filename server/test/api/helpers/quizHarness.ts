// Harness for the S04 quiz routes: the real router, the real grading path and
// the real local test database (MIGRATION_TEST_DB_NAME), driven over HTTP with
// Supertest.
//
// Two deliberate choices:
//
// * **No training content lives here.** Every question, option and correct
//   answer is read back out of the seeded database. Nothing about the
//   prototype is copied into the repo, so these tests keep working when the
//   content changes and they leak nothing if someone reads the file.
// * **Authentication is stubbed, not exercised.** S03 already tests sign-in to
//   death; repeating the TOTP dance for every quiz assertion would only make
//   these tests slow and flaky. The app here mounts the quiz router behind a
//   middleware that sets req.auth from a header, which is exactly what
//   requireAuth does in production.

import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseEnv } from 'node:util';
import cookieParser from 'cookie-parser';
import express from 'express';
import type { ErrorRequestHandler, Express } from 'express';
import pg from 'pg';
import type { TrackCode } from '@fac-academy/shared';
import { pgConfig } from '../../../src/db/connection.js';
import { applyMigrations, settingsFromEnv } from '../../../src/db/migrate.js';
import { createQuizRouter } from '../../../src/modules/training/quiz.routes.js';
import { createInMemoryQueue, createProducers } from '../../../src/queues/index.js';
import type { InMemoryJobQueue } from '../../../src/queues/index.js';

function envWithDotenv(): NodeJS.ProcessEnv {
  const candidates = process.env.ENV_FILE
    ? [resolve(process.env.ENV_FILE)]
    : [resolve(process.cwd(), '.env'), resolve(process.cwd(), '..', '.env')];
  const file = candidates.find((f) => existsSync(f));
  const fromFile = file ? parseEnv(readFileSync(file, 'utf8')) : {};
  return { ...fromFile, ...process.env };
}

const env = envWithDotenv();
export const TEST_DB = env.MIGRATION_TEST_DB_NAME?.trim() || '';

/** The header the stub auth middleware reads. */
export const TRAINEE_HEADER = 'x-test-trainee';

export interface StageMeta {
  id: number;
  code: string;
  passMark: number;
  questionCount: number;
  lessonCount: number;
}

export interface QuizDb {
  pool: pg.Pool;
  app: Express;
  queue: InMemoryJobQueue;
  tag: string;
  /** A trainee on `track`, ready to be used as the x-test-trainee header. */
  newTrainee(track: TrackCode | null): Promise<number>;
  stage(code: string): Promise<StageMeta>;
  /** Marks every lesson of the stage read, the way POST /api/lesson/:id/read would. */
  readLessons(traineeId: number, stageId: number): Promise<void>;
  /** The correct option for each question, in the order the quiz serves them. */
  correctAnswers(stageId: number): Promise<{ questionId: number; optionId: number }[]>;
  /** A wrong option for each question, same order. */
  wrongAnswers(stageId: number): Promise<{ questionId: number; optionId: number }[]>;
  attemptRows(
    traineeId: number,
    stageId: number,
  ): Promise<{ attempt_number: number; score_pct: number; passed: boolean }[]>;
  cleanup(): Promise<void>;
}

const quiet = (): undefined => undefined;

const REPO_ROOT = fileURLToPath(new URL('../../../../', import.meta.url));

async function hasContent(pool: pg.Pool): Promise<boolean> {
  const { rows } = await pool.query<{ n: string }>(
    'SELECT count(*) AS n FROM academy.question_options WHERE is_correct',
  );
  return Number(rows[0]?.n ?? 0) > 0;
}

/** PROTOTYPE_PATH from the environment or the repo-root .env, if it is real. */
function prototypePath(): string {
  const candidate = (env.PROTOTYPE_PATH ?? '').trim();
  return candidate !== '' && existsSync(candidate) ? candidate : '';
}

/**
 * True when the test database has the S02 content in it.
 *
 * The migration test drops and rebuilds the academy schema in this same
 * database, so the content is gone after every full run. When PROTOTYPE_PATH
 * points at the build pack, this re-runs the documented S02 seed command
 * (local only, idempotent, TEST database only — `--expect-db` is the seed's
 * own wrong-database guard). Otherwise the quiz suite skips with a message
 * saying exactly how to fix it. No content is ever copied into the repo.
 */
export async function isSeeded(pool: pg.Pool): Promise<boolean> {
  if (await hasContent(pool)) return true;
  const prototype = prototypePath();
  if (prototype === '') return false;

  const res = spawnSync('npx', ['tsx', 'ops/seed/seed-content.ts', '--expect-db', TEST_DB], {
    cwd: REPO_ROOT,
    env: { ...process.env, DB_NAME: TEST_DB, PROTOTYPE_PATH: prototype },
    encoding: 'utf8',
    shell: true,
    timeout: 300_000,
  });
  if (res.status !== 0) {
    console.warn(`[quizHarness] the content seed failed (exit ${String(res.status)}).`);
    return false;
  }
  return hasContent(pool);
}

export async function openQuizDb(): Promise<QuizDb> {
  const settings = { ...settingsFromEnv(env), DB_NAME: TEST_DB };
  await applyMigrations({ commit: true, expectDb: TEST_DB, settings, log: quiet });
  const pool = new pg.Pool(pgConfig(settings, { applicationName: 'academy-quiz-test', max: 8 }));
  const tag = randomBytes(4).toString('hex');
  const traineeIds: number[] = [];
  let seq = 0;

  const queue = createInMemoryQueue();
  const app = express();
  app.use(express.json({ limit: '100kb' }));
  app.use(cookieParser());
  app.use((req, res, next) => {
    const header = req.header(TRAINEE_HEADER);
    if (header === undefined) {
      res.status(401).json({ error: 'not_signed_in' });
      return;
    }
    req.auth = {
      traineeId: Number(header),
      role: 'STAFF',
      sessionId: 'test-session',
      dbSessionId: 0,
    };
    next();
  });
  app.use(
    '/api/stage/:code/quiz',
    createQuizRouter({
      db: pool,
      stage1AuthRequired: false,
      producers: createProducers(queue),
    }),
  );
  app.use('/api', (_req, res) => {
    res.status(404).json({ error: 'not_found' });
  });
  const errorHandler: ErrorRequestHandler = (err: unknown, _req, res, _next) => {
    console.error('[quiz-test] unhandled:', err);
    if (!res.headersSent) res.status(500).json({ error: 'internal' });
  };
  app.use(errorHandler);

  return {
    pool,
    app,
    queue,
    tag,

    async newTrainee(track) {
      seq++;
      const { rows } = await pool.query<{ id: string }>(
        `INSERT INTO academy.trainees (full_name, email, track)
         VALUES ($1, $2, $3) RETURNING id`,
        [`Quiz Tester ${seq}`, `quiz${seq}.${tag}@example.com`, track],
      );
      const id = Number(rows[0]!.id);
      traineeIds.push(id);
      return id;
    },

    async stage(code) {
      const { rows } = await pool.query<{
        id: string;
        pass_mark: number;
        questions: string;
        lessons: string;
      }>(
        `SELECT s.id,
                COALESCE(z.pass_mark, s.pass_mark, l.default_pass_mark, 80)::int AS pass_mark,
                (SELECT count(*) FROM academy.questions q
                  WHERE q.quiz_id = z.id AND q.is_active
                    AND q.approval_state = 'APPROVED') AS questions,
                (SELECT count(*) FROM academy.lessons le WHERE le.stage_id = s.id) AS lessons
           FROM academy.stages s
           JOIN academy.quizzes z ON z.stage_id = s.id
           LEFT JOIN academy.levels l ON l.id = s.level_id
          WHERE s.code = $1`,
        [code],
      );
      const row = rows[0];
      if (row === undefined) throw new Error(`no seeded stage ${code}`);
      return {
        id: Number(row.id),
        code,
        passMark: row.pass_mark,
        questionCount: Number(row.questions),
        lessonCount: Number(row.lessons),
      };
    },

    async readLessons(traineeId, stageId) {
      await pool.query(
        `INSERT INTO academy.lesson_progress (trainee_id, lesson_id)
         SELECT $1, l.id FROM academy.lessons l WHERE l.stage_id = $2
         ON CONFLICT DO NOTHING`,
        [traineeId, stageId],
      );
    },

    correctAnswers(stageId) {
      return optionsFor(pool, stageId, true);
    },

    wrongAnswers(stageId) {
      return optionsFor(pool, stageId, false);
    },

    async attemptRows(traineeId, stageId) {
      const { rows } = await pool.query<{
        attempt_number: number;
        score_pct: string;
        passed: boolean;
      }>(
        `SELECT a.attempt_number, a.score_pct, a.passed
           FROM academy.quiz_attempts a
           JOIN academy.quizzes z ON z.id = a.quiz_id
          WHERE a.trainee_id = $1 AND z.stage_id = $2
          ORDER BY a.attempt_number`,
        [traineeId, stageId],
      );
      return rows.map((r) => ({
        attempt_number: r.attempt_number,
        score_pct: Number(r.score_pct),
        passed: r.passed,
      }));
    },

    async cleanup() {
      const ids = traineeIds;
      await pool.query(
        `DELETE FROM academy.attempt_answers
          WHERE attempt_id IN (SELECT id FROM academy.quiz_attempts
                                WHERE trainee_id = ANY($1::bigint[]))`,
        [ids],
      );
      for (const sql of [
        'DELETE FROM academy.quiz_attempts WHERE trainee_id = ANY($1::bigint[])',
        'DELETE FROM academy.lesson_progress WHERE trainee_id = ANY($1::bigint[])',
        'DELETE FROM academy.stage_completions WHERE trainee_id = ANY($1::bigint[])',
        'DELETE FROM academy.level_completions WHERE trainee_id = ANY($1::bigint[])',
        'DELETE FROM academy.dept_completions WHERE trainee_id = ANY($1::bigint[])',
        'DELETE FROM academy.audit_events WHERE trainee_id = ANY($1::bigint[])',
        'DELETE FROM academy.sessions WHERE trainee_id = ANY($1::bigint[])',
        'DELETE FROM academy.trainees WHERE id = ANY($1::bigint[])',
      ]) {
        await pool.query(sql, [ids]);
      }
      await pool.end();
    },
  };
}

/**
 * One option per question: the correct one, or the first wrong one. Read from
 * the database, never from a fixture — the answers must not exist in the repo.
 */
async function optionsFor(
  pool: pg.Pool,
  stageId: number,
  correct: boolean,
): Promise<{ questionId: number; optionId: number }[]> {
  const { rows } = await pool.query<{ question_id: string; option_id: string }>(
    `SELECT DISTINCT ON (q.id) q.id AS question_id, o.id AS option_id
       FROM academy.questions q
       JOIN academy.quizzes z ON z.id = q.quiz_id
       JOIN academy.question_options o ON o.question_id = q.id
      WHERE z.stage_id = $1 AND q.is_active AND q.approval_state = 'APPROVED'
        AND o.is_correct = $2
      ORDER BY q.id, o.position`,
    [stageId, correct],
  );
  return rows.map((r) => ({ questionId: Number(r.question_id), optionId: Number(r.option_id) }));
}
