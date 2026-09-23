// S07 CHECKLIST 07: the manager API, against the real local test database
// (MIGRATION_TEST_DB_NAME). Runs only when that variable is set.
//
// Every account here is invented (@example.com, tagged per run) and removed
// afterwards. No training content lives in this file: stage codes come from
// ops/fixtures/expected-track-visibility.json (typed by hand from the project
// plan) and correct answers are read out of the seeded database, never from a
// fixture, so nothing about the prototype is copied into the repo.
//
// Timestamps that the DB views compare against now() (online-now, the 7-day
// inactivity rule) are written with SQL relative to now(), not with the
// harness clock: the views run in Postgres and know nothing about it.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import request from 'supertest';
import { afterAll, describe, expect, it } from 'vitest';
import type pg from 'pg';
import { TRACK_CODES } from '@fac-academy/shared';
import type {
  ManagerConfig,
  PreviewTrackResponse,
  RosterResponse,
  StuckResponse,
  TraineeDetail,
} from '@fac-academy/shared';
import { BOM } from '../../src/modules/manager/export.js';
import { TEST_DB, auditRows, get, openTestDb, post, signIn } from './helpers/authHarness.js';
import type { Db, Harness, SignedIn } from './helpers/authHarness.js';
import { isSeeded } from './helpers/quizHarness.js';

const FIXTURE_PATH = fileURLToPath(
  new URL('../../../ops/fixtures/expected-track-visibility.json', import.meta.url),
);
const expectedStages = JSON.parse(readFileSync(FIXTURE_PATH, 'utf8')) as Record<string, unknown>;

function expectedFor(track: string): string[] {
  const codes = expectedStages[track];
  if (!Array.isArray(codes)) throw new Error(`fixture has no stage list for ${track}`);
  return codes as string[];
}

// The database is opened at module scope, not in beforeAll: whether the suite
// (and the content-dependent tests inside it) can run has to be known while
// the tests are being collected.
let database: Db | null = null;
let seeded = false;

if (TEST_DB === '') {
  console.warn('[manager.test] MIGRATION_TEST_DB_NAME is not set: skipping the manager API tests.');
} else {
  try {
    database = await openTestDb();
    seeded = await isSeeded(database.pool);
    if (!seeded) {
      console.warn(
        `[manager.test] ${TEST_DB} has no seeded content: the content-dependent tests are\n` +
          '  skipped. Fix: PROTOTYPE_PATH=<build-pack>/FAC-Academy-Portal-v2.5.html and run again.',
      );
    }
  } catch (err) {
    console.warn(`[manager.test] test database unavailable: ${(err as Error).message}`);
  }
}

/** Audit rows this suite writes with no trainee_id, so cleanup can find them. */
const SUITE_START = new Date();

describe.skipIf(database === null)('S07 manager API (test DB)', () => {
  const db = database!;

  afterAll(async () => {
    // Summary rows (roster, stuck, export, preview) carry no trainee_id, so
    // the harness cleanup cannot see them. Remove this run's own.
    await db.pool.query(
      `DELETE FROM academy.audit_events
        WHERE trainee_id IS NULL
          AND event_type = ANY($1::text[])
          AND created_at >= $2`,
      [['MANAGER_VIEW', 'MANAGER_PREVIEW', 'EXPORT_CSV'], SUITE_START],
    );
    await db.cleanup();
  });

  function setup(opts?: Parameters<Db['harness']>[0]): Harness {
    return db.harness(opts);
  }

  async function manager(h: Harness): Promise<SignedIn> {
    return signIn(h, h.crm.add(db.newAccount({ role: 'Management' })));
  }

  async function staff(h: Harness, opts: { fullName?: string } = {}): Promise<SignedIn> {
    return signIn(h, h.crm.add(db.newAccount({ role: 'Sales', ...opts })));
  }

  /** PUTs a track the way a manager does. `null` takes the track away. */
  function putTrack(h: Harness, mgr: SignedIn, traineeId: number | string, body: unknown) {
    return request(h.app)
      .put(`/api/manager/trainees/${traineeId}/track`)
      .set('Cookie', mgr.cookie)
      .send(body as object);
  }

  /** Puts a trainee on a track (or takes it away with null) through the API. */
  async function assignTrack(
    h: Harness,
    mgr: SignedIn,
    traineeId: number,
    track: string | null,
  ): Promise<void> {
    const res = await putTrack(h, mgr, traineeId, { track });
    expect(res.status).toBe(204);
  }

  /** Only this run's accounts: every email ends `.<tag>@example.com`. */
  function onlyMine(path: string): string {
    const sep = path.includes('?') ? '&' : '?';
    return `${path}${sep}q=.${db.tag}@example.com`;
  }

  async function roster(h: Harness, mgr: SignedIn, query = ''): Promise<RosterResponse> {
    const res = await get(h, onlyMine(`/api/manager/roster${query}`), mgr.cookie);
    expect(res.status).toBe(200);
    return res.body as RosterResponse;
  }

  function rowFor(list: RosterResponse, id: number) {
    const row = list.trainees.find((t) => t.id === id);
    if (row === undefined) throw new Error(`trainee ${String(id)} is not on the roster`);
    return row;
  }

  /** The options that grade correct, read from the database. */
  async function correctAnswers(
    pool: pg.Pool,
    stageCode: string,
  ): Promise<{ questionId: number; optionId: number }[]> {
    const { rows } = await pool.query<{ question_id: string; option_id: string }>(
      `SELECT DISTINCT ON (q.id) q.id AS question_id, o.id AS option_id
         FROM academy.questions q
         JOIN academy.quizzes z ON z.id = q.quiz_id
         JOIN academy.stages s ON s.id = z.stage_id
         JOIN academy.question_options o ON o.question_id = q.id
        WHERE s.code = $1 AND q.is_active AND q.approval_state = 'APPROVED' AND o.is_correct
        ORDER BY q.id, o.position`,
      [stageCode],
    );
    return rows.map((r) => ({ questionId: Number(r.question_id), optionId: Number(r.option_id) }));
  }

  /** Reads every lesson of the stage and passes its quiz, over HTTP. */
  async function passStage(h: Harness, who: SignedIn, stageCode: string): Promise<void> {
    const stage = await get(h, `/api/stage/${stageCode}`, who.cookie);
    expect(stage.status).toBe(200);
    for (const lesson of (stage.body as { lessons: { id: number }[] }).lessons) {
      expect((await post(h, `/api/lesson/${lesson.id}/read`, who.cookie)).status).toBe(204);
    }
    const answers = await correctAnswers(db.pool, stageCode);
    const res = await post(h, `/api/stage/${stageCode}/quiz`, who.cookie, { answers });
    expect(res.status).toBe(200);
    expect((res.body as { passed: boolean }).passed).toBe(true);
  }

  // ---- Checklist: STAFF session → 403 on every manager route ---------------

  describe('a staff session cannot reach the manager API', () => {
    it('403 forbidden on every route, 401 with no session at all', async () => {
      const h = setup();
      const who = await staff(h);
      const mgr = await manager(h);

      const paths = [
        '/api/manager/roster',
        '/api/manager/stuck',
        `/api/manager/trainee/${who.me.id}`,
        '/api/manager/export.csv',
        '/api/manager/preview/CS',
        '/api/manager/config',
        '/api/manager/ping',
      ];
      for (const path of paths) {
        const denied = await get(h, path, who.cookie);
        expect([path, denied.status]).toEqual([path, 403]);
        expect(denied.body).toEqual({ error: 'forbidden' });
        // No session at all is a 401, not a hint that the route exists.
        expect([path, (await get(h, path)).status]).toEqual([path, 401]);
        // ...and the same route answers a manager (ping has no body).
        const allowed = await get(h, path, mgr.cookie);
        expect([path, allowed.status]).toEqual([path, path.endsWith('/ping') ? 204 : 200]);
      }
    });

    it('a staff session cannot export, preview or read another trainee', async () => {
      const h = setup();
      const who = await staff(h);
      const other = await staff(h);
      const res = await get(h, `/api/manager/trainee/${other.me.id}`, who.cookie);
      expect(res.status).toBe(403);
      expect(res.body).toEqual({ error: 'forbidden' });
    });
  });

  // ---- Checklist: a quiz pass shows on the roster at the next refresh ------

  describe('the roster follows what trainees actually do', () => {
    it('a trainee with no track is "waiting for track"', async () => {
      const h = setup();
      const mgr = await manager(h);
      const who = await staff(h);

      const row = rowFor(await roster(h, mgr), who.me.id);
      expect(row).toMatchObject({
        track: null,
        stagesTotal: 0,
        stagesDone: 0,
        currentStageCode: null,
        currentStageDisplayNum: null,
        attempts: 0,
        fails: 0,
        bestAverage: null,
        isDisabled: false,
        status: 'ACTIVE',
        stage1Authorised: false,
      });
      // No track, so no chips: the roster shows a record, not a syllabus.
      expect(row.stages).toEqual([]);
      expect((await roster(h, mgr)).counts.waitingForTrack).toBeGreaterThanOrEqual(1);
    });

    it.skipIf(!seeded)('a quiz pass appears within one refresh', async () => {
      const h = setup();
      const mgr = await manager(h);
      const who = await staff(h);
      await assignTrack(h, mgr, who.me.id, 'CS');

      const expected = expectedFor('CS');
      const before = rowFor(await roster(h, mgr), who.me.id);
      expect(before.stagesTotal).toBe(expected.length);
      expect(before.stagesDone).toBe(0);
      expect(before.currentStageCode).toBe(expected[0]);
      expect(before.attempts).toBe(0);
      // Nothing attempted yet, so the chip column is empty rather than a row
      // of untouched stages.
      expect(before.stages).toEqual([]);
      expect(before.currentStageDisplayNum).not.toBeNull();

      await passStage(h, who, expected[0]!);

      // One refresh: the very next roster read.
      const after = rowFor(await roster(h, mgr), who.me.id);
      expect(after.attempts).toBe(1);
      expect(after.fails).toBe(0);
      expect(after.stagesDone).toBe(1);
      expect(after.bestAverage).toBe(100);
      expect(after.currentStageCode).toBe(expected[1]);
      expect(after.lastActivityAt).not.toBeNull();

      // One chip, for the stage they actually sat, capped by the track length.
      expect(after.stages).toHaveLength(1);
      expect(after.stages[0]).toMatchObject({
        code: expected[0],
        attempts: 1,
        fails: 0,
        best: 100,
        passed: true,
      });
      expect(after.stages[0]?.displayNum).not.toBe('');
      expect(after.stages.length).toBeLessThanOrEqual(after.stagesTotal);

      // The detail view agrees, and uses the trainee's own unlock rule.
      const detail = (await get(h, `/api/manager/trainee/${who.me.id}`, mgr.cookie))
        .body as TraineeDetail;
      expect(detail.stages.map((s) => s.code)).toEqual(expected);
      expect(detail.stages[0]).toMatchObject({ state: 'done', attempts: 1, fails: 0, best: 100 });
      expect(detail.stages[1]?.state).toBe('available');
      expect(detail.stages[2]?.state).toBe('locked');
      expect(detail.stages[0]?.lastAttemptAt).not.toBeNull();
    });

    it.skipIf(!seeded)('carries the per-stage chips for everyone on the page', async () => {
      const h = setup();
      const mgr = await manager(h);
      const failing = await staff(h);
      const passing = await staff(h);
      await assignTrack(h, mgr, failing.me.id, 'CS');
      await assignTrack(h, mgr, passing.me.id, 'CS');

      const first = expectedFor('CS')[0]!;
      // Two failed attempts on a stage that stays unpassed. Written with SQL:
      // what is under test is the roster's chip query, not the grader.
      await db.pool.query(
        `INSERT INTO academy.quiz_attempts
            (trainee_id, quiz_id, attempt_number, score_pct, passed, started_at, submitted_at)
       SELECT $1, z.id, g.n, 40, FALSE, now(), now()
         FROM academy.quizzes z
         JOIN academy.stages s ON s.id = z.stage_id
         CROSS JOIN generate_series(1, 2) AS g(n)
        WHERE s.code = $2`,
        [failing.me.id, first],
      );
      await passStage(h, passing, first);

      // ONE roster read fills in both people's chips.
      const list = await roster(h, mgr);
      expect(rowFor(list, failing.me.id).stages).toEqual([
        expect.objectContaining({ code: first, attempts: 2, fails: 2, best: 40, passed: false }),
      ]);
      expect(rowFor(list, passing.me.id).stages).toEqual([
        expect.objectContaining({ code: first, attempts: 1, fails: 0, best: 100, passed: true }),
      ]);
      // Nobody's chip list can be longer than their own track.
      for (const t of list.trainees) {
        expect(t.stages.length).toBeLessThanOrEqual(t.stagesTotal);
      }
    });

    it('filters by track, by search text and by disabled', async () => {
      const h = setup();
      const mgr = await manager(h);
      const a = await staff(h, { fullName: `Filter Alpha ${db.tag}` });
      const b = await staff(h, { fullName: `Filter Beta ${db.tag}` });
      await assignTrack(h, mgr, a.me.id, 'ADMIN');
      await assignTrack(h, mgr, b.me.id, 'PAY');

      const admin = await roster(h, mgr, '?track=ADMIN');
      expect(admin.trainees.map((t) => t.id)).toContain(a.me.id);
      expect(admin.trainees.map((t) => t.id)).not.toContain(b.me.id);

      const byName = await get(
        h,
        `/api/manager/roster?q=${encodeURIComponent(`Filter Beta ${db.tag}`)}`,
        mgr.cookie,
      );
      expect((byName.body as RosterResponse).trainees.map((t) => t.id)).toEqual([b.me.id]);

      expect((await post(h, `/api/manager/trainees/${b.me.id}/disable`, mgr.cookie)).status).toBe(
        204,
      );
      const withDisabled = await roster(h, mgr);
      expect(rowFor(withDisabled, b.me.id).isDisabled).toBe(true);
      expect(withDisabled.counts.disabled).toBeGreaterThanOrEqual(1);
      const without = await roster(h, mgr, '?includeDisabled=false');
      expect(without.trainees.map((t) => t.id)).not.toContain(b.me.id);

      expect((await get(h, '/api/manager/roster?track=NOPE', mgr.cookie)).status).toBe(400);
    });

    it('sorts by name and counts what it returns', async () => {
      const h = setup();
      const mgr = await manager(h);
      await staff(h, { fullName: `Zulu Sorting ${db.tag}` });
      await staff(h, { fullName: `Alpha Sorting ${db.tag}` });
      const list = await get(
        h,
        `/api/manager/roster?q=${encodeURIComponent(`Sorting ${db.tag}`)}`,
        mgr.cookie,
      );
      const body = list.body as RosterResponse;
      const names = body.trainees.map((t) => t.fullName);
      expect(names).toEqual([...names].sort());
      expect(body.counts.total).toBe(body.trainees.length);
    });
  });

  // ---- Checklist: online now inside 3 minutes, off after 4 ----------------

  describe('the online indicator', () => {
    async function setLastSeen(traineeId: number, minutesAgo: number): Promise<void> {
      await db.pool.query(
        `UPDATE academy.sessions
            SET last_seen_at = now() - ($2 || ' minutes')::interval,
                signed_out_at = NULL, revoked = FALSE
          WHERE trainee_id = $1`,
        [traineeId, String(minutesAgo)],
      );
    }

    it('is on 1 minute after a heartbeat and off after 4', async () => {
      const h = setup();
      const mgr = await manager(h);
      const who = await staff(h);

      await setLastSeen(who.me.id, 1);
      const live = rowFor(await roster(h, mgr), who.me.id);
      expect(live.onlineNow).toBe(true);
      expect(live.lastSeenAt).not.toBeNull();
      expect((await roster(h, mgr)).counts.onlineNow).toBeGreaterThanOrEqual(1);

      await setLastSeen(who.me.id, 4);
      expect(rowFor(await roster(h, mgr), who.me.id).onlineNow).toBe(false);

      // And a revoked session never counts, however fresh it looks.
      await setLastSeen(who.me.id, 1);
      await db.pool.query('UPDATE academy.sessions SET revoked = TRUE WHERE trainee_id = $1', [
        who.me.id,
      ]);
      expect(rowFor(await roster(h, mgr), who.me.id).onlineNow).toBe(false);
    });
  });

  // ---- Checklist: the stuck panel ----------------------------------------

  describe('the stuck list', () => {
    /** A trainee row with no session and no activity, started `days` ago. */
    async function silentTrainee(name: string, days: number): Promise<number> {
      const { rows } = await db.pool.query<{ id: string }>(
        `INSERT INTO academy.trainees (full_name, email, track, started_at)
         VALUES ($1, $2, 'CS', now() - ($3 || ' days')::interval)
         RETURNING id`,
        [name, `silent-${name.replace(/\W+/g, '')}.${db.tag}@example.com`, String(days)],
      );
      return Number(rows[0]!.id);
    }

    it.skipIf(!seeded)(
      'flags 3 fails on one stage and 7 days of silence, not the healthy',
      async () => {
        const h = setup();
        const mgr = await manager(h);
        const failing = await staff(h);
        const healthy = await staff(h);
        await assignTrack(h, mgr, failing.me.id, 'CS');
        await assignTrack(h, mgr, healthy.me.id, 'CS');

        const first = expectedFor('CS')[0]!;
        // Three failed attempts on a stage that is not passed. Written with SQL:
        // what is under test is the view's rule, not the grader (S04 covers that).
        await db.pool.query(
          `INSERT INTO academy.quiz_attempts
              (trainee_id, quiz_id, attempt_number, score_pct, passed, started_at, submitted_at)
         SELECT $1, z.id, g.n, 20, FALSE, now(), now()
           FROM academy.quizzes z
           JOIN academy.stages s ON s.id = z.stage_id
           CROSS JOIN generate_series(1, 3) AS g(n)
          WHERE s.code = $2`,
          [failing.me.id, first],
        );
        await passStage(h, healthy, first);

        const silentId = await silentTrainee('Quiet Starter', 10);
        const almostSilentId = await silentTrainee('Recent Starter', 2);

        const res = await get(h, '/api/manager/stuck', mgr.cookie);
        expect(res.status).toBe(200);
        const list = (res.body as StuckResponse).trainees;
        const byId = new Map(list.map((t) => [t.id, t]));

        expect(byId.get(failing.me.id)).toMatchObject({
          reason: 'repeated_fails',
          stuckStageCode: first,
          stageFails: 3,
        });
        expect(byId.get(silentId)).toMatchObject({ reason: 'inactive', stuckStageCode: null });
        expect(byId.get(silentId)?.inactiveDays).toBeGreaterThanOrEqual(7);
        expect(byId.get(silentId)?.lastActivityAt).toBeNull();

        expect(byId.has(healthy.me.id)).toBe(false);
        expect(byId.has(almostSilentId)).toBe(false);

        // A disabled account drops off the list: it is not a coaching problem.
        expect(
          (await post(h, `/api/manager/trainees/${failing.me.id}/disable`, mgr.cookie)).status,
        ).toBe(204);
        const after = (await get(h, '/api/manager/stuck', mgr.cookie)).body as StuckResponse;
        expect(after.trainees.some((t) => t.id === failing.me.id)).toBe(false);
      },
    );
  });

  // ---- Checklist: track reassignment changes the visible stage list -------

  describe('track reassignment', () => {
    it.skipIf(!seeded)('CS → ADMIN: the trainee now sees core + Admin only', async () => {
      const h = setup();
      const mgr = await manager(h);
      const who = await staff(h);

      await assignTrack(h, mgr, who.me.id, 'CS');
      const asCs = (await get(h, `/api/manager/trainee/${who.me.id}`, mgr.cookie))
        .body as TraineeDetail;
      expect(asCs.stages.map((s) => s.code)).toEqual(expectedFor('CS'));

      await assignTrack(h, mgr, who.me.id, 'ADMIN');
      const asAdmin = (await get(h, `/api/manager/trainee/${who.me.id}`, mgr.cookie))
        .body as TraineeDetail;
      expect(asAdmin.stages.map((s) => s.code)).toEqual(expectedFor('ADMIN'));
      expect(asAdmin.stages.map((s) => s.code)).not.toEqual(asCs.stages.map((s) => s.code));
      expect(asAdmin.trainee.track).toBe('ADMIN');

      // The trainee's own view agrees: one rule, one source.
      const own = await get(h, '/api/track', who.cookie);
      expect((own.body as { stages: { code: string }[] }).stages.map((s) => s.code)).toEqual(
        expectedFor('ADMIN'),
      );

      const audit = await auditRows(db.pool, {
        traineeId: who.me.id,
        eventType: 'TRACK_ASSIGNED',
      });
      expect(audit.at(-1)).toMatchObject({
        actor: `manager:${mgr.me.id}`,
        payload: { from: 'CS', to: 'ADMIN' },
      });
    });

    it('an unknown trainee is 404 and rubbish is 400', async () => {
      const h = setup();
      const mgr = await manager(h);
      expect((await get(h, '/api/manager/trainee/999999999999', mgr.cookie)).status).toBe(404);
      expect((await get(h, '/api/manager/trainee/not-a-number', mgr.cookie)).status).toBe(400);
    });
  });

  // ---- Checklist: a track can be taken away again (the manager gap) --------

  describe('taking a track away', () => {
    /** Every progress row this trainee owns, by table. Progress is per STAGE. */
    async function progressCounts(traineeId: number) {
      const counts: Record<string, number> = {};
      for (const table of [
        'lesson_progress',
        'quiz_attempts',
        'stage_completions',
        'level_completions',
      ]) {
        const { rows } = await db.pool.query<{ n: string }>(
          `SELECT count(*)::text AS n FROM academy.${table} WHERE trainee_id = $1`,
          [traineeId],
        );
        counts[table] = Number(rows[0]!.n);
      }
      return counts;
    }

    it('null clears the column and is audited as TRACK_CLEARED, not an assignment', async () => {
      const h = setup();
      const mgr = await manager(h);
      const who = await staff(h);

      await assignTrack(h, mgr, who.me.id, 'CS');
      await assignTrack(h, mgr, who.me.id, null);

      expect(rowFor(await roster(h, mgr), who.me.id)).toMatchObject({
        track: null,
        stagesTotal: 0,
        stagesDone: 0,
        currentStageCode: null,
      });

      const cleared = await auditRows(db.pool, {
        traineeId: who.me.id,
        eventType: 'TRACK_CLEARED',
      });
      expect(cleared).toHaveLength(1);
      expect(cleared[0]).toMatchObject({ actor: `manager:${mgr.me.id}`, payload: { from: 'CS' } });
      // An honest trail: the clear is NOT a TRACK_ASSIGNED with a null in it.
      expect(cleared[0]!.payload).not.toHaveProperty('to');
      const assigned = await auditRows(db.pool, {
        traineeId: who.me.id,
        eventType: 'TRACK_ASSIGNED',
      });
      expect(assigned.every((row) => row.payload.to !== null)).toBe(true);
    });

    it('the trainee falls back to the waiting screen, and their own view agrees', async () => {
      const h = setup();
      const mgr = await manager(h);
      const who = await staff(h);

      await assignTrack(h, mgr, who.me.id, 'CS');
      await assignTrack(h, mgr, who.me.id, null);

      const own = await get(h, '/api/track', who.cookie);
      expect(own.status).toBe(200);
      expect(own.body).toMatchObject({ track: null, waitingForTrack: true, stages: [] });
    });

    it.skipIf(!seeded)('keeps every progress row across clear → re-assign', async () => {
      const h = setup();
      const mgr = await manager(h);
      const who = await staff(h);
      const expected = expectedFor('CS');

      await assignTrack(h, mgr, who.me.id, 'CS');
      await passStage(h, who, expected[0]!);

      const before = await progressCounts(who.me.id);
      expect(before.lesson_progress).toBeGreaterThan(0);
      expect(before.quiz_attempts).toBeGreaterThan(0);
      expect(before.stage_completions).toBeGreaterThan(0);

      await assignTrack(h, mgr, who.me.id, null);

      // Nothing was deleted: the rows are keyed to the stage, not to the track.
      expect(await progressCounts(who.me.id)).toEqual(before);
      // They just cannot see any stages while they have no programme.
      const whileWaiting = (await get(h, `/api/manager/trainee/${who.me.id}`, mgr.cookie))
        .body as TraineeDetail;
      expect(whileWaiting.stages).toEqual([]);
      expect(whileWaiting.trainee.stagesDone).toBe(0);

      await assignTrack(h, mgr, who.me.id, 'CS');

      expect(await progressCounts(who.me.id)).toEqual(before);
      const back = rowFor(await roster(h, mgr), who.me.id);
      expect(back.stagesTotal).toBe(expected.length);
      expect(back.stagesDone).toBe(1);
      expect(back.attempts).toBe(1);
      expect(back.bestAverage).toBe(100);
      expect(back.currentStageCode).toBe(expected[1]);
      expect(back.stages[0]).toMatchObject({ code: expected[0], passed: true, best: 100 });

      // ...and the completed stage still reads "done" on the detail screen.
      const detail = (await get(h, `/api/manager/trainee/${who.me.id}`, mgr.cookie))
        .body as TraineeDetail;
      expect(detail.stages.find((s) => s.code === expected[0])?.state).toBe('done');
    });

    it('a missing or nonsense track is 400, and an unknown trainee is still 404', async () => {
      const h = setup();
      const mgr = await manager(h);
      const who = await staff(h);

      // A client that forgets the field must not clear a programme by accident.
      for (const body of [{}, { track: 'NOPE' }, { track: '' }, { track: 7 }]) {
        const res = await putTrack(h, mgr, who.me.id, body);
        expect([JSON.stringify(body), res.status]).toEqual([JSON.stringify(body), 400]);
        expect(res.body).toEqual({ error: 'invalid_request' });
      }
      expect(rowFor(await roster(h, mgr), who.me.id).track).toBeNull();

      const missing = await putTrack(h, mgr, 999999999999, { track: null });
      expect(missing.status).toBe(404);
      expect(missing.body).toEqual({ error: 'not_found' });
      expect((await putTrack(h, mgr, 'not-a-number', { track: null })).status).toBe(400);
    });

    it('a staff session cannot take anybody’s track away', async () => {
      const h = setup();
      const mgr = await manager(h);
      const who = await staff(h);
      const other = await staff(h);
      await assignTrack(h, mgr, other.me.id, 'CS');

      const res = await putTrack(h, who, other.me.id, { track: null });
      expect(res.status).toBe(403);
      expect(res.body).toEqual({ error: 'forbidden' });
      expect(rowFor(await roster(h, mgr), other.me.id).track).toBe('CS');
    });
  });

  // ---- Checklist: the CSV export -----------------------------------------

  describe('the CSV export', () => {
    /** The file starts with a UTF-8 BOM so Excel reads accents correctly. */
    function stripBom(text: string): string {
      expect(text.startsWith(BOM)).toBe(true);
      return text.slice(BOM.length);
    }

    function parseCsv(text: string): string[][] {
      // Enough of RFC 4180 to check what we wrote: quoted fields with doubled
      // quotes, commas and newlines inside them.
      const rows: string[][] = [];
      let row: string[] = [];
      let cell = '';
      let quoted = false;
      for (let i = 0; i < text.length; i++) {
        const c = text[i]!;
        if (quoted) {
          if (c === '"' && text[i + 1] === '"') {
            cell += '"';
            i++;
          } else if (c === '"') quoted = false;
          else cell += c;
          continue;
        }
        if (c === '"') quoted = true;
        else if (c === ',') {
          row.push(cell);
          cell = '';
        } else if (c === '\r') continue;
        else if (c === '\n') {
          row.push(cell);
          rows.push(row);
          row = [];
          cell = '';
        } else cell += c;
      }
      if (cell !== '' || row.length > 0) {
        row.push(cell);
        rows.push(row);
      }
      return rows;
    }

    it('one header, one row per trainee, escaped, and audited', async () => {
      const h = setup();
      const mgr = await manager(h);
      const nasty = await staff(h, { fullName: `=cmd|' /C calc'!A0 ${db.tag}` });
      const comma = await staff(h, { fullName: `O'Hara, "Ann"\nSecond ${db.tag}` });
      await assignTrack(h, mgr, nasty.me.id, 'CS');

      const res = await get(h, onlyMine('/api/manager/export.csv'), mgr.cookie);
      expect(res.status).toBe(200);
      expect(res.headers['content-type']).toMatch(/text\/csv/);
      expect(res.headers['content-disposition']).toMatch(
        /^attachment; filename="academy-roster-\d{4}-\d{2}-\d{2}\.csv"$/,
      );
      // A download of trainee-supplied text: the browser must not be free to
      // decide the body is something other than what we said it is.
      expect(res.headers['x-content-type-options']).toBe('nosniff');

      const text = stripBom(res.text);
      const rows = parseCsv(text);
      const header = rows[0]!;
      expect(header[0]).toBe('id');
      expect(header).toContain('full_name');
      expect(header).toContain('per_stage');

      const expectedRows = (await roster(h, mgr)).trainees;
      expect(rows.length - 1).toBe(expectedRows.length);
      expect(new Set(rows.slice(1).map((r) => r[0]))).toEqual(
        new Set(expectedRows.map((t) => String(t.id))),
      );

      const nameCol = header.indexOf('full_name');
      const nastyRow = rows.find((r) => r[0] === String(nasty.me.id))!;
      // Neutralised: a spreadsheet must not run this as a formula.
      expect(nastyRow[nameCol]!.startsWith('=')).toBe(false);
      expect(nastyRow[nameCol]).toBe(`'=cmd|' /C calc'!A0 ${db.tag}`);
      // ...and the raw file quotes it rather than leaving a bare quote in place.
      expect(text).not.toContain(`\n=cmd`);

      const commaRow = rows.find((r) => r[0] === String(comma.me.id))!;
      expect(commaRow[nameCol]).toBe(`O'Hara, "Ann"\nSecond ${db.tag}`);

      // Per-stage stats: one cell, in the trainee's own unlock order.
      const perStage = nastyRow[header.indexOf('per_stage')]!;
      if (seeded) {
        expect(perStage.split(';').map((c) => c.split(':')[0])).toEqual(expectedFor('CS'));
      }

      const exported = await auditRows(db.pool, { eventType: 'EXPORT_CSV' });
      const last = exported.at(-1)!;
      expect(last.actor).toBe(`manager:${mgr.me.id}`);
      expect(last.payload.rows).toBe(expectedRows.length);
      // The audit row says WHICH filters were used, never what was typed into
      // the search box: that is a colleague's name going into an append-only,
      // manager-readable, CSV-exportable table. The scrubber has to reach it
      // where it lives, one level down inside `filters`.
      expect(last.payload.filters).toMatchObject({ q: '[redacted]' });
      expect(JSON.stringify(last.payload)).not.toContain(db.tag);
    });

    it('stops a manager exporting in a loop', async () => {
      const h = setup();
      const mgr = await manager(h);
      let rateLimited = false;
      for (let i = 0; i < 8 && !rateLimited; i++) {
        const res = await get(h, onlyMine('/api/manager/export.csv'), mgr.cookie);
        if (res.status === 429) {
          expect(res.body).toEqual({ error: 'rate_limited' });
          rateLimited = true;
        }
      }
      expect(rateLimited).toBe(true);
    });
  });

  // ---- Checklist: preview as track ---------------------------------------

  describe('preview as track', () => {
    it.skipIf(!seeded)("returns each track's stage list and no content", async () => {
      const h = setup();
      const mgr = await manager(h);

      for (const track of TRACK_CODES) {
        const res = await get(h, `/api/manager/preview/${track}`, mgr.cookie);
        expect([track, res.status]).toEqual([track, 200]);
        const body = res.body as PreviewTrackResponse;
        expect(body.track).toBe(track);
        expect(body.stages.map((s) => s.code)).toEqual(expectedFor(track));
        expect(body.stages.map((s) => s.position)).toEqual(body.stages.map((_s, i) => i + 1));
        for (const stage of body.stages) {
          expect(stage.passMark).toBeGreaterThan(0);
          expect(stage.lessonCount).toBeGreaterThanOrEqual(0);
        }

        // Nothing that could leak the training itself.
        const raw = JSON.stringify(body);
        expect(raw).not.toContain('correct');
        expect(raw).not.toContain('bodyHtml');
        expect(raw).not.toMatch(/<\/?(p|div|ul|h[1-6])[\s>]/i);
      }
    });

    it('writes nothing for anybody and refuses an unknown track', async () => {
      const h = setup();
      const mgr = await manager(h);

      const before = await db.pool.query<{ n: string }>(
        `SELECT (SELECT count(*) FROM academy.lesson_progress)
              + (SELECT count(*) FROM academy.quiz_attempts)
              + (SELECT count(*) FROM academy.stage_completions)
              + (SELECT count(*) FROM academy.listen_progress) AS n`,
      );
      expect((await get(h, '/api/manager/preview/FULL', mgr.cookie)).status).toBe(200);
      const after = await db.pool.query<{ n: string }>(
        `SELECT (SELECT count(*) FROM academy.lesson_progress)
              + (SELECT count(*) FROM academy.quiz_attempts)
              + (SELECT count(*) FROM academy.stage_completions)
              + (SELECT count(*) FROM academy.listen_progress) AS n`,
      );
      expect(after.rows[0]!.n).toBe(before.rows[0]!.n);

      const bad = await get(h, '/api/manager/preview/NOPE', mgr.cookie);
      expect(bad.status).toBe(404);
      expect(bad.body).toEqual({ error: 'not_found' });

      const audit = await auditRows(db.pool, { eventType: 'MANAGER_PREVIEW' });
      expect(audit.at(-1)).toMatchObject({
        actor: `manager:${mgr.me.id}`,
        payload: { track: 'FULL' },
      });
    });
  });

  // ---- Checklist: the gate switch is surfaced, not editable ---------------

  describe('the config view', () => {
    it('reports the flags and cannot change them', async () => {
      const h = setup({ stage1AuthRequired: true });
      const mgr = await manager(h);
      const res = await get(h, '/api/manager/config', mgr.cookie);
      expect(res.status).toBe(200);
      expect(res.body as ManagerConfig).toEqual({
        stage1AuthRequired: true,
        academyV2: true,
        provisioning: false,
      });

      // Read-only: there is no writing verb on this path.
      expect(
        (await post(h, '/api/manager/config', mgr.cookie, { stage1AuthRequired: false })).status,
      ).toBe(404);
      const put = await request(h.app)
        .put('/api/manager/config')
        .set('Cookie', mgr.cookie)
        .send({ stage1AuthRequired: false });
      expect(put.status).toBe(404);

      const off = setup({ stage1AuthRequired: false });
      const mgr2 = await manager(off);
      expect(
        ((await get(off, '/api/manager/config', mgr2.cookie)).body as ManagerConfig)
          .stage1AuthRequired,
      ).toBe(false);
    });
  });

  // ---- Checklist: every manager read and action is audited ----------------

  describe('auditing', () => {
    it('one summary row per dashboard load, one row per action', async () => {
      const h = setup();
      const mgr = await manager(h);
      const who = await staff(h);

      const before = (await auditRows(db.pool, { eventType: 'MANAGER_VIEW' })).length;
      const list = await roster(h, mgr);
      await get(h, '/api/manager/stuck', mgr.cookie);
      const views = await auditRows(db.pool, { eventType: 'MANAGER_VIEW' });
      // One row for the roster and one for the stuck panel — never one per trainee.
      expect(views.length).toBe(before + 2);
      const summary = views.at(-2)!;
      expect(summary.actor).toBe(`manager:${mgr.me.id}`);
      expect(summary.payload.view).toBe('roster');
      expect((summary.payload.counts as { total: number }).total).toBe(list.trainees.length);

      await post(h, `/api/manager/trainees/${who.me.id}/disable`, mgr.cookie);
      await post(h, `/api/manager/trainees/${who.me.id}/enable`, mgr.cookie);
      const actions = await auditRows(db.pool, { traineeId: who.me.id });
      const types = actions.map((a) => a.event_type);
      expect(types).toContain('ACCOUNT_DISABLED');
      expect(types).toContain('ACCOUNT_ENABLED');
      for (const row of actions.filter((a) => a.event_type.startsWith('ACCOUNT_'))) {
        expect(row.actor).toBe(`manager:${mgr.me.id}`);
      }

      // Opening one trainee is audited against that trainee.
      await get(h, `/api/manager/trainee/${who.me.id}`, mgr.cookie);
      const opened = await auditRows(db.pool, {
        traineeId: who.me.id,
        eventType: 'MANAGER_VIEW',
      });
      expect(opened.at(-1)?.payload.view).toBe('trainee');
    });
  });
});
