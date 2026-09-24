import { beacon, fastForwardStages, getQuiz, getStage, readLesson } from '../helpers/api.js';
import type { BeaconBody } from '../helpers/api.js';
import {
  correctAnswersForStage,
  lessonIdsForStage,
  lessonTextSampleForStage,
  playableRecordings,
} from '../helpers/db.js';
import { requireFixture } from '../helpers/state.js';
import { expect, test } from '../helpers/test.js';

// 3a. THE CUSTOMER SERVICE JOURNEY.
//
// One trainee, one stage, end to end and in the browser: the lessons, the
// listening gate, a deliberate failure, the retake, and the next stage opening.
//
// Two things to be straight about:
//
//  * The stage is s4 ("Customer Service Excellence"), reached by fast-forwarding
//    s1–s3 through the real API. s4 carries the short fixture recording that
//    ops/dev/e2e-prepare.ts installs: 20 seconds of real, generated audio in a
//    slot the seed leaves empty. The gate it has to get past is the REAL one —
//    the server's wall-clock rule, unchanged — and the test pays it in real
//    time, beacon by beacon. The six seeded call recordings run from 6 to 17
//    minutes, and no suite can sit through those; what this proves about them
//    instead is at the end, where a real 7-minute recording is streamed (and
//    its stage's quiz is still refused, because nobody has listened to it).
//  * The answers come out of the database. A test cannot pass a quiz honestly
//    without knowing them, and the point here is the journey, not guessing.

const STAGE = 's4';
const NEXT_STAGE = 'cscalls';
const PASS_HEADING = /passed/;

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * Listens at the pace the server accepts: two seconds of media for every two
 * seconds of wall clock. Nothing here is faster than real time, which is the
 * whole point of the rule being tested.
 */
async function listenHonestly(
  page: Parameters<typeof beacon>[0],
  recordingId: number,
  from: number,
  durationSecs: number,
): Promise<BeaconBody> {
  const stepSecs = 2;
  let at = from;
  let last: BeaconBody | null = null;
  while (at < durationSecs) {
    await sleep(stepSecs * 1000 + 250);
    const to = Math.min(at + stepSecs, durationSecs);
    const sent = await beacon(page, recordingId, [[at, to]]);
    expect(sent.status, 'the listening beacon').toBe(200);
    last = sent.body;
    at = to;
  }
  if (last === null) throw new Error('e2e: no beacon was sent.');
  return last;
}

test('a Customer Service trainee: lessons, a real listen, a fail, a retake, the next stage', async ({
  staff,
  staffPage,
}) => {
  test.setTimeout(5 * 60_000);
  const page = staffPage;
  const fixture = requireFixture();
  expect(fixture.stageCode, 'the fixture recording belongs to this stage').toBe(STAGE);

  await staff.reset('CS');
  await fastForwardStages(page, ['s1', 's2', 's3']);

  // --- the stage opens, and the quiz does not ---------------------------
  let stage = await getStage(page, STAGE);
  expect(stage.status).toBe(200);
  expect(stage.body.quiz.unlocked).toBe(false);
  expect(stage.body.quiz.blockedBy).toBe('lessons');
  expect((await getQuiz(page, STAGE)).status).toBe(403);
  expect((await getQuiz(page, STAGE)).body).toEqual({ error: 'lessons_incomplete' });

  await page.goto(`/stage/${STAGE}`);
  await expect(page.getByText('Read every lesson in this stage to unlock the quiz.')).toBeVisible();

  // --- read every lesson, in the browser --------------------------------
  const lessonIds = await lessonIdsForStage(STAGE);
  expect(lessonIds.length).toBeGreaterThan(1);
  const sentence = await lessonTextSampleForStage(STAGE);
  for (const [index, lessonId] of lessonIds.entries()) {
    await page.goto(`/stage/${STAGE}/lesson/${String(lessonId)}`);
    await expect(page.getByRole('button', { name: /Mark lesson complete/ })).toBeVisible();
    if (index === 0) {
      // The lesson HTML really is served here, and nowhere else.
      expect(await page.content()).toContain(sentence);
    }
    await page.getByRole('button', { name: /Mark lesson complete/ }).click();
    await expect(page.getByText(/Marked as read/)).toBeVisible();
  }

  // --- now the recordings are what is in the way ------------------------
  stage = await getStage(page, STAGE);
  expect(stage.body.quiz.unlocked).toBe(false);
  expect(stage.body.quiz.blockedBy).toBe('recordings');
  expect((await getQuiz(page, STAGE)).body).toEqual({ error: 'recordings_incomplete' });

  await page.goto(`/stage/${STAGE}`);
  await expect(page.getByText(/Listen to every call recording in this stage/)).toBeVisible();
  const player = page.locator(`[data-recording="${String(fixture.recordingId)}"]`);
  await expect(player).toHaveAttribute('data-listened', 'false');

  // --- a skip is refused -------------------------------------------------
  // One beacon claiming the whole recording at once. The server credits only
  // the seconds that have actually passed (its first-beacon allowance), so
  // this buys a fraction of the recording and never the badge.
  const skipped = await beacon(page, fixture.recordingId, [[0, fixture.durationSecs]]);
  expect(skipped.status).toBe(200);
  expect(skipped.body.listened, 'a single claim of the whole recording must not count').toBe(false);
  expect(skipped.body.coveredSecs).toBeLessThanOrEqual(11);
  expect(skipped.body.durationSecs).toBe(fixture.durationSecs);

  // Still blocked, and the badge the page shows is the server's answer.
  expect((await getQuiz(page, STAGE)).body).toEqual({ error: 'recordings_incomplete' });

  // --- an honest listen, at the pace the rule allows ---------------------
  const finished = await listenHonestly(
    page,
    fixture.recordingId,
    skipped.body.coveredSecs,
    fixture.durationSecs,
  );
  expect(finished.listened, 'listening in full must count').toBe(true);

  await page.reload();
  await expect(player).toHaveAttribute('data-listened', 'true');
  await expect(player.getByText('Listened ✓', { exact: true })).toBeVisible();

  // --- the quiz opens, and carries no answers ---------------------------
  const quiz = await getQuiz(page, STAGE);
  expect(quiz.status).toBe(200);
  expect(quiz.body.questions.length).toBeGreaterThan(0);
  expect(quiz.text).not.toMatch(/"is_?[cC]orrect"|"correct"\s*:|correctOptionId/);

  const correct = new Map(
    (await correctAnswersForStage(STAGE)).map((a) => [a.questionId, a.optionId]),
  );

  // --- fail it on purpose -----------------------------------------------
  await page.goto(`/stage/${STAGE}/quiz`);
  const cards = page.getByTestId('question-card');
  await expect(cards).toHaveCount(quiz.body.questions.length);

  const chooseAll = async (wanted: 'correct' | 'wrong'): Promise<void> => {
    const count = await cards.count();
    for (let i = 0; i < count; i += 1) {
      const radios = cards.nth(i).getByRole('radio');
      const values = await radios.evaluateAll((nodes) =>
        nodes.map((n) => (n as HTMLInputElement).value),
      );
      const questionId = quiz.body.questions[i]?.id ?? 0;
      const right = String(correct.get(questionId));
      const pick = wanted === 'correct' ? right : values.find((v) => v !== right);
      const at = values.indexOf(pick ?? '');
      expect(at, `an option to click for question ${String(questionId)}`).toBeGreaterThanOrEqual(0);
      await radios.nth(at).check();
    }
  };

  await chooseAll('wrong');
  const failed = page.waitForResponse(
    (r) => r.url().includes(`/api/stage/${STAGE}/quiz`) && r.request().method() === 'POST',
  );
  await page.getByRole('button', { name: 'Submit answers' }).click();
  const failedBody = (await (await failed).json()) as {
    passed: boolean;
    pct: number;
    perQuestion: { correctOptionId: number | null }[];
  };

  expect(failedBody.passed).toBe(false);
  expect(failedBody.pct).toBe(0);
  // D3: right and wrong only. Not one correct answer comes back.
  expect(failedBody.perQuestion.every((q) => q.correctOptionId === null)).toBe(true);
  await expect(page.getByRole('heading', { name: /Not quite/ })).toBeVisible();
  await expect(
    page.getByTestId('correct-answer'),
    'a failed attempt must not reveal a single answer',
  ).toHaveCount(0);

  // --- retake, and pass --------------------------------------------------
  await page.getByRole('button', { name: 'Try again' }).click();
  await expect(page.getByRole('button', { name: 'Submit answers' })).toBeVisible();
  await chooseAll('correct');
  const passed = page.waitForResponse(
    (r) => r.url().includes(`/api/stage/${STAGE}/quiz`) && r.request().method() === 'POST',
  );
  await page.getByRole('button', { name: 'Submit answers' }).click();
  const passedBody = (await (await passed).json()) as { passed: boolean; pct: number };
  expect(passedBody.passed).toBe(true);
  expect(passedBody.pct).toBe(100);
  await expect(page.getByRole('heading', { name: PASS_HEADING })).toBeVisible();
  // Only now are the answers shown.
  await expect(page.getByTestId('correct-answer')).toHaveCount(quiz.body.questions.length);

  // --- the next stage is open --------------------------------------------
  await page.goto('/');
  await expect(page.locator(`[data-stage="${STAGE}"]`)).toHaveAttribute('data-state', 'done');
  await expect(page.locator(`[data-stage="${NEXT_STAGE}"]`)).toHaveAttribute(
    'data-state',
    'available',
  );

  // --- and the real recordings behind it are streamed, and still gated ----
  const real = await playableRecordings(NEXT_STAGE);
  expect(real.length, 'the seeded call recordings').toBeGreaterThan(0);
  const first = real[0]!;
  expect(first.durationSecs ?? 0).toBeGreaterThan(300); // minutes long: not listenable here
  const ranged = await page.request.get(`/api/media/${String(first.id)}/stream`, {
    headers: { Range: 'bytes=0-2047' },
    failOnStatusCode: false,
  });
  expect(ranged.status(), 'a real recording streams to an unlocked stage').toBe(206);
  expect(ranged.headers()['content-length']).toBe('2048');
  expect((await ranged.body()).byteLength).toBe(2048);
  // Nobody has listened to it, so its quiz stays shut — the same rule, on the
  // real thing. (Its lessons are read first, so the block that is left can
  // only be the recordings.)
  for (const lessonId of await lessonIdsForStage(NEXT_STAGE)) {
    expect(await readLesson(page, lessonId)).toBe(204);
  }
  expect((await getQuiz(page, NEXT_STAGE)).body).toEqual({ error: 'recordings_incomplete' });
});
