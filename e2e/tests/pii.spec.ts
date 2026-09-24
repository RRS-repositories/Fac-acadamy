import { getJson, getQuiz, getStage, getTrack, readLesson } from '../helpers/api.js';
import { allContentText, lessonIdsForStage } from '../helpers/db.js';
import { canaryFor, contentCanaries, piiCanaries, scan } from '../helpers/canaries.js';
import { expect, test } from '../helpers/test.js';

// 8. THE PII SWEEP.
//
// The approved prototype carries real staff email addresses (CLAUDE.md: it
// "has real staff names and emails", which is why it never enters this repo).
// Those strings, and the names inside them, must appear in NO response.
//
// The suite checks that with hashes, never with the strings:
// e2e/fixtures/pii-canaries.json holds { label, length, sha256 } only, and
// e2e/helpers/canaries.ts reuses the sliding-window scanner that
// scripts/check-bundle-leaks.mjs already uses on the browser bundle.
//
// Because a hash sweep that found nothing would look exactly like a hash sweep
// that was broken, the first test is a control: it builds a canary for a
// string of the suite's own, proves the scanner finds it, and proves it does
// not find it in text that does not contain it.

const CONTROL = 'Wilhelmina Quailsworth of 42 Fictional Terrace';

test('the scanner works (the control for everything below)', async () => {
  const canary = canaryFor(CONTROL, 'control');
  expect(canary.length).toBeGreaterThan(20);

  expect(scan(`prefix ${CONTROL} suffix`, [canary])).toEqual(['control']);
  // Whitespace and case are normalised on both sides, as in the bundle check.
  expect(scan(`  ${CONTROL.toUpperCase().replace(/ /g, '\n')}  `, [canary])).toEqual(['control']);
  expect(scan('nothing of the sort in here', [canary])).toEqual([]);

  // And the fixtures the sweep uses are real fixtures, not empty ones.
  expect(piiCanaries().length).toBeGreaterThan(0);
  expect(contentCanaries().length).toBeGreaterThan(0);
  for (const c of [...piiCanaries(), ...contentCanaries()]) {
    expect(c.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(c.length).toBeGreaterThan(5);
  }
});

test('no response, and no seeded content, carries a real person from the prototype', async ({
  staff,
  staffPage,
}) => {
  test.setTimeout(4 * 60_000);
  const canaries = piiCanaries();
  await staff.reset('ADMIN');

  const swept: { what: string; text: string }[] = [];
  const sweep = (what: string, text: string): void => {
    swept.push({ what, text });
  };

  // Everything a signed-in trainee can pull.
  sweep('GET /api/me', (await getJson(staffPage, '/api/me')).text);
  const track = await getTrack(staffPage);
  sweep('GET /api/track', JSON.stringify(track));
  sweep('GET /api/status-guide', (await getJson(staffPage, '/api/status-guide')).text);
  sweep('GET /api/certs', (await getJson(staffPage, '/api/certs')).text);

  // The open stage, its lessons in full, and its quiz.
  const open = track.stages.find((s) => s.state !== 'locked');
  expect(open, 'at least one stage is open').toBeDefined();
  const stage = await getStage(staffPage, open!.code);
  expect(stage.status).toBe(200);
  sweep(`GET /api/stage/${open!.code}`, stage.text);
  for (const lessonId of await lessonIdsForStage(open!.code)) {
    expect(await readLesson(staffPage, lessonId)).toBe(204);
  }
  const quiz = await getQuiz(staffPage, open!.code);
  expect(quiz.status).toBe(200);
  sweep(`GET /api/stage/${open!.code}/quiz`, quiz.text);

  // The rendered pages too: a string can reach a person through the markup
  // without ever being in a JSON body.
  for (const url of ['/', `/stage/${open!.code}`, '/status-guide', '/certificates']) {
    await staffPage.goto(url);
    await expect(staffPage.getByRole('heading').first()).toBeVisible();
    sweep(`page ${url}`, await staffPage.content());
  }

  // And the whole seeded library, straight from the database: the API serves
  // one stage at a time, and a sweep of what is reachable today would miss a
  // string sitting in a stage this account cannot see.
  for (const [index, text] of (await allContentText()).entries()) {
    sweep(`seeded content #${String(index)}`, text);
  }

  const leaks: string[] = [];
  for (const { what, text } of swept) {
    for (const label of scan(text, canaries)) leaks.push(`${what} carries "${label}"`);
  }
  expect(leaks, 'personal data from the prototype').toEqual([]);
  expect(swept.length, 'the sweep looked at a real amount of text').toBeGreaterThan(50);
});

test('the answers and lesson text do not travel where they should not', async ({
  staff,
  staffPage,
}) => {
  const canaries = contentCanaries();
  await staff.reset('CS');

  // The S02 canaries are a quiz answer, a lesson sentence and a Status Guide
  // line. The Status Guide is firm-wide reference and the lesson sentence
  // belongs to a lesson, so the check here is about where they must NOT be:
  // the track list, a quiz payload, and anything a locked stage answers.
  const payloads = [
    ['GET /api/track', (await getJson(staffPage, '/api/track')).text],
    ['GET /api/me', (await getJson(staffPage, '/api/me')).text],
    ['GET /api/certs', (await getJson(staffPage, '/api/certs')).text],
  ] as const;

  for (const [what, text] of payloads) {
    const answers = scan(text, canaries).filter((label) => label.startsWith('answer'));
    expect(answers, `${what} must never carry a quiz answer`).toEqual([]);
    const lessons = scan(text, canaries).filter((label) => label.startsWith('lesson'));
    expect(lessons, `${what} must never carry lesson text`).toEqual([]);
  }

  // A locked stage is the sharper case: nothing of its content, by any route.
  const locked = (await getTrack(staffPage)).stages.find((s) => s.state === 'locked');
  expect(locked, 'a fresh CS account has locked stages').toBeDefined();
  const refused = await getStage(staffPage, locked!.code);
  expect(refused.status).toBe(403);
  expect(scan(refused.text, canaries), 'a refusal carries no content at all').toEqual([]);

  // (A quiz payload is NOT checked against the answer canaries: the correct
  //  option's text is one of the four options a trainee has to choose from, so
  //  it is meant to be there. What must not be there is any sign of WHICH one
  //  it is — that is security.spec.ts's check on the payload's shape.)
});
