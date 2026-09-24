import { getJson, getQuiz, getStage } from '../helpers/api.js';
import { lessonIdsForStage, lessonTextSampleForStage } from '../helpers/db.js';
import { TRACKS, expectedStages, foreignStage } from '../helpers/expected.js';
import { expect, test } from '../helpers/test.js';

// 2. THE LOCKED SWEEP.
//
// For a fresh account on each of the nine tracks:
//
//   * every stage after the first is refused by the API with the same
//     403 { error: 'locked', requires: <the stage they must pass first> };
//   * its quiz is refused too — the lock is not something the stage page alone
//     enforces;
//   * the locked stage's own URL renders the locked card and carries NONE of
//     the lesson text (checked against a real sentence read out of the
//     database, so this cannot pass by the page being empty of everything);
//   * a stage that belongs to another track answers exactly like a stage that
//     does not exist at all — same status, same body. A trainee must not be
//     able to map the other tracks by watching which ids answer differently.

test.describe('locked content is refused, everywhere', () => {
  for (const track of TRACKS) {
    test(`${track}: locked stages, locked quizzes, and no sign of other tracks`, async ({
      staff,
      staffPage,
    }) => {
      const expected = expectedStages(track);
      await staff.reset(track);

      // --- the API refuses every stage after the first -----------------
      for (let i = 1; i < expected.length; i += 1) {
        const code = expected[i]!;
        const stage = await getStage(staffPage, code);
        expect(stage.status, `GET /api/stage/${code}`).toBe(403);
        expect(stage.body).toEqual({ error: 'locked', requires: expected[i - 1] });

        const quiz = await getQuiz(staffPage, code);
        expect(quiz.status, `GET /api/stage/${code}/quiz`).toBe(403);
        expect(quiz.body).toEqual({ error: 'locked', requires: expected[i - 1] });
      }

      // --- the first stage IS open (so the sweep above means something) --
      const first = await getStage(staffPage, expected[0]!);
      expect(first.status, `GET /api/stage/${expected[0]!}`).toBe(200);
      expect(first.body.lessons.length).toBeGreaterThan(0);

      // --- another track's stage looks like nothing at all ---------------
      const foreign = foreignStage(track);
      const hidden = await getStage(staffPage, foreign);
      const madeUp = await getStage(staffPage, 'not-a-stage');
      expect(hidden.status, `GET /api/stage/${foreign} (another track)`).toBe(404);
      expect(hidden.body).toEqual({ error: 'not_found' });
      expect(hidden.body).toEqual(madeUp.body);
      expect(hidden.status).toBe(madeUp.status);
      const foreignQuiz = await getQuiz(staffPage, foreign);
      expect(foreignQuiz.status).toBe(404);
      expect(foreignQuiz.body).toEqual({ error: 'not_found' });

      // --- the locked stage's page shows the lock and no content ---------
      const locked = expected[1]!;
      const sentence = await lessonTextSampleForStage(locked);
      await staffPage.goto(`/stage/${encodeURIComponent(locked)}`);
      await expect(staffPage.getByText('This stage is locked')).toBeVisible();
      const html = await staffPage.content();
      expect(html, `the locked page for ${locked} must not carry its lesson text`).not.toContain(
        sentence,
      );

      // --- and the foreign stage's page does not admit it exists ---------
      await staffPage.goto(`/stage/${encodeURIComponent(foreign)}`);
      // The copy uses a typographic apostrophe, so match it loosely. The page
      // says the stage is not part of their programme and nothing more — no
      // title, no lesson, no hint that another track has it.
      await expect(staffPage.getByText(/isn.t part of your programme/)).toBeVisible();
      const foreignHtml = await staffPage.content();
      expect(foreignHtml).not.toContain(await lessonTextSampleForStage(foreign));
    });
  }

  test('a lesson of a locked stage is refused by id as well', async ({ staff, staffPage }) => {
    const expected = expectedStages('CS');
    await staff.reset('CS');
    // Reading a lesson is a POST by lesson id; the gate has to catch it there
    // too, or the "read" that unlocks a quiz could be granted from anywhere.
    const lockedStage = expected[1]!;
    const stage = await getJson<{ lessons: { id: number }[] }>(
      staffPage,
      `/api/stage/${encodeURIComponent(lockedStage)}`,
    );
    expect(stage.status).toBe(403);

    // The ids are not in the response (that is the point), so they come from
    // the database — exactly the ids a curious trainee could guess.
    for (const lessonId of await lessonIdsForStage(lockedStage)) {
      const response = await staffPage.request.post(`/api/lesson/${String(lessonId)}/read`, {
        failOnStatusCode: false,
      });
      expect(response.status(), `POST /api/lesson/${String(lessonId)}/read`).toBe(403);
    }
  });
});
