// S04 read side: the gate, GET /api/track, GET /api/stage/:code and
// POST /api/lesson/:id/read, against the REAL content in the local test
// database (MIGRATION_TEST_DB_NAME). The expected stage list per track comes
// from ops/fixtures/expected-track-visibility.json, which is typed by hand
// from PROJECT-PLAN §1 and is never generated from the prototype.
//
// The migration test drops and rebuilds the academy schema in that same
// database, so the content is gone after every full run. When PROTOTYPE_PATH
// points at the build pack the suite re-runs the S02 seed itself (local only,
// idempotent, the documented command); otherwise it skips with a message
// saying exactly how to fix it. Content is never copied into this repo.
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseEnv } from 'node:util';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type pg from 'pg';
import { TRACK_CODES } from '@fac-academy/shared';
import type { LockedResponse, StageResponse, TrackResponse } from '@fac-academy/shared';
import { TEST_DB, auditRows, get, openTestDb, post, signIn } from './helpers/authHarness.js';
import type { Db, Harness, SignedIn } from './helpers/authHarness.js';

const FIXTURE_PATH = fileURLToPath(
  new URL('../../../ops/fixtures/expected-track-visibility.json', import.meta.url),
);
const expectedStages = JSON.parse(readFileSync(FIXTURE_PATH, 'utf8')) as Record<
  string,
  string[] | unknown
>;

function expectedFor(track: string): string[] {
  const codes = expectedStages[track];
  if (!Array.isArray(codes)) throw new Error(`fixture has no stage list for ${track}`);
  return codes as string[];
}

// ---------------------------------------------------------------------------
// Open the database once, and decide up front whether there is content to test.
// ---------------------------------------------------------------------------
const REPO_ROOT = fileURLToPath(new URL('../../../', import.meta.url));

async function countStages(pool: pg.Pool): Promise<number> {
  const { rows } = await pool.query<{ n: string }>('SELECT count(*) AS n FROM academy.stages');
  return Number(rows[0]?.n ?? 0);
}

/** The prototype path, from the environment or the repo-root .env. */
function prototypePath(): string {
  if ((process.env.PROTOTYPE_PATH ?? '').trim() !== '') return process.env.PROTOTYPE_PATH!;
  const file = resolve(REPO_ROOT, '.env');
  if (!existsSync(file)) return '';
  return (parseEnv(readFileSync(file, 'utf8')).PROTOTYPE_PATH ?? '').trim();
}

/** Runs the S02 seed against the TEST database only. Returns true on success. */
function reseed(prototype: string): boolean {
  const res = spawnSync('npx', ['tsx', 'ops/seed/seed-content.ts', '--expect-db', TEST_DB], {
    cwd: REPO_ROOT,
    // --expect-db is the seed's wrong-database guard; DB_NAME points it at the
    // test database whatever .env says. Never run this against production.
    env: { ...process.env, DB_NAME: TEST_DB, PROTOTYPE_PATH: prototype },
    encoding: 'utf8',
    shell: true,
    timeout: 300_000,
  });
  if (res.status === 0) return true;
  console.warn(`[training-read] the content seed failed (exit ${String(res.status)}).`);
  return false;
}

const db: Db | null = TEST_DB ? await openTestDb() : null;
let stageCount = 0;
if (db !== null) {
  stageCount = await countStages(db.pool);
  if (stageCount === 0) {
    const prototype = prototypePath();
    if (prototype !== '' && existsSync(prototype) && reseed(prototype)) {
      stageCount = await countStages(db.pool);
    }
  }
  if (stageCount === 0) {
    console.warn(
      `[training-read] SKIPPED: ${TEST_DB} has no training content. Seed it first:\n` +
        '  DB_NAME=<test db> PROTOTYPE_PATH=<build-pack>/FAC-Academy-Portal-v2.5.html \\\n' +
        '    npx tsx ops/seed/seed-content.ts --expect-db <test db>\n' +
        '(the migration test drops the academy schema, so the content goes with it;\n' +
        ' set PROTOTYPE_PATH and this suite re-seeds by itself).',
    );
    await db.cleanup();
  }
}
const ready = db !== null && stageCount > 0;

describe.skipIf(!ready)('S04 training read side', () => {
  // Assigned in beforeAll: a skipped suite never runs its hooks, so nothing
  // here touches the database when there is no test database or no content.
  let pool: pg.Pool;
  let h: Harness;

  beforeAll(() => {
    pool = db!.pool;
    h = db!.harness();
  });

  afterAll(async () => {
    await db!.cleanup();
  });

  /** A signed-in trainee on the given track (null = waiting for one, D13). */
  async function trainee(track: string | null, harness: Harness = h): Promise<SignedIn> {
    const account = harness.crm.add(db!.newAccount());
    const session = await signIn(harness, account);
    if (track !== null) {
      await pool.query('UPDATE academy.trainees SET track = $2 WHERE id = $1', [
        session.me.id,
        track,
      ]);
    }
    return session;
  }

  async function stageIdOf(code: string): Promise<number> {
    const { rows } = await pool.query<{ id: string }>(
      'SELECT id FROM academy.stages WHERE code = $1',
      [code],
    );
    if (rows[0] === undefined) throw new Error(`no stage ${code}`);
    return Number(rows[0].id);
  }

  async function lessonIdsOf(code: string): Promise<number[]> {
    const { rows } = await pool.query<{ id: string }>(
      `SELECT l.id FROM academy.lessons l
         JOIN academy.stages s ON s.id = l.stage_id
        WHERE s.code = $1 ORDER BY l.position`,
      [code],
    );
    return rows.map((r) => Number(r.id));
  }

  /** Stand in for a quiz pass until T2's grading writes these rows. */
  async function completeStage(traineeId: number, code: string): Promise<void> {
    await pool.query(
      `INSERT INTO academy.stage_completions (trainee_id, stage_id, best_score)
       VALUES ($1, $2, 100) ON CONFLICT DO NOTHING`,
      [traineeId, await stageIdOf(code)],
    );
  }

  async function track(session: SignedIn, harness: Harness = h): Promise<TrackResponse> {
    const res = await get(harness, '/api/track', session.cookie).expect(200);
    return res.body as TrackResponse;
  }

  // -------------------------------------------------------------------------
  // GET /api/track
  // -------------------------------------------------------------------------
  // All nine tracks, not just the three representative ones: CHECKLIST 04
  // asks for the whole table.
  for (const code of TRACK_CODES) {
    it(`lists exactly the ${code} stages from the fixture, in unlock order`, async () => {
      const session = await trainee(code);
      const body = await track(session);

      expect(body.track).toBe(code);
      expect(body.waitingForTrack).toBe(false);
      expect(body.stages.map((s) => s.code)).toEqual(expectedFor(code));
      expect(body.stages.map((s) => s.position)).toEqual(expectedFor(code).map((_, i) => i + 1));
      // A fresh account: the first stage is open, everything after it is not.
      expect(body.stages.map((s) => s.state)).toEqual(
        expectedFor(code).map((_, i) => (i === 0 ? 'available' : 'locked')),
      );
      for (const stage of body.stages) {
        expect(stage.attempts).toBe(0);
        expect(stage.best).toBeNull();
        expect(stage.pct).toBe(0);
        expect(stage.passMark).toBeGreaterThanOrEqual(80);
        expect(stage.lessonCount).toBeGreaterThan(0);
        expect(stage.recordingsWithMedia).toBeLessThanOrEqual(stage.recordingCount);
      }
    });
  }

  it('tells a trainee with no track that they are waiting for one (D13)', async () => {
    const session = await trainee(null);
    const body = await track(session);
    expect(body).toEqual({ track: null, waitingForTrack: true, stages: [] });

    // And no stage opens for them, without saying which stages exist.
    const res = await get(h, '/api/stage/s1', session.cookie).expect(403);
    expect(res.body).toEqual({ error: 'locked', requires: null });
  });

  it('refuses every route without a session', async () => {
    await get(h, '/api/track').expect(401);
    await get(h, '/api/stage/s1').expect(401);
    await post(h, '/api/lesson/1/read').expect(401);
  });

  it('answers 503 for every training route while ACADEMY_V2 is off', async () => {
    const off = db!.harness({ flagEnabled: false });
    await get(off, '/api/track').expect(503, { flag: 'off' });
    await get(off, '/api/stage/s1').expect(503, { flag: 'off' });
    await post(off, '/api/lesson/1/read').expect(503, { flag: 'off' });
  });

  // -------------------------------------------------------------------------
  // GET /api/stage/:code — the gate
  // -------------------------------------------------------------------------
  it('opens stage 1 and 403s every later stage, naming what it requires', async () => {
    const codes = expectedFor('FULL');
    const session = await trainee('FULL');

    const first = await get(h, `/api/stage/${codes[0]}`, session.cookie).expect(200);
    const detail = first.body as StageResponse;
    expect(detail.stage.code).toBe(codes[0]);
    expect(detail.stage.state).toBe('available');
    expect(detail.lessons.length).toBeGreaterThan(0);
    // The server is the only source of lesson HTML.
    expect(detail.lessons[0]?.bodyHtml.length).toBeGreaterThan(0);

    let locked = 0;
    for (const [i, code] of codes.entries()) {
      if (i === 0) continue;
      const res = await get(h, `/api/stage/${code}`, session.cookie).expect(403);
      const body = res.body as LockedResponse;
      expect(body).toEqual({ error: 'locked', requires: codes[i - 1] });
      // A locked stage leaks nothing else.
      expect(Object.keys(body).sort()).toEqual(['error', 'requires']);
      locked++;
    }
    expect(locked).toBe(codes.length - 1);
  });

  it('403s every locked stage on all nine tracks (scripted sweep)', async () => {
    const totals = { tracks: 0, open: 0, locked: 0, wrongRequires: 0 };
    for (const code of TRACK_CODES) {
      const codes = expectedFor(code);
      const session = await trainee(code);
      totals.tracks++;
      for (const [i, stageCode] of codes.entries()) {
        const res = await get(h, `/api/stage/${stageCode}`, session.cookie);
        if (i === 0) {
          expect(res.status).toBe(200);
          totals.open++;
          continue;
        }
        expect(res.status).toBe(403);
        if ((res.body as LockedResponse).requires !== codes[i - 1]) totals.wrongRequires++;
        totals.locked++;
      }
    }
    const expectedLocked = TRACK_CODES.reduce((n, c) => n + expectedFor(c).length - 1, 0);
    expect(totals).toEqual({
      tracks: TRACK_CODES.length,
      open: TRACK_CODES.length,
      locked: expectedLocked,
      wrongRequires: 0,
    });
  });

  it('404s a stage on another track, and an unknown code, the same way', async () => {
    const session = await trainee('ADMIN');
    const foreign = ['s4', 'cscalls', 'dF1', 'l2s1'];
    for (const code of foreign) {
      expect(expectedFor('ADMIN')).not.toContain(code);
      await get(h, `/api/stage/${code}`, session.cookie).expect(404, { error: 'not_found' });
    }
    await get(h, '/api/stage/no-such-stage', session.cookie).expect(404, { error: 'not_found' });
    // Too long for stages.code, so it cannot be a stage: same answer.
    await get(h, `/api/stage/${'x'.repeat(40)}`, session.cookie).expect(404, {
      error: 'not_found',
    });
  });

  it('unlocks exactly the next stage when one is completed', async () => {
    const codes = expectedFor('CS');
    const session = await trainee('CS');
    const other = await trainee('CS');

    await completeStage(session.me.id, codes[0]!);

    const body = await track(session);
    expect(body.stages.map((s) => s.state)).toEqual(
      codes.map((_, i) => (i === 0 ? 'done' : i === 1 ? 'available' : 'locked')),
    );
    await get(h, `/api/stage/${codes[1]}`, session.cookie).expect(200);
    // A passed stage stays open (unlimited retakes, re-reading).
    await get(h, `/api/stage/${codes[0]}`, session.cookie).expect(200);
    if (codes.length > 2) {
      await get(h, `/api/stage/${codes[2]}`, session.cookie).expect(403);
    }

    // Nothing moved for anyone else.
    const untouched = await track(other);
    expect(untouched.stages.map((s) => s.state)).toEqual(
      codes.map((_, i) => (i === 0 ? 'available' : 'locked')),
    );
  });

  it('honours STAGE1_AUTH_REQUIRED without changing anything else', async () => {
    const strict = db!.harness({ stage1AuthRequired: true });
    const codes = expectedFor('FULL');
    const session = await trainee('FULL', strict);
    await completeStage(session.me.id, codes[0]!);

    // Stage 1 is passed, but no manager has authorised progress.
    const blocked = await track(session, strict);
    expect(blocked.stages[1]?.state).toBe('locked');
    const res = await get(strict, `/api/stage/${codes[1]}`, session.cookie).expect(403);
    expect((res.body as LockedResponse).requires).toBe(codes[0]);

    await pool.query(
      `INSERT INTO academy.progression_authorisations (trainee_id, authorised, authorised_at)
       VALUES ($1, TRUE, now())
       ON CONFLICT (trainee_id) DO UPDATE SET authorised = TRUE`,
      [session.me.id],
    );
    const opened = await track(session, strict);
    expect(opened.stages[1]?.state).toBe('available');
    await get(strict, `/api/stage/${codes[1]}`, session.cookie).expect(200);
    // Nothing else moved: the rest of the list is still sequential.
    expect(opened.stages[2]?.state).toBe('locked');
    // With the flag off (the default everywhere else) the authorisation is
    // never asked for: see "unlocks exactly the next stage when one is
    // completed", which runs on the default harness.
  });

  // -------------------------------------------------------------------------
  // POST /api/lesson/:id/read
  // -------------------------------------------------------------------------
  it('marks a lesson read once, idempotently, and audits it once', async () => {
    const codes = expectedFor('FULL');
    const session = await trainee('FULL');
    const lessons = await lessonIdsOf(codes[0]!);
    const lessonId = lessons[0]!;

    await post(h, `/api/lesson/${lessonId}/read`, session.cookie).expect(204);
    await post(h, `/api/lesson/${lessonId}/read`, session.cookie).expect(204);

    const { rows } = await pool.query<{ n: string }>(
      'SELECT count(*) AS n FROM academy.lesson_progress WHERE trainee_id = $1',
      [session.me.id],
    );
    expect(Number(rows[0]?.n)).toBe(1);

    const audits = await auditRows(pool, {
      traineeId: session.me.id,
      eventType: 'LESSON_READ',
    });
    expect(audits).toHaveLength(1);
    expect(audits[0]?.actor).toBe(`trainee:${session.me.id}`);
    expect(audits[0]?.payload).toMatchObject({ lessonId, stage: codes[0] });

    const detail = (await get(h, `/api/stage/${codes[0]}`, session.cookie).expect(200))
      .body as StageResponse;
    expect(detail.lessons.find((l) => l.id === lessonId)?.read).toBe(true);
  });

  it('refuses a lesson read in a locked stage, and hides other tracks entirely', async () => {
    const codes = expectedFor('FULL');
    const session = await trainee('FULL');
    const lockedLesson = (await lessonIdsOf(codes[1]!))[0]!;
    const res = await post(h, `/api/lesson/${lockedLesson}/read`, session.cookie).expect(403);
    expect(res.body).toEqual({ error: 'locked', requires: codes[0] });

    const admin = await trainee('ADMIN');
    const foreign = (await lessonIdsOf('s4'))[0]!;
    await post(h, `/api/lesson/${foreign}/read`, admin.cookie).expect(404, { error: 'not_found' });

    await post(h, '/api/lesson/999999999/read', session.cookie).expect(404, {
      error: 'not_found',
    });
    await post(h, '/api/lesson/abc/read', session.cookie).expect(400, {
      error: 'invalid_request',
    });

    // Nothing was written for any of those.
    const { rows } = await pool.query<{ n: string }>(
      'SELECT count(*) AS n FROM academy.lesson_progress WHERE trainee_id = ANY($1::bigint[])',
      [[session.me.id, admin.me.id]],
    );
    expect(Number(rows[0]?.n)).toBe(0);
  });

  // -------------------------------------------------------------------------
  // The quiz summary on the stage detail
  // -------------------------------------------------------------------------
  it('keeps the quiz blocked by lessons until every lesson is read', async () => {
    const code = expectedFor('FULL')[0]!;
    const session = await trainee('FULL');
    const lessons = await lessonIdsOf(code);
    expect(lessons.length).toBeGreaterThan(1);

    const before = (await get(h, `/api/stage/${code}`, session.cookie).expect(200))
      .body as StageResponse;
    expect(before.quiz.unlocked).toBe(false);
    expect(before.quiz.blockedBy).toBe('lessons');
    expect(before.quiz.questionCount).toBeGreaterThan(0);
    expect(before.quiz.passed).toBe(false);
    expect(before.quiz.attempts).toBe(0);

    for (const id of lessons.slice(0, -1)) {
      await post(h, `/api/lesson/${id}/read`, session.cookie).expect(204);
    }
    const partway = (await get(h, `/api/stage/${code}`, session.cookie).expect(200))
      .body as StageResponse;
    expect(partway.quiz.blockedBy).toBe('lessons');

    await post(h, `/api/lesson/${lessons.at(-1)}/read`, session.cookie).expect(204);
    const after = (await get(h, `/api/stage/${code}`, session.cookie).expect(200))
      .body as StageResponse;
    expect(after.quiz.unlocked).toBe(true);
    // Recordings do not block until S06 flips RECORDINGS_GATE_ENABLED, even
    // though this stage has "coming soon" slots (D4).
    expect(after.quiz.blockedBy).toBeNull();
    expect(after.recordings.every((r) => !r.listened)).toBe(true);
  });

  it('marks a "coming soon" recording slot and never counts it as media (D4)', async () => {
    const code = expectedFor('FULL')[0]!;
    const session = await trainee('FULL');
    const detail = (await get(h, `/api/stage/${code}`, session.cookie).expect(200))
      .body as StageResponse;
    expect(detail.recordings.length).toBeGreaterThan(0);
    for (const rec of detail.recordings) {
      expect(typeof rec.comingSoon).toBe('boolean');
      if (rec.comingSoon) expect(rec.durationSecs).toBeNull();
      expect(['AUDIO', 'VIDEO']).toContain(rec.mediaType);
    }
    expect(detail.stage.recordingsWithMedia).toBe(
      detail.recordings.filter((r) => !r.comingSoon).length,
    );
  });
});
