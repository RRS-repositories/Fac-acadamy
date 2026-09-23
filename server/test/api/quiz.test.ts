import { afterAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import type { Response } from 'supertest';
import type { QuizResponse, QuizResult } from '@fac-academy/shared';
import { gate } from '../../src/modules/training/gate.js';
import { QUEUE_NAMES } from '../../src/queues/index.js';
import type { LevelCompleteJob } from '../../src/jobs/managerNotify.js';
import { TEST_DB, TRAINEE_HEADER, isSeeded, openQuizDb } from './helpers/quizHarness.js';
import type { QuizDb } from './helpers/quizHarness.js';

// S04 quiz API against the seeded local database. Skips cleanly when there is
// no test database, or when there is one but the S02 content seed has not been
// run into it (the prototype lives outside the repo, so CI has no content).

// The database is opened at module scope, not in beforeAll: whether the suite
// can run has to be known while the tests are being collected, so a machine
// (or CI) without a seeded database skips instead of failing.
let db: QuizDb | null = null;
let ready = false;

if (TEST_DB === '') {
  console.warn('[quiz.test] MIGRATION_TEST_DB_NAME is not set: skipping the quiz API tests.');
} else {
  try {
    db = await openQuizDb();
    ready = await isSeeded(db.pool);
    if (!ready) {
      console.warn(
        `[quiz.test] ${TEST_DB} has no seeded content: run\n` +
          `  PROTOTYPE_PATH=... npx tsx ops/seed/seed-content.ts --expect-db ${TEST_DB}\n` +
          'Skipping the quiz API tests until then.',
      );
    }
  } catch (err) {
    console.warn(`[quiz.test] test database unavailable: ${(err as Error).message}`);
  }
}

afterAll(async () => {
  await db?.cleanup();
});

const describeDb = ready ? describe : describe.skip;

function need(): QuizDb {
  if (db === null) throw new Error('no test database');
  return db;
}

function getQuiz(traineeId: number, code: string): Promise<Response> {
  return request(need().app).get(`/api/stage/${code}/quiz`).set(TRAINEE_HEADER, String(traineeId));
}

function postQuiz(
  traineeId: number,
  code: string,
  answers: { questionId: number; optionId: number }[],
): Promise<Response> {
  return request(need().app)
    .post(`/api/stage/${code}/quiz`)
    .set(TRAINEE_HEADER, String(traineeId))
    .send({ answers });
}

/** Read every lesson, then answer every question correctly. */
async function passStage(traineeId: number, code: string): Promise<QuizResult> {
  const h = need();
  const stage = await h.stage(code);
  await h.readLessons(traineeId, stage.id);
  const res = await postQuiz(traineeId, code, await h.correctAnswers(stage.id));
  expect(res.status, `passing ${code}: ${JSON.stringify(res.body)}`).toBe(200);
  const result = res.body as QuizResult;
  expect(result.passed).toBe(true);
  return result;
}

describeDb('GET /api/stage/:code/quiz', () => {
  it('never ships a correct flag, in the raw JSON', async () => {
    const h = need();
    const trainee = await h.newTrainee('FULL');
    const stage = await h.stage('s1');
    await h.readLessons(trainee, stage.id);

    const res = await getQuiz(trainee, 's1');
    expect(res.status).toBe(200);

    // The raw body, not the parsed object: a key named `correct`,
    // `isCorrect` or `is_correct` must not appear anywhere in it.
    expect(res.text).not.toMatch(/"(is_?[cC]orrect|correct|answer|correctOptionId)"\s*:/);

    const body = res.body as QuizResponse;
    expect(body.stageCode).toBe('s1');
    expect(body.passMark).toBe(stage.passMark);
    expect(body.questions).toHaveLength(stage.questionCount);
    for (const q of body.questions) {
      expect(Object.keys(q).sort()).toEqual(['id', 'options', 'prompt']);
      expect(q.options.length).toBeGreaterThan(1);
      for (const option of q.options) expect(Object.keys(option).sort()).toEqual(['id', 'text']);
    }
  });

  it('serves the questions in the prototype order', async () => {
    const h = need();
    const trainee = await h.newTrainee('FULL');
    const stage = await h.stage('s1');
    await h.readLessons(trainee, stage.id);

    const res = await getQuiz(trainee, 's1');
    expect(res.status).toBe(200);
    const body = res.body as QuizResponse;
    const { rows } = await h.pool.query<{ id: string }>(
      `SELECT q.id FROM academy.questions q
         JOIN academy.quizzes z ON z.id = q.quiz_id
        WHERE z.stage_id = $1 AND q.is_active AND q.approval_state = 'APPROVED'
        ORDER BY q.position NULLS LAST, q.id`,
      [stage.id],
    );
    expect(body.questions.map((q) => q.id)).toEqual(rows.map((r) => Number(r.id)));

    // ... and each question's options in question_options.position order.
    for (const question of body.questions) {
      const options = await h.pool.query<{ id: string }>(
        'SELECT id FROM academy.question_options WHERE question_id = $1 ORDER BY position',
        [question.id],
      );
      expect(question.options.map((o) => o.id)).toEqual(options.rows.map((r) => Number(r.id)));
    }
  });

  it('refuses until every lesson of the stage is read', async () => {
    const h = need();
    const trainee = await h.newTrainee('FULL');
    const stage = await h.stage('s1');
    expect(stage.lessonCount).toBeGreaterThan(1);

    const before = await getQuiz(trainee, 's1');
    expect(before.status).toBe(403);
    expect(before.body).toEqual({ error: 'lessons_incomplete' });

    // One lesson short is still short.
    await h.pool.query(
      `INSERT INTO academy.lesson_progress (trainee_id, lesson_id)
       SELECT $1, l.id FROM academy.lessons l
        WHERE l.stage_id = $2 ORDER BY l.position LIMIT $3
       ON CONFLICT DO NOTHING`,
      [trainee, stage.id, stage.lessonCount - 1],
    );
    expect((await getQuiz(trainee, 's1')).status).toBe(403);

    await h.readLessons(trainee, stage.id);
    expect((await getQuiz(trainee, 's1')).status).toBe(200);
  });

  it('403 locked on a stage whose predecessor is not passed', async () => {
    const h = need();
    const trainee = await h.newTrainee('FULL');
    const stage = await h.stage('s2');
    await h.readLessons(trainee, stage.id);

    const res = await getQuiz(trainee, 's2');
    expect(res.status).toBe(403);
    expect(res.body).toEqual({ error: 'locked', requires: 's1' });
  });

  it('404 for an unknown stage, and for a stage on another track', async () => {
    const h = need();
    const trainee = await h.newTrainee('ADMIN');
    expect((await getQuiz(trainee, 'nope')).status).toBe(404);
    // dF1 exists, but only the FOS track sees it.
    const other = await getQuiz(trainee, 'dF1');
    expect(other.status).toBe(404);
    expect(other.body).toEqual({ error: 'not_found' });
  });

  it('403 no_track before a manager assigns a track (D13)', async () => {
    const trainee = await need().newTrainee(null);
    const res = await getQuiz(trainee, 's1');
    expect(res.status).toBe(403);
    expect(res.body).toEqual({ error: 'no_track' });
  });
});

describeDb('POST /api/stage/:code/quiz', () => {
  it('all correct → 100%, passed, and the answers revealed', async () => {
    const h = need();
    const trainee = await h.newTrainee('FULL');
    const stage = await h.stage('s1');
    await h.readLessons(trainee, stage.id);
    const correct = await h.correctAnswers(stage.id);

    const res = await postQuiz(trainee, 's1', correct);
    expect(res.status).toBe(200);
    const result = res.body as QuizResult;
    expect(result.pct).toBe(100);
    expect(result.passed).toBe(true);
    expect(result.correctCount).toBe(stage.questionCount);
    expect(result.total).toBe(stage.questionCount);

    // D3: a pass reveals the correct option for every question.
    const byQuestion = new Map(correct.map((a) => [a.questionId, a.optionId]));
    for (const q of result.perQuestion) {
      expect(q.correct).toBe(true);
      expect(q.correctOptionId).toBe(byQuestion.get(q.questionId));
    }

    const attempts = await h.attemptRows(trainee, stage.id);
    expect(attempts).toEqual([{ attempt_number: 1, score_pct: 100, passed: true }]);
  });

  it('one below the pass mark → failed, and NO answers revealed', async () => {
    const h = need();
    const trainee = await h.newTrainee('FULL');
    const stage = await h.stage('s1'); // 5 questions at 80%: 4 passes, 3 fails
    await h.readLessons(trainee, stage.id);
    const correct = await h.correctAnswers(stage.id);
    const wrong = await h.wrongAnswers(stage.id);

    // The highest score that still fails: the largest k with round(k/n*100) < passMark.
    let boundary = stage.questionCount;
    while (
      boundary > 0 &&
      Math.round(((boundary - 1) / stage.questionCount) * 100) >= stage.passMark
    ) {
      boundary--;
    }
    const rightAnswers = boundary - 1;
    const answers = correct.map((a, i) => (i < rightAnswers ? a : wrong[i]!));

    const res = await postQuiz(trainee, 's1', answers);
    expect(res.status).toBe(200);
    const result = res.body as QuizResult;
    expect(result.pct).toBe(Math.round((rightAnswers / stage.questionCount) * 100));
    expect(result.pct).toBeLessThan(stage.passMark);
    expect(result.passed).toBe(false);
    expect(result.correctCount).toBe(rightAnswers);

    // D3: after a fail, right/wrong only.
    expect(result.perQuestion.every((q) => q.correctOptionId === null)).toBe(true);
    expect(result.perQuestion.filter((q) => q.correct)).toHaveLength(rightAnswers);
    // And nothing in the response body names an option id to copy.
    expect(res.text).not.toMatch(/"correctOptionId"\s*:\s*\d/);

    // A failed attempt completes nothing.
    const completions = await h.pool.query(
      'SELECT 1 FROM academy.stage_completions WHERE trainee_id = $1 AND stage_id = $2',
      [trainee, stage.id],
    );
    expect(completions.rowCount).toBe(0);
  });

  it('unlimited retakes: attempts increment and the best score is kept', async () => {
    const h = need();
    const trainee = await h.newTrainee('FULL');
    const stage = await h.stage('s1');
    await h.readLessons(trainee, stage.id);
    const correct = await h.correctAnswers(stage.id);
    const wrong = await h.wrongAnswers(stage.id);

    const failed = (await postQuiz(trainee, 's1', wrong)).body as QuizResult;
    expect(failed.passed).toBe(false);
    expect(failed.pct).toBe(0);

    const passed = (await postQuiz(trainee, 's1', correct)).body as QuizResult;
    expect(passed.passed).toBe(true);
    expect(passed.pct).toBe(100);

    // A worse third attempt must not undo the pass or lower the best score.
    const half = correct.map((a, i) => (i < 1 ? a : wrong[i]!));
    const third = (await postQuiz(trainee, 's1', half)).body as QuizResult;
    expect(third.passed).toBe(false);

    const attempts = await h.attemptRows(trainee, stage.id);
    expect(attempts.map((a) => a.attempt_number)).toEqual([1, 2, 3]);
    expect(Math.max(...attempts.map((a) => a.score_pct))).toBe(100);

    const { rows } = await h.pool.query<{ best_score: string }>(
      'SELECT best_score FROM academy.stage_completions WHERE trainee_id = $1 AND stage_id = $2',
      [trainee, stage.id],
    );
    expect(rows).toHaveLength(1);
    expect(Number(rows[0]!.best_score)).toBe(100);

    // A pass stays a pass: the stage is still open and still reveals answers.
    expect((await getQuiz(trainee, 's1')).status).toBe(200);
  });

  it('rejects an option that belongs to another question', async () => {
    const h = need();
    const trainee = await h.newTrainee('FULL');
    const stage = await h.stage('s1');
    await h.readLessons(trainee, stage.id);
    const correct = await h.correctAnswers(stage.id);

    const swapped = [{ questionId: correct[0]!.questionId, optionId: correct[1]!.optionId }];
    const res = await postQuiz(trainee, 's1', swapped);
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'invalid_request' });
    expect(await h.attemptRows(trainee, stage.id)).toHaveLength(0);
  });

  it('rejects a malformed body', async () => {
    const h = need();
    const trainee = await h.newTrainee('FULL');
    const stage = await h.stage('s1');
    await h.readLessons(trainee, stage.id);

    for (const body of [{}, { answers: [] }, { answers: [{ questionId: 'x', optionId: 1 }] }]) {
      const res = await request(h.app)
        .post('/api/stage/s1/quiz')
        .set(TRAINEE_HEADER, String(trainee))
        .send(body);
      expect(res.status).toBe(400);
      expect(res.body).toEqual({ error: 'invalid_request' });
    }
  });

  it('grades server-side: the same gates as GET', async () => {
    const h = need();
    const trainee = await h.newTrainee('FULL');
    const s1 = await h.stage('s1');
    const s2 = await h.stage('s2');

    // Lessons not read yet.
    const early = await postQuiz(trainee, 's1', await h.correctAnswers(s1.id));
    expect(early.status).toBe(403);
    expect(early.body).toEqual({ error: 'lessons_incomplete' });

    // Stage locked, even with every lesson read and every answer right.
    await h.readLessons(trainee, s2.id);
    const locked = await postQuiz(trainee, 's2', await h.correctAnswers(s2.id));
    expect(locked.status).toBe(403);
    expect(locked.body).toEqual({ error: 'locked', requires: 's1' });
    expect(await h.attemptRows(trainee, s2.id)).toHaveLength(0);
  });
});

describeDb('what a pass unlocks', () => {
  it('opens exactly the next stage, and nothing for anyone else', async () => {
    const h = need();
    const mine = await h.newTrainee('FULL');
    const theirs = await h.newTrainee('FULL');

    const before = await gate(h.pool, mine, 's2');
    expect(before).toMatchObject({ allowed: false, reason: 'locked', requires: 's1' });

    await passStage(mine, 's1');

    expect((await gate(h.pool, mine, 's2')).allowed).toBe(true);
    // Only the next one: s3 is still waiting for s2.
    expect(await gate(h.pool, mine, 's3')).toMatchObject({ reason: 'locked', requires: 's2' });
    // And nothing moved for the other account.
    expect(await gate(h.pool, theirs, 's2')).toMatchObject({ reason: 'locked', requires: 's1' });

    const other = await getQuiz(theirs, 's2');
    expect(other.status).toBe(403);
    expect(other.body).toEqual({ error: 'locked', requires: 's1' });
  });

  it('a department account finishing the core completes Level 1 and queues the manager DM', async () => {
    const h = need();
    h.queue.clear();
    const trainee = await h.newTrainee('ADMIN');

    // The ADMIN track's visible core, in unlock order.
    for (const code of ['s1', 's2', 's3']) await passStage(trainee, code);

    // Not yet: s6 is the last Level 1 stage this track sees.
    expect(
      await h.pool.query('SELECT 1 FROM academy.level_completions WHERE trainee_id = $1', [
        trainee,
      ]),
    ).toMatchObject({ rowCount: 0 });
    expect(await gate(h.pool, trainee, 'dA1')).toMatchObject({ reason: 'locked', requires: 's6' });

    await passStage(trainee, 's6');

    // Level 1 complete on the VISIBLE-stages basis: ADMIN never sees
    // s4, cscalls, s5 or s6calls, so they must not hold the level open.
    const levels = await h.pool.query<{ level_id: number }>(
      'SELECT level_id FROM academy.level_completions WHERE trainee_id = $1',
      [trainee],
    );
    expect(levels.rows).toHaveLength(1);
    const { rows: levelNumbers } = await h.pool.query<{ level_number: number }>(
      'SELECT level_number FROM academy.levels WHERE id = $1',
      [levels.rows[0]!.level_id],
    );
    expect(levelNumbers[0]!.level_number).toBe(1);

    // Their first academy module is now available.
    expect((await gate(h.pool, trainee, 'dA1')).allowed).toBe(true);
    expect(await gate(h.pool, trainee, 'dA2')).toMatchObject({ reason: 'locked' });

    // One manager-notify job, with the right payload.
    const jobs = h.queue.jobsOn<LevelCompleteJob>(QUEUE_NAMES.managerNotify);
    expect(jobs).toHaveLength(1);
    expect(jobs[0]?.name).toBe('level-complete');
    expect(jobs[0]?.data).toEqual({ traineeId: trainee, level: 1, track: 'ADMIN' });

    // Both modules → the department completion for the S09 certificate.
    await passStage(trainee, 'dA1');
    await passStage(trainee, 'dA2');
    const depts = await h.pool.query<{ dept: string }>(
      'SELECT dept FROM academy.dept_completions WHERE trainee_id = $1',
      [trainee],
    );
    expect(depts.rows.map((r) => r.dept)).toEqual(['ADMIN']);

    const events = await h.pool.query<{ event_type: string; payload: Record<string, unknown> }>(
      `SELECT event_type, payload FROM academy.audit_events
          WHERE trainee_id = $1 ORDER BY id`,
      [trainee],
    );
    const types = events.rows.map((r) => r.event_type);
    expect(types.filter((t) => t === 'QUIZ_SUBMIT')).toHaveLength(6);
    expect(types.filter((t) => t === 'STAGE_PASS')).toHaveLength(6);
    expect(types.filter((t) => t === 'LEVEL_PASS')).toHaveLength(1);
    expect(types.filter((t) => t === 'DEPT_PASS')).toHaveLength(1);
    const submit = events.rows.find((r) => r.event_type === 'QUIZ_SUBMIT');
    expect(submit?.payload).toMatchObject({ stage: 's1', pct: 100, result: 'PASS' });
  }, 60_000);
});

describeDb('two submissions at once', () => {
  it('records both attempts and leaves one completion row', async () => {
    const h = need();
    const trainee = await h.newTrainee('FULL');
    const stage = await h.stage('s1');
    await h.readLessons(trainee, stage.id);
    const correct = await h.correctAnswers(stage.id);

    // Six at once, not two: attempt_number is UNIQUE per (trainee, quiz), and
    // a handful of overlapping submissions is what actually catches a
    // read-then-write on it. They all have to succeed.
    const parallel = 6;
    const responses = await Promise.all(
      Array.from({ length: parallel }, () => postQuiz(trainee, 's1', correct)),
    );
    expect(responses.map((r) => r.status)).toEqual(Array<number>(parallel).fill(200));
    const results = responses.map((r) => r.body as QuizResult);
    expect(results.every((r) => r.passed && r.pct === 100)).toBe(true);
    expect(new Set(results.map((r) => r.attemptId)).size).toBe(parallel);

    // Every attempt recorded, numbered 1..n with no gap and no duplicate.
    const attempts = await h.attemptRows(trainee, stage.id);
    expect(attempts.map((r) => r.attempt_number)).toEqual(
      Array.from({ length: parallel }, (_, i) => i + 1),
    );

    const answerRows = await h.pool.query<{ n: string }>(
      `SELECT count(*) AS n FROM academy.attempt_answers aa
         JOIN academy.quiz_attempts qa ON qa.id = aa.attempt_id
        WHERE qa.trainee_id = $1`,
      [trainee],
    );
    expect(Number(answerRows.rows[0]!.n)).toBe(correct.length * parallel);

    // One completion row, one STAGE_PASS audit row: the milestone happened once.
    const completions = await h.pool.query(
      'SELECT 1 FROM academy.stage_completions WHERE trainee_id = $1 AND stage_id = $2',
      [trainee, stage.id],
    );
    expect(completions.rowCount).toBe(1);

    const passes = await h.pool.query(
      `SELECT 1 FROM academy.audit_events
        WHERE trainee_id = $1 AND event_type = 'STAGE_PASS'`,
      [trainee],
    );
    expect(passes.rowCount).toBe(1);
  });
});
