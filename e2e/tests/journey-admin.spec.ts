import { readFileSync } from 'node:fs';
import type { Page } from '@playwright/test';
import { fastForwardStages, getJson, getQuiz, getTrack, readLesson } from '../helpers/api.js';
import { certificatesOf, lessonIdsForStage } from '../helpers/db.js';
import { expectedStages } from '../helpers/expected.js';
import { chooseAnswers, submitAnswers } from '../helpers/quiz.js';
import { expect, test } from '../helpers/test.js';

// 3b. THE ADMIN (DEPARTMENT) JOURNEY.
//
// The Admin track is the short one: four Level 1 stages (s1 s2 s3 s6) and then
// the two Admin academy modules (dA1 dA2). This walks it to the end and proves
// the two things only a department track can prove:
//
//   * finishing the LEVEL raises the completion banner and issues a
//     certificate that downloads as a real PDF and verifies on the public page;
//   * finishing the DEPARTMENT issues a second, different certificate.
//
// The last core stage (s6) and the first department module (dA1) are taken in
// the browser, question by question. s1–s3 and the twenty-question dA2 go
// through the same endpoints without the clicking, so the run stays inside a
// couple of minutes.

const TRACK = 'ADMIN';

interface VerifyBody {
  valid: boolean;
  name?: string;
  track?: string;
  kind?: string;
  completed?: string;
  issuedAt?: string;
}

test('an Admin trainee: the core, the department modules, the banner, the certificates', async ({
  staff,
  staffPage,
}) => {
  test.setTimeout(6 * 60_000);
  const page = staffPage;
  await staff.reset(TRACK);

  const stages = expectedStages(TRACK);
  expect(stages).toEqual(['s1', 's2', 's3', 's6', 'dA1', 'dA2']);

  // --- nothing is earned yet ---------------------------------------------
  await page.goto('/certificates');
  await expect(page.getByText(/don.t have any certificates yet/)).toBeVisible();

  // --- the core, up to the last stage ------------------------------------
  await fastForwardStages(page, ['s1', 's2', 's3']);

  // --- the last core stage, in the browser -------------------------------
  const s6 = await getQuiz(page, 's6');
  expect(s6.status, 'the quiz is blocked until the lessons are read').toBe(403);
  expect(s6.body).toEqual({ error: 'lessons_incomplete' });
  await fastForwardLessonsOnly(page, 's6');

  const loaded = await getQuiz(page, 's6');
  expect(loaded.status).toBe(200);
  await page.goto('/stage/s6/quiz');
  await chooseAnswers(page, loaded.body, 'correct');
  const s6Result = await submitAnswers(page, 's6');
  expect(s6Result.passed).toBe(true);
  await expect(page.getByRole('heading', { name: /passed/ })).toBeVisible();

  // --- Level 1 is complete: the banner and the certificate ---------------
  await page.goto('/');
  const banner = page.getByLabel('Your latest accomplishment');
  await expect(banner).toBeVisible();
  await expect(banner.getByText('Completed')).toBeVisible();
  const bannerTitle = await banner.innerText();

  const mine = await certificatesOf(staff.account.traineeId);
  expect(mine.map((c) => c.kind)).toEqual(['LEVEL']);
  const level = mine[0]!;
  expect(bannerTitle.length).toBeGreaterThan('Completed'.length);

  await page.goto('/certificates');
  const card = page.getByRole('listitem').filter({ hasText: level.publicId });
  await expect(card).toBeVisible();
  await expect(card.getByText(`Certificate id: ${level.publicId}`)).toBeVisible();

  // --- the PDF really downloads ------------------------------------------
  const download = page.waitForEvent('download');
  await card.getByRole('link', { name: 'Download PDF' }).click();
  const file = await (await download).path();
  const bytes = readFileSync(file);
  expect(bytes.subarray(0, 5).toString('ascii'), 'a real PDF').toBe('%PDF-');
  expect(bytes.byteLength).toBeGreaterThan(5_000);

  // --- and verifies publicly, with five facts and nothing else -----------
  const verify = await getJson<VerifyBody>(page, `/api/cert/${level.publicId}/verify`);
  expect(verify.status).toBe(200);
  expect(Object.keys(verify.body).sort()).toEqual([
    'completed',
    'issuedAt',
    'kind',
    'name',
    'track',
    'valid',
  ]);
  expect(verify.body.valid).toBe(true);
  expect(verify.body.name).toBe(staff.account.fullName);
  expect(verify.body.track).toBe(TRACK);
  expect(verify.body.kind).toBe('LEVEL');
  expect(verify.text).not.toContain(staff.account.email);

  // The public page itself: no session, so a separate context with no cookies.
  const publicContext = await page.context().browser()!.newContext();
  try {
    const anyone = await publicContext.newPage();
    await anyone.goto(`/verify/${level.publicId}`);
    await expect(anyone.getByRole('heading', { name: staff.account.fullName })).toBeVisible();
    await expect(anyone.getByText('Certificate id')).toBeVisible();
    const html = await anyone.content();
    expect(html, 'the public check must not print the email address').not.toContain(
      staff.account.email,
    );
    // What a verifier reads: a name, what was completed, the programme, the
    // date and the id. No score, no stage, nothing about anybody else. (The
    // visible text, not the markup — the stylesheet is full of percentages.)
    const shown = await anyone.locator('body').innerText();
    expect(shown, 'no score on the public check').not.toMatch(/\d{1,3}\s?%/);
    expect(shown, 'no stage detail').not.toMatch(/quiz|attempt|stage/i);
    expect(shown).toContain('Admin');
    expect(shown).toContain(level.publicId);
  } finally {
    await publicContext.close();
  }

  // --- the department modules --------------------------------------------
  await fastForwardLessonsOnly(page, 'dA1');
  const dA1 = await getQuiz(page, 'dA1');
  expect(dA1.status).toBe(200);
  await page.goto('/stage/dA1/quiz');
  await chooseAnswers(page, dA1.body, 'correct');
  expect((await submitAnswers(page, 'dA1')).passed).toBe(true);

  // Passing the first module must NOT finish the academy on its own.
  expect((await certificatesOf(staff.account.traineeId)).map((c) => c.kind)).toEqual(['LEVEL']);

  await fastForwardStages(page, ['dA2']);

  const after = await certificatesOf(staff.account.traineeId);
  expect(after.map((c) => c.kind).sort()).toEqual(['DEPT', 'LEVEL']);
  const dept = after.find((c) => c.kind === 'DEPT')!;
  const deptVerify = await getJson<VerifyBody>(page, `/api/cert/${dept.publicId}/verify`);
  expect(deptVerify.body.valid).toBe(true);
  expect(deptVerify.body.kind).toBe('DEPT');
  expect(deptVerify.body.completed).not.toBe(verify.body.completed);

  // --- the whole programme is done ---------------------------------------
  const track = await getTrack(page);
  expect(track.stages.map((s) => s.state)).toEqual(stages.map(() => 'done'));
  await page.goto('/');
  await expect(page.getByRole('heading', { name: /Training complete/ })).toBeVisible();
  await page.goto('/certificates');
  await expect(page.getByRole('listitem')).toHaveCount(2);
});

/** Marks every lesson of a stage read, leaving the quiz as the only step left. */
async function fastForwardLessonsOnly(page: Page, code: string): Promise<void> {
  for (const lessonId of await lessonIdsForStage(code)) {
    expect(await readLesson(page, lessonId), `POST /api/lesson/${String(lessonId)}/read`).toBe(204);
  }
}
