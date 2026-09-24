import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { getJson, getQuiz, postJson, putJson, readLesson } from '../helpers/api.js';
import { lessonIdsForStage, playableRecordings } from '../helpers/db.js';
import { REPO_ROOT } from '../helpers/env.js';
import { prepared } from '../helpers/state.js';
import { expect, test } from '../helpers/test.js';

// 7. SECURITY.
//
// Five things, each one a separate way in:
//   * a STAFF session on the manager API and the manager screens;
//   * the quiz payload: it must not carry a correct flag in any shape;
//   * the built bundle: no lesson text and no answer ever ships to the browser
//     (the checker already exists — this calls it rather than writing a second
//     one);
//   * media: no session, no bytes; locked stage, no bytes; and a crafted path
//     gets nowhere;
//   * the public certificate check: one answer for everything that is not a
//     real certificate, and nothing in it beyond the five agreed facts.

const STAGE = 's1';

test.describe('a staff session cannot reach anything a manager can', () => {
  test('every manager route answers 403, and no management link is shown', async ({
    staff,
    staffPage,
  }) => {
    await staff.reset('CS');
    const me = staff.account.traineeId;

    const reads = [
      '/api/manager/ping',
      '/api/manager/roster',
      '/api/manager/stuck',
      '/api/manager/export.csv',
      `/api/manager/trainee/${String(me)}`,
      '/api/manager/preview/CS',
      '/api/manager/config',
    ];
    for (const path of reads) {
      const response = await getJson<{ error: string }>(staffPage, path);
      expect(response.status, `GET ${path}`).toBe(403);
      expect(response.body, `GET ${path}`).toEqual({ error: 'forbidden' });
    }

    // The writes are aimed at the signed-in account itself, so that a broken
    // guard could not disable or reassign anybody else.
    for (const path of [
      `/api/manager/trainees/${String(me)}/disable`,
      `/api/manager/trainees/${String(me)}/enable`,
    ]) {
      const response = await postJson<{ error: string }>(staffPage, path);
      expect(response.status, `POST ${path}`).toBe(403);
      expect(response.body).toEqual({ error: 'forbidden' });
    }
    const track = await putJson<{ error: string }>(
      staffPage,
      `/api/manager/trainees/${String(me)}/track`,
      { track: 'ADMIN' },
    );
    expect(track.status).toBe(403);
    expect(track.body).toEqual({ error: 'forbidden' });

    // And the account really is still on the track it was on.
    const after = await getJson<{ me: { track: string } }>(staffPage, '/api/me');
    expect(after.body.me.track).toBe('CS');

    // The screens: no link to the management area, and the page itself refuses.
    await staffPage.goto('/');
    await expect(staffPage.getByRole('link', { name: 'Management' })).toHaveCount(0);
    await staffPage.goto('/manager');
    await expect(staffPage.getByText(/don.t have access to this page/)).toBeVisible();
  });
});

test.describe('nothing that should stay on the server reaches the browser', () => {
  test('the quiz payload carries no correct answer, in any shape', async ({ staff, staffPage }) => {
    await staff.reset('CS');
    for (const lessonId of await lessonIdsForStage(STAGE)) {
      expect(await readLesson(staffPage, lessonId)).toBe(204);
    }
    const quiz = await getQuiz(staffPage, STAGE);
    expect(quiz.status).toBe(200);
    expect(quiz.body.questions.length).toBeGreaterThan(0);

    // No key that could name the answer, anywhere in the raw JSON. (The word
    // itself may appear inside a question, so this looks for JSON KEYS.)
    expect(quiz.text).not.toMatch(/"(is_?correct|correct|correctOptionId|answer|answers)"\s*:/i);
    // And each option is exactly { id, text }: no extra field to hide it in.
    for (const question of quiz.body.questions) {
      expect(Object.keys(question).sort()).toEqual(['id', 'options', 'prompt']);
      for (const option of question.options) {
        expect(Object.keys(option).sort()).toEqual(['id', 'text']);
      }
    }
  });

  test('the built bundle contains no lesson text and no answer', async () => {
    const dist = path.join(REPO_ROOT, 'client', 'dist');
    expect(
      existsSync(dist),
      'client/dist must exist — run `npm run build -w client` before the suite',
    ).toBe(true);

    const output = execFileSync(
      process.execPath,
      [path.join('scripts', 'check-bundle-leaks.mjs')],
      { cwd: REPO_ROOT, encoding: 'utf8' },
    );
    // A pass with zero canaries would prove nothing, so the count is checked.
    const canaries = /OK \((\d+) canaries, (\d+) files/.exec(output);
    expect(output, 'the bundle leak checker').toContain('check-bundle-leaks: OK');
    expect(canaries, 'the checker must report how much it checked').not.toBeNull();
    expect(Number(canaries?.[1] ?? 0), 'canaries in the fixture').toBeGreaterThan(0);
    expect(Number(canaries?.[2] ?? 0), 'files scanned in client/dist').toBeGreaterThan(0);
  });
});

test.describe('media', () => {
  test('is refused without a session, on a locked stage, and by a crafted path', async ({
    staff,
    staffPage,
    browser,
  }) => {
    await staff.reset('CS');
    const fixture = prepared().fixture;
    const locked = await playableRecordings('cscalls');
    expect(locked.length).toBeGreaterThan(0);

    // No session at all.
    const stranger = await browser.newContext();
    try {
      const anonymous = await stranger.request.get(
        `/api/media/${String(fixture.recordingId)}/stream`,
        { failOnStatusCode: false },
      );
      expect(anonymous.status(), 'streaming without a session').toBe(401);
      expect(await anonymous.json()).toEqual({ error: 'not_signed_in' });
    } finally {
      await stranger.close();
    }

    // A session, but the recording's stage is locked (nothing has been passed).
    const gated = await staffPage.request.get(`/api/media/${String(locked[0]!.id)}/stream`, {
      failOnStatusCode: false,
    });
    expect(gated.status(), 'streaming a locked stage').toBe(403);
    expect(await gated.json()).toEqual({ error: 'locked', requires: 's4' });

    // A crafted id gets nowhere near the filesystem.
    for (const id of ['..%2F..%2Fetc%2Fpasswd', '0', '-1', 'abc']) {
      const crafted = await staffPage.request.get(`/api/media/${id}/stream`, {
        failOnStatusCode: false,
      });
      expect([400, 404], `GET /api/media/${id}/stream`).toContain(crafted.status());
    }
  });
});

test.describe('the public certificate check', () => {
  test('says the same thing about everything that is not a certificate', async ({ browser }) => {
    const anyone = await browser.newContext();
    try {
      const ids = [
        'AAAAAAAAAAAAAAAAAAAAAA', // well formed, never issued
        'short',
        '../../etc/passwd',
        'x'.repeat(200),
      ];
      const bodies: string[] = [];
      for (const id of ids) {
        const response = await anyone.request.get(`/api/cert/${encodeURIComponent(id)}/verify`, {
          failOnStatusCode: false,
        });
        expect(response.status(), `GET /api/cert/${id}/verify`).toBe(200);
        bodies.push(await response.text());
      }
      for (const body of bodies) {
        expect(JSON.parse(body)).toEqual({ valid: false });
      }
      expect(new Set(bodies).size, 'every non-certificate gets the same answer').toBe(1);
    } finally {
      await anyone.close();
    }
  });
});
