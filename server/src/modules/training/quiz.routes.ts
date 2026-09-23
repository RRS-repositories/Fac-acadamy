import { Router } from 'express';
import type { Request, Response } from 'express';
import type { PoolClient } from 'pg';
import { QuizSubmitRequestSchema, isPass } from '@fac-academy/shared';
import type { QuizQuestion, QuizResponse, QuizResult, TrackCode } from '@fac-academy/shared';
import { authOf } from '../../middleware/auth.js';
import { issueCertificatesForPass } from '../../certs/onPass.js';
import { actor, writeAudit } from '../audit/audit.js';
import { createInMemoryQueue } from '../../queues/queue.js';
import { createProducers } from '../../queues/producers.js';
import type { Producers } from '../../queues/producers.js';
import { recordStagePass } from './completions.js';
import { InvalidAnswerError, gradeAttempt } from './grading.js';
import type { GradableQuestion } from './grading.js';
import { gate, visibleStages } from './gate.js';
import { loadQuizPrerequisite } from './repo.js';
import type { Db, StageRow, TrainingDeps } from './repo.js';

// GET/POST /api/stage/:code/quiz — the only way a quiz is read or graded.
//
// Three rules hold this file together:
//
// 1. Nothing is trusted. The stage comes from gate(), the questions and the
//    correct answers come from Postgres, and the score is computed here. The
//    request body contributes option ids and nothing else.
// 2. The correct answers never leave the server before a pass. The GET payload
//    has no correct flag at all, and after a FAIL every `correctOptionId` in
//    the result is null (decision D3: right/wrong only, so "fail once, copy
//    the answers, pass" does not work).
// 3. One attempt is one transaction. The attempt, its answers, the stage
//    completion, the level and department completions and the audit rows
//    commit together. The manager-notify job is enqueued only afterwards, so
//    a rolled-back attempt can never notify anybody.

/**
 * Only what the quiz routes actually use. A full `TrainingDeps` satisfies it,
 * so routes.ts can pass its own deps straight through, but a test does not
 * have to build a session manager to grade a quiz.
 */
export type QuizRouterDeps = Pick<
  TrainingDeps,
  'db' | 'stage1AuthRequired' | 'producers' | 'certificates'
>;

interface StageQuizMeta {
  quizId: number;
  /** levels.id — null for a department module. */
  levelId: number | null;
  dept: string | null;
}

interface LoadedQuestion extends GradableQuestion {
  prompt: string;
  options: { id: number; text: string }[];
  /** Mutable while the rows are folded together, then handed to the grader. */
  optionIds: number[];
}

/** 403/404 bodies. Kept minimal: a locked stage gives nothing else away. */
function denied(res: Response, status: number, error: string, extra?: object): void {
  res.status(status).json({ error, ...extra });
}

/**
 * Map a gate refusal onto a response.
 *
 * `not_visible` (the stage exists but belongs to another track) is answered
 * exactly like `not_found`. gate() keeps them apart internally, but the wire
 * must not tell a curious trainee which stages other tracks have.
 */
function refuse(res: Response, reason: string, requires: string | undefined): void {
  if (reason === 'locked') {
    denied(res, 403, 'locked', { requires: requires ?? null });
    return;
  }
  if (reason === 'no_track') {
    denied(res, 403, 'no_track');
    return;
  }
  denied(res, 404, 'not_found');
}

// ---------------------------------------------------------------------------
// Queries. The correct answers are loaded by this file only, and only on the
// server: `is_correct` is read into memory and never put into a response.
// ---------------------------------------------------------------------------

async function loadStageQuizMeta(db: Db, stageId: number): Promise<StageQuizMeta | null> {
  const { rows } = await db.query<{
    quiz_id: string;
    level_id: number | null;
    dept: string | null;
  }>(
    `SELECT z.id AS quiz_id, s.level_id, s.dept
       FROM academy.stages s
       JOIN academy.quizzes z ON z.stage_id = s.id
      WHERE s.id = $1`,
    [stageId],
  );
  const row = rows[0];
  if (row === undefined) return null;
  return { quizId: Number(row.quiz_id), levelId: row.level_id, dept: row.dept };
}

/**
 * The quiz's questions in prototype order: questions.position, then each
 * question's options by option position. `shuffle` is false for every seeded
 * quiz (migration 0002), so what the trainee sees is what the prototype shows.
 * Only active, APPROVED questions count — the same set the grader scores and
 * the same set `countQuestions()` reports.
 */
async function loadQuestions(db: Db, quizId: number): Promise<LoadedQuestion[]> {
  const { rows } = await db.query<{
    question_id: string;
    prompt: string;
    option_id: string;
    body: string;
    is_correct: boolean;
  }>(
    `SELECT q.id AS question_id, q.prompt, o.id AS option_id, o.body, o.is_correct
       FROM academy.questions q
       JOIN academy.question_options o ON o.question_id = q.id
      WHERE q.quiz_id = $1 AND q.is_active AND q.approval_state = 'APPROVED'
      ORDER BY q.position NULLS LAST, q.id, o.position`,
    [quizId],
  );

  const byQuestion = new Map<number, LoadedQuestion>();
  for (const row of rows) {
    const questionId = Number(row.question_id);
    const optionId = Number(row.option_id);
    let question = byQuestion.get(questionId);
    if (question === undefined) {
      question = {
        id: questionId,
        prompt: row.prompt,
        options: [],
        optionIds: [],
        // -1 until the is_correct row is seen. A question with no correct
        // option (a content defect) then matches nothing and scores wrong,
        // rather than silently accepting whatever the client sent.
        correctOptionId: -1,
      };
      byQuestion.set(questionId, question);
    }
    question.options.push({ id: optionId, text: row.body });
    question.optionIds.push(optionId);
    if (row.is_correct) question.correctOptionId = optionId;
  }
  return [...byQuestion.values()];
}

/** The next attempt number, read under the transaction's lock (see submit). */
async function nextAttemptNumber(
  client: PoolClient,
  traineeId: number,
  quizId: number,
): Promise<number> {
  const { rows } = await client.query<{ next: number }>(
    `SELECT COALESCE(MAX(attempt_number), 0)::int + 1 AS next
       FROM academy.quiz_attempts
      WHERE trainee_id = $1 AND quiz_id = $2`,
    [traineeId, quizId],
  );
  return rows[0]?.next ?? 1;
}

// ---------------------------------------------------------------------------
// The router
// ---------------------------------------------------------------------------

interface Allowed {
  stage: StageRow;
  track: TrackCode;
  meta: StageQuizMeta;
}

/**
 * Everything both handlers do first: gate the stage, then check the quiz's own
 * prerequisite (every lesson read; from S06, every real recording heard).
 * Returns null when it has already answered the request.
 */
async function openQuiz(
  deps: QuizRouterDeps,
  req: Request,
  res: Response,
  traineeId: number,
): Promise<Allowed | null> {
  const code = String(req.params.code ?? '');
  const visible = await visibleStages(deps.db, traineeId);
  const result = await gate(deps.db, traineeId, code, {
    visible,
    stage1AuthRequired: deps.stage1AuthRequired,
  });
  if (!result.allowed) {
    refuse(res, result.reason, result.requires);
    return null;
  }
  if (visible.track === null) {
    // Unreachable: gate() refuses with 'no_track' first. Narrowing only.
    denied(res, 403, 'no_track');
    return null;
  }

  const meta = await loadStageQuizMeta(deps.db, result.stage.id);
  if (meta === null) {
    denied(res, 404, 'not_found');
    return null;
  }

  const prerequisite = await loadQuizPrerequisite(deps.db, traineeId, result.stage.id);
  if (!prerequisite.unlocked) {
    denied(
      res,
      403,
      prerequisite.blockedBy === 'recordings' ? 'recordings_incomplete' : 'lessons_incomplete',
    );
    return null;
  }

  return { stage: result.stage, track: visible.track, meta };
}

/**
 * No producers wired (a test, or a dev server with no Redis). Fall back to the
 * in-memory queue and say so, so nobody discovers in production that the
 * manager DMs went nowhere.
 */
function fallbackProducers(): Producers {
  if (process.env.NODE_ENV !== 'test') {
    console.warn(
      '[academy-api] quiz routes: no job producers supplied, using the in-memory queue. ' +
        'Level and department completions will not reach a worker.',
    );
  }
  return createProducers(createInMemoryQueue());
}

export function createQuizRouter(deps: QuizRouterDeps): Router {
  // mergeParams: the router is mounted under '/api/stage/:code/quiz', so
  // :code belongs to the parent path; this router is mounted at
  // /api/stage/:code/quiz by training/routes.ts.
  const router = Router({ mergeParams: true });
  const paths = ['/'];
  const producers: Producers = deps.producers ?? fallbackProducers();

  // GET: the questions, with NO correct flag anywhere in the payload.
  router.get(paths, async (req, res) => {
    const { traineeId } = authOf(req);
    const allowed = await openQuiz(deps, req, res, traineeId);
    if (allowed === null) return;

    const questions = await loadQuestions(deps.db, allowed.meta.quizId);
    const payload: QuizResponse = {
      stageCode: allowed.stage.code,
      passMark: allowed.stage.passMark,
      questions: questions.map((q): QuizQuestion => ({
        id: q.id,
        prompt: q.prompt,
        options: q.options,
      })),
    };
    res.json(payload);
  });

  // POST: grade server-side, record the attempt, unlock what it unlocks.
  router.post(paths, async (req, res) => {
    const { traineeId } = authOf(req);
    const body = QuizSubmitRequestSchema.safeParse(req.body);
    if (!body.success) {
      denied(res, 400, 'invalid_request');
      return;
    }

    const allowed = await openQuiz(deps, req, res, traineeId);
    if (allowed === null) return;

    try {
      const { result, outcome } = await submitAttempt(deps, traineeId, allowed, body.data.answers);

      // After the commit only: a job for work that did not happen would be
      // worse than a late one, and the queue has no way to roll back.
      if (outcome.level !== null) {
        await producers.enqueueManagerNotify({
          traineeId,
          level: outcome.level.levelNumber,
          track: allowed.track,
        });
      }
      if (outcome.dept !== null) {
        await producers.enqueueDeptNotify({
          traineeId,
          dept: outcome.dept,
          track: allowed.track,
        });
      }
      // S09: the certificate for whatever this pass completed. Issued in the
      // request so it is ready when the page reloads, and queued as well so
      // the worker composes its email (and repairs a failed render). It never
      // throws: a certificate problem must not turn a passed quiz into a 500.
      await issueCertificatesForPass({
        issuer: deps.certificates ?? null,
        producers,
        traineeId,
        track: allowed.track,
        level: outcome.level,
        dept: outcome.dept,
      });
      if (!result.passed) {
        // Every fail is enqueued; the worker counts the streak against the
        // database and sends ONE message on the third (S08 checklist), so a
        // request never has to know whether it was the third one.
        await producers.enqueueStageFailNotify({
          traineeId,
          stageId: allowed.stage.id,
          attemptId: result.attemptId,
          track: allowed.track,
        });
      }

      res.json(result);
    } catch (err) {
      if (err instanceof InvalidAnswerError) {
        denied(res, 400, 'invalid_request');
        return;
      }
      throw err;
    }
  });

  return router;
}

interface SubmitOutcome {
  result: QuizResult;
  outcome: Awaited<ReturnType<typeof recordStagePass>>;
}

/**
 * One attempt, one transaction.
 *
 * Concurrency (checklist 04: "two simultaneous submits → two attempts, no
 * crash, consistent state"). `attempt_number` is UNIQUE per (trainee, quiz),
 * so a plain read-then-write would let two parallel submits pick the same
 * number and one would blow up on the unique index. There is no row to lock —
 * quiz_attempts rows do not exist yet — so the transaction takes a
 * **transaction-scoped advisory lock keyed on (trainee, quiz)** before it
 * reads the highest attempt number. That serialises only the submissions of
 * one trainee on one quiz (never two different trainees, never the rest of
 * the app), and Postgres releases it on COMMIT or ROLLBACK, so nothing leaks
 * if the request dies. A sequence would also give unique numbers, but they
 * would be global and gappy: "attempt 47" on a trainee's second try would be
 * nonsense to a manager reading the roster.
 *
 * Both submits therefore write an attempt (numbers 1 and 2), and the
 * completion writes are ON CONFLICT, so they leave exactly one completion row.
 */
async function submitAttempt(
  deps: QuizRouterDeps,
  traineeId: number,
  allowed: Allowed,
  answers: { questionId: number; optionId: number }[],
): Promise<SubmitOutcome> {
  const client = await deps.db.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [
      `academy.quiz:${traineeId}:${allowed.meta.quizId}`,
    ]);

    const questions = await loadQuestions(client, allowed.meta.quizId);
    const grade = gradeAttempt(questions, answers);
    const passed = isPass(grade.pct, allowed.stage.passMark);

    const attemptNumber = await nextAttemptNumber(client, traineeId, allowed.meta.quizId);
    const inserted = await client.query<{ id: string }>(
      `INSERT INTO academy.quiz_attempts
         (trainee_id, quiz_id, attempt_number, score_pct, passed, started_at)
       VALUES ($1, $2, $3, $4, $5, now())
       RETURNING id`,
      [traineeId, allowed.meta.quizId, attemptNumber, grade.pct, passed],
    );
    const attemptId = Number(inserted.rows[0]?.id);

    // Unanswered questions get no attempt_answers row: attempt_answers.option_id
    // is NOT NULL, and "no row" is exactly what happened. The score already
    // counted them as wrong, so the attempt total is still authoritative.
    const answered = grade.perQuestion.filter((q) => q.selectedOptionId !== null);
    if (answered.length > 0) {
      await client.query(
        `INSERT INTO academy.attempt_answers (attempt_id, question_id, option_id, is_correct)
         SELECT $1, q, o, c
           FROM unnest($2::bigint[], $3::bigint[], $4::boolean[]) AS t(q, o, c)`,
        [
          attemptId,
          answered.map((q) => q.questionId),
          answered.map((q) => q.selectedOptionId),
          answered.map((q) => q.correct),
        ],
      );
    }

    // The audit scrubber redacts any key matching /pass|code|secret|token/,
    // so the outcome is logged as `result: 'PASS' | 'FAIL'` and the stage as
    // `stage`. Values are never scrubbed, only key names.
    await writeAudit(client, {
      traineeId,
      eventType: 'QUIZ_SUBMIT',
      actor: actor.trainee(traineeId),
      payload: {
        stage: allowed.stage.code,
        pct: grade.pct,
        result: passed ? 'PASS' : 'FAIL',
        attempt: attemptNumber,
        correctCount: grade.correctCount,
        total: grade.total,
      },
    });

    let outcome: Awaited<ReturnType<typeof recordStagePass>> = {
      stageNewlyPassed: false,
      level: null,
      dept: null,
    };

    if (passed) {
      outcome = await recordStagePass(client, {
        traineeId,
        stageId: allowed.stage.id,
        track: allowed.track,
        pct: grade.pct,
        levelId: allowed.meta.levelId,
        dept: allowed.meta.dept,
      });

      // Milestones are audited once, on the attempt that achieved them: a
      // later retake of an already-passed stage is a QUIZ_SUBMIT, not a
      // second STAGE_PASS.
      if (outcome.stageNewlyPassed) {
        await writeAudit(client, {
          traineeId,
          eventType: 'STAGE_PASS',
          actor: actor.trainee(traineeId),
          payload: { stage: allowed.stage.code, pct: grade.pct, track: allowed.track },
        });
      }
      if (outcome.level !== null) {
        await writeAudit(client, {
          traineeId,
          eventType: 'LEVEL_PASS',
          actor: actor.trainee(traineeId),
          payload: { level: outcome.level.levelNumber, track: allowed.track },
        });
      }
      if (outcome.dept !== null) {
        await writeAudit(client, {
          traineeId,
          eventType: 'DEPT_PASS',
          actor: actor.trainee(traineeId),
          payload: { dept: outcome.dept, track: allowed.track },
        });
      }
    }

    await client.query('COMMIT');

    const result: QuizResult = {
      attemptId,
      pct: grade.pct,
      passed,
      correctCount: grade.correctCount,
      total: grade.total,
      // D3: the correct answer is revealed only once they have passed.
      perQuestion: grade.perQuestion.map((q) => ({
        questionId: q.questionId,
        correct: q.correct,
        correctOptionId: passed
          ? (questions.find((question) => question.id === q.questionId)?.correctOptionId ?? null)
          : null,
      })),
    };

    return { result, outcome };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}
