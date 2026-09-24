import { readFileSync } from 'node:fs';
import { fastForwardStages, getJson, getTrack, readLesson, submitQuiz } from '../helpers/api.js';
import { lessonIdsForStage, wrongAnswersForStage } from '../helpers/db.js';
import { expectedStages } from '../helpers/expected.js';
import { expect, test } from '../helpers/test.js';
import { CONTENT_FREE_TAG } from '../helpers/tags.js';

// 6. THE MANAGER.
//
// One manager and one trainee, in two browsers at once:
//
//   * the roster picks up a new attempt within one refresh (the page polls
//     every 30 seconds — the test waits for it rather than reloading, because
//     "it updates when you press F5" is not the claim);
//   * the online dot says who is here: the trainee in the other browser is
//     online, and an account that has never signed in is not;
//   * the CSV downloads and has a row per trainee;
//   * reassigning a track changes what that trainee sees;
//   * disabling ends their session — the test measures how long that takes and
//     holds it to the five seconds the checklist asks for.
//
// The order matters: disabling is last, because it ends the session the
// earlier tests are using.

test.describe.configure({ mode: 'serial' });

const ROSTER_REFRESH_MS = 30_000;

interface RosterRow {
  id: number;
  fullName: string;
  track: string | null;
  onlineNow: boolean;
  attempts: number;
  fails: number;
  isDisabled: boolean;
}

interface Roster {
  trainees: RosterRow[];
  counts: { total: number };
}

test('the roster shows a trainee, their attempts and who is online', async ({
  staff,
  staffPage,
  managerPage,
}) => {
  test.setTimeout(3 * 60_000);
  await staff.reset('CS');

  await managerPage.goto('/manager');
  await expect(managerPage.getByRole('heading', { name: 'Trainee roster' })).toBeVisible();
  const row = managerPage.locator(`[data-trainee="${String(staff.account.traineeId)}"]`);
  await expect(row).toBeVisible();

  // --- the online dot ------------------------------------------------------
  // The trainee's browser is open in the other context, so they are here.
  await staffPage.goto('/');
  await expect(staffPage.getByRole('heading', { level: 1 })).toBeVisible();
  await expect
    .poll(
      async () => {
        const roster = await getJson<Roster>(managerPage, '/api/manager/roster');
        return roster.body.trainees.find((t) => t.id === staff.account.traineeId)?.onlineNow;
      },
      { timeout: 30_000, message: 'the signed-in trainee should show as online' },
    )
    .toBe(true);

  // A seeded account that has never signed in is not online, and the dot says so.
  const roster = await getJson<Roster>(managerPage, '/api/manager/roster');
  const neverSignedIn = roster.body.trainees.find((t) => t.fullName.startsWith('Test Trainee'));
  expect(neverSignedIn, 'the per-track dev accounts are on the roster').toBeDefined();
  expect(neverSignedIn?.onlineNow).toBe(false);
  await expect(
    managerPage.locator(`[data-trainee="${String(neverSignedIn!.id)}"] [data-online]`),
  ).toHaveAttribute('data-online', 'false');
  await expect(row.locator('[data-online]')).toHaveAttribute('data-online', 'true');

  // --- a new attempt appears within one refresh ---------------------------
  const before = roster.body.trainees.find((t) => t.id === staff.account.traineeId)?.attempts ?? 0;
  for (const lessonId of await lessonIdsForStage('s1')) {
    expect(await readLesson(staffPage, lessonId)).toBe(204);
  }
  const failed = await submitQuiz(staffPage, 's1', await wrongAnswersForStage('s1'));
  expect(failed.status).toBe(200);
  expect(failed.body.passed).toBe(false);

  // No reload: the manager's page is left alone and polled for. It is brought
  // to the front first, because the roster's 30-second refresh is paused while
  // its tab is in the background — as it should be, and as it would not be for
  // a manager actually watching it.
  await managerPage.bringToFront();
  await expect
    .poll(async () => row.locator('[data-stage="s1"]').count(), {
      timeout: ROSTER_REFRESH_MS + 20_000,
      intervals: [1_000],
      message: 'the roster should show the new attempt within one refresh',
    })
    .toBeGreaterThan(0);
  await expect(row.locator('[data-stage="s1"]')).toHaveAttribute('data-tone', 'fail');

  const after = await getJson<Roster>(managerPage, '/api/manager/roster');
  expect(after.body.trainees.find((t) => t.id === staff.account.traineeId)?.attempts).toBe(
    before + 1,
  );
});

// CONTENT_FREE_TAG: a roster is a list of people, not of training. This asks
// only that the export has a row per trainee and carries no markup, which is
// as true of an unseeded database as of a seeded one — so it runs in CI.
test(
  'the CSV has a row for every trainee on the roster',
  { tag: CONTENT_FREE_TAG },
  async ({ managerPage }) => {
    await managerPage.goto('/manager');
    const roster = await getJson<Roster>(managerPage, '/api/manager/roster');
    expect(roster.status).toBe(200);

    const download = managerPage.waitForEvent('download');
    await managerPage.getByTestId('export-csv-button').click();
    const file = await (await download).path();
    const csv = readFileSync(file, 'utf8');

    const lines = csv.trim().split(/\r?\n/);
    expect(lines[0], 'a header row').toMatch(/^id,/);
    // Every data row starts with the trainee id, so this counts rows and not
    // newlines that happen to sit inside a quoted field.
    const dataRows = lines.filter((line) => /^\d+,/.test(line));
    expect(dataRows.length, 'one row per trainee').toBe(roster.body.trainees.length);
    for (const trainee of roster.body.trainees) {
      expect(csv).toContain(trainee.fullName);
    }
    // A manager export is a list of people: it must not carry training content.
    expect(csv).not.toMatch(/<p>|<h[1-6]>/);
  },
);

test('reassigning a track changes what the trainee sees', async ({
  staff,
  staffPage,
  managerPage,
}) => {
  await staff.reset('CS');
  await staffPage.goto('/');
  expect((await getTrack(staffPage)).stages.map((s) => s.code)).toEqual(expectedStages('CS'));

  await managerPage.goto('/manager');
  const row = managerPage.locator(`[data-trainee="${String(staff.account.traineeId)}"]`);
  await expect(row).toBeVisible();
  await row.getByLabel(`Track for ${staff.account.fullName}`).selectOption('DEBT');
  await row.getByRole('button', { name: 'Assign' }).click();
  await expect(row.getByLabel(`Track for ${staff.account.fullName}`)).toHaveValue('DEBT');

  await staffPage.reload();
  await expect
    .poll(
      async () =>
        staffPage
          .locator('[data-stage]')
          .evaluateAll((nodes) => nodes.map((n) => n.getAttribute('data-stage') ?? '')),
      { timeout: 20_000, message: 'the trainee now sees the Debt Collections programme' },
    )
    .toEqual(expectedStages('DEBT'));
  expect((await getTrack(staffPage)).track).toBe('DEBT');
});

// CONTENT_FREE_TAG: sign in, be disabled, be thrown out, be re-enabled, sign in
// again. Not one step of it touches a stage, so CI runs it — and it is the one
// place CI proves the real sign-in journey (the login screen, the authenticator
// enrolment, the code) works in a browser at all.
test(
  'disabling a trainee ends their session within five seconds',
  { tag: CONTENT_FREE_TAG },
  async ({ staff, staffPage, managerPage }) => {
    test.setTimeout(3 * 60_000);
    await staff.reset('CS');
    // A working session first, so the change of state is the thing measured.
    await staffPage.goto('/');
    expect((await getJson(staffPage, '/api/track')).status).toBe(200);

    await managerPage.goto('/manager');
    const row = managerPage.locator(`[data-trainee="${String(staff.account.traineeId)}"]`);
    await expect(row).toBeVisible();
    await row.getByRole('button', { name: 'Disable', exact: true }).click();
    await row.getByRole('button', { name: 'Yes, disable' }).click();

    // Timed from the moment the manager confirmed. Disabling deletes every
    // session of that trainee, so the next request is refused either because the
    // session is gone (401) or because the account is disabled (403) — both mean
    // they are out; what is being held to five seconds is how long it takes.
    const startedAt = Date.now();
    let refusal = { status: 200, body: {} as { error?: string } };
    while (Date.now() - startedAt < 15_000) {
      const response = await getJson<{ error?: string }>(staffPage, '/api/track');
      if (response.status !== 200) {
        refusal = { status: response.status, body: response.body };
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    const took = Date.now() - startedAt;
    expect([401, 403], 'the disabled account is refused').toContain(refusal.status);
    expect(['not_signed_in', 'disabled']).toContain(refusal.body.error);
    expect(took, `the session ended after ${String(took)}ms`).toBeLessThan(5_000);
    console.log(`disable → session refused after ${String(took)}ms (${String(refusal.status)})`);

    // The screens agree: the roster greys them out, and the trainee is put out.
    await expect(row).toHaveAttribute('data-disabled', 'true');
    await staffPage.goto('/');
    await expect(
      staffPage.getByRole('heading', { name: 'Sign in to start training' }),
    ).toBeVisible();

    // Put it back, and sign in again so the next spec in this worker has a
    // session. Re-enabling is a manager action too, so it is worth asserting.
    await row.getByRole('button', { name: 'Re-enable' }).click();
    await expect(row).toHaveAttribute('data-disabled', 'false');
    await staff.refresh();
    const fresh = await staff.open();
    expect((await getJson(fresh, '/api/track')).status).toBe(200);
    await fresh.context().close();
  },
);

test('a manager can preview a track without touching anybody', async ({ managerPage, staff }) => {
  await managerPage.goto('/manager/preview/FOS');
  const section = managerPage.locator('[data-preview="FOS"]');
  await expect(section).toBeVisible();
  const codes = await section
    .locator('[data-stage]')
    .evaluateAll((nodes) => nodes.map((n) => n.getAttribute('data-stage') ?? ''));
  expect(codes).toEqual(expectedStages('FOS'));

  // The preview is read-only: the trainee it does not name is untouched.
  await staff.reset('CS');
  const trainee = await getJson<{ trainee: RosterRow; stages: { code: string }[] }>(
    managerPage,
    `/api/manager/trainee/${String(staff.account.traineeId)}`,
  );
  expect(trainee.status).toBe(200);
  expect(trainee.body.trainee.track).toBe('CS');
  expect(trainee.body.stages.map((s) => s.code)).toEqual(expectedStages('CS'));
});

test('the manager screens carry no training content', async ({ managerPage, staff, staffPage }) => {
  // A roster is a list of people and progress. Nothing a trainee has to learn
  // — no lesson, no question, no answer — may travel with it.
  await staff.reset('CS');
  await fastForwardStages(staffPage, ['s1']);

  const roster = await getJson<Roster>(managerPage, '/api/manager/roster');
  const detail = await getJson(
    managerPage,
    `/api/manager/trainee/${String(staff.account.traineeId)}`,
  );
  for (const payload of [roster.text, detail.text]) {
    expect(payload).not.toMatch(/<p>|<li>|<h[1-6]>/);
    expect(payload).not.toMatch(/"(prompt|bodyHtml|options|correct)"\s*:/);
  }
});
