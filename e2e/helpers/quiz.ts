import { expect } from '@playwright/test';
import type { Page } from '@playwright/test';
import { getQuiz } from './api.js';
import type { QuizBody, QuizResultBody } from './api.js';
import { correctAnswersForStage } from './db.js';

// Taking a quiz the way a trainee does: on the quiz page, one radio per
// question, then Submit. The option ids are the radio values, so the right
// answer from the database can be clicked without reading any option text.

export type Intent = 'correct' | 'wrong';

/** Ticks one option per question: the right one, or a wrong one on purpose. */
export async function chooseAnswers(page: Page, quiz: QuizBody, intent: Intent): Promise<void> {
  const correct = new Map(
    (await correctAnswersForStage(quiz.stageCode)).map((a) => [a.questionId, a.optionId]),
  );
  const cards = page.getByTestId('question-card');
  await expect(cards).toHaveCount(quiz.questions.length);
  for (let i = 0; i < quiz.questions.length; i += 1) {
    const radios = cards.nth(i).getByRole('radio');
    const values = await radios.evaluateAll((nodes) =>
      nodes.map((n) => (n as HTMLInputElement).value),
    );
    const questionId = quiz.questions[i]?.id ?? 0;
    const right = String(correct.get(questionId));
    const pick = intent === 'correct' ? right : values.find((v) => v !== right);
    const at = values.indexOf(pick ?? '');
    expect(at, `an option to click for question ${String(questionId)}`).toBeGreaterThanOrEqual(0);
    await radios.nth(at).check();
  }
}

/** Submits, and returns what the server graded — not what the screen says. */
export async function submitAnswers(page: Page, stageCode: string): Promise<QuizResultBody> {
  const graded = page.waitForResponse(
    (r) =>
      r.url().includes(`/api/stage/${stageCode}/quiz`) &&
      r.request().method() === 'POST' &&
      r.status() === 200,
  );
  await page.getByRole('button', { name: 'Submit answers' }).click();
  return (await (await graded).json()) as QuizResultBody;
}

/** Open the quiz page, answer it, submit. */
export async function takeQuizInUi(
  page: Page,
  stageCode: string,
  intent: Intent,
): Promise<{ quiz: QuizBody; result: QuizResultBody }> {
  const loaded = await getQuiz(page, stageCode);
  expect(loaded.status, `GET /api/stage/${stageCode}/quiz`).toBe(200);
  await page.goto(`/stage/${encodeURIComponent(stageCode)}/quiz`);
  await chooseAnswers(page, loaded.body, intent);
  const result = await submitAnswers(page, stageCode);
  return { quiz: loaded.body, result };
}
