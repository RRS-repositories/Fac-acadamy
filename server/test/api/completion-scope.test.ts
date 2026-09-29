import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { parseEnv } from 'node:util';
import express from 'express';
import type { Express } from 'express';
import pg from 'pg';
import request from 'supertest';
import { afterAll, describe, expect, it } from 'vitest';
import { certVerifyApiPath } from '@fac-academy/shared';
import type { TrackCode } from '@fac-academy/shared';
import { createCertificateIssuer } from '../../src/certs/issue.js';
import { certVerifyRouter } from '../../src/certs/verify.routes.js';
import { issueCertificatesForPass } from '../../src/certs/onPass.js';
import { pgConfig } from '../../src/db/connection.js';
import { applyMigrations, settingsFromEnv } from '../../src/db/migrate.js';
import { createLocalMediaStore } from '../../src/media/store.js';
import { recordStagePass } from '../../src/modules/training/completions.js';
import { buildTrack } from '../../src/modules/training/track.js';
import { createInMemoryQueue, createProducers } from '../../src/queues/index.js';

// Migration 0013: an academy that GROWS after people have finished it.
//
// The story this proves, end to end, is the one from 29 September 2026. Admin
// went from two modules to three. Thirteen people had already completed it and
// hold certificates. Before 0013 their screen recomputed to "2 of 3", and
// doing the new module wrote nothing and earned nothing, because
// completeDeptIfDone ran ON CONFLICT DO NOTHING against a row that was already
// there. Now it earns a NEW certificate and the old one stays valid.
//
// Two deliberate choices about how it is tested:
//
//  * **No training content is touched, and none is invented.** The academies
//    here are synthetic: their own track, their own department code, stages
//    with no lessons, no recordings, no quizzes and no questions. Nothing in
//    this file reads, copies or creates a real lesson, question or pass mark,
//    and everything it creates is deleted again in afterAll. The real content
//    path (gate, lessons, listens, a graded quiz) is proved by quiz.test.ts and
//    certs.test.ts, which this deliberately does not repeat.
//  * **The PDF is stubbed.** Whether Chromium produces a PDF is certs.test.ts's
//    question. Here the question is which certificate rows exist, so the
//    renderer returns a few bytes and the suite stays fast.

function envWithDotenv(): NodeJS.ProcessEnv {
  const candidates = process.env.ENV_FILE
    ? [resolve(process.env.ENV_FILE)]
    : [resolve(process.cwd(), '.env'), resolve(process.cwd(), '..', '.env')];
  const file = candidates.find((f) => existsSync(f));
  const fromFile = file ? parseEnv(readFileSync(file, 'utf8')) : {};
  return { ...fromFile, ...process.env };
}

const env = envWithDotenv();
const TEST_DB = env.MIGRATION_TEST_DB_NAME?.trim() ?? '';
const quiet = (): undefined => undefined;

/**
 * The synthetic academies. A department's code is a FOREIGN KEY to
 * academy.tracks (migration 0002), so each one is a track as well — which is
 * exactly what keeps this test off the seeded tracks: nothing it adds is ever
 * visible to a real trainee, and no other suite's track_visibility moves.
 *
 * 'A' grows, 'B' stays still, 'U' has an unknown recorded scope, 'L' is the
 * level twin of 'A'.
 */
const ACADEMIES = ['ZSCOPEA', 'ZSCOPEB', 'ZSCOPEU', 'ZSCOPEL'] as const;
type Academy = (typeof ACADEMIES)[number];

interface Harness {
  pool: pg.Pool;
  app: Express;
  issuer: ReturnType<typeof createCertificateIssuer>;
  producers: ReturnType<typeof createProducers>;
  mediaRoot: string;
  tag: string;
}

let h: Harness | null = null;
let ready = false;
const traineeIds: number[] = [];
const stageIds: number[] = [];

/** A stand-in for the real renderer: this suite is about rows, not Chromium. */
const stubPdf = (): Promise<Buffer> => Promise.resolve(Buffer.from('%PDF-1.4 stub\n'));

if (TEST_DB === '') {
  console.warn(
    '[completion-scope.test] MIGRATION_TEST_DB_NAME is not set: skipping the scope tests.',
  );
} else {
  try {
    const settings = { ...settingsFromEnv(env), DB_NAME: TEST_DB };
    await applyMigrations({ commit: true, expectDb: TEST_DB, settings, log: quiet });
    const pool = new pg.Pool(pgConfig(settings, { applicationName: 'academy-scope-test', max: 6 }));
    const mediaRoot = await mkdtemp(join(tmpdir(), 'academy-scope-'));
    const issuer = createCertificateIssuer({
      db: pool,
      store: createLocalMediaStore(mediaRoot),
      publicBaseUrl: 'https://academy.example.com',
      render: stubPdf,
    });
    const app = express();
    app.set('trust proxy', 'loopback');
    // The PUBLIC verify route, mounted exactly as app.ts mounts it.
    app.use('/api', certVerifyRouter({ db: pool, redis: null, limitPerMinute: 1000 }));

    h = {
      pool,
      app,
      issuer,
      producers: createProducers(createInMemoryQueue()),
      mediaRoot,
      tag: randomBytes(4).toString('hex'),
    };
    await buildAcademies(pool);
    ready = true;
  } catch (err) {
    console.warn(`[completion-scope.test] test database unavailable: ${(err as Error).message}`);
  }
}

function need(): Harness {
  if (h === null) throw new Error('no test harness');
  return h;
}

/**
 * Create the synthetic tracks, departments and starting stages.
 *
 * Every academy starts with two modules, which is the world the thirteen
 * people finished in. ZSCOPEL is the level twin: its stages hang off level 1
 * at positions nothing else uses, so academy.stages' UNIQUE (level_id,
 * position) cannot collide with the seeded content.
 */
async function buildAcademies(pool: pg.Pool): Promise<void> {
  let sort = 900;
  for (const code of ACADEMIES) {
    await pool.query(
      `INSERT INTO academy.tracks (code, label, sort, is_active)
       VALUES ($1, $1, $2, false) ON CONFLICT (code) DO NOTHING`,
      [code, sort],
    );
    await pool.query(
      `INSERT INTO academy.departments (code, label, sort, academy_name)
       VALUES ($1, $1, $2, $1) ON CONFLICT (code) DO NOTHING`,
      [code, sort],
    );
    sort += 1;
  }
  for (const code of ACADEMIES) {
    await addModule(pool, code, 1);
    await addModule(pool, code, 2);
  }
}

/**
 * Add one module to an academy and make it visible to its track, at the end of
 * the unlock order. Returns the new stage id.
 *
 * This is the whole of "the academy grew": one stage, one visibility row.
 */
async function addModule(pool: pg.Pool, academy: Academy, n: number): Promise<number> {
  const level = academy === 'ZSCOPEL';
  const code = `${academy.toLowerCase()}${String(n)}`;
  const { rows } = await pool.query<{ id: string }>(
    `INSERT INTO academy.stages (code, title, position, track, level_id, dept, display_num)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     ON CONFLICT (code) DO UPDATE SET title = EXCLUDED.title
     RETURNING id`,
    [
      code,
      `Scope test module ${String(n)}`,
      90 + n,
      academy,
      level ? 1 : null,
      level ? null : academy,
      String(n),
    ],
  );
  const id = Number(rows[0]!.id);
  stageIds.push(id);
  // No ON CONFLICT here: track_visibility's (track_code, position) key is
  // DEFERRABLE, and Postgres will not use a deferrable constraint as an
  // ON CONFLICT arbiter. Nothing re-adds the same module anyway.
  await pool.query(
    `INSERT INTO academy.track_visibility (track_code, stage_id, position)
     VALUES ($1, $2, $3)`,
    [academy, id, n],
  );
  return id;
}

let seq = 0;

async function newTrainee(track: Academy): Promise<number> {
  seq++;
  const { rows } = await need().pool.query<{ id: string }>(
    `INSERT INTO academy.trainees (full_name, email, track)
     VALUES ($1, $2, $3) RETURNING id`,
    [`Scope Tester ${String(seq)}`, `scope${String(seq)}.${need().tag}@example.com`, track],
  );
  const id = Number(rows[0]!.id);
  traineeIds.push(id);
  return id;
}

async function stageIdOf(code: string): Promise<number> {
  const { rows } = await need().pool.query<{ id: string }>(
    'SELECT id FROM academy.stages WHERE code = $1',
    [code],
  );
  return Number(rows[0]!.id);
}

/**
 * Pass one module, exactly the way the quiz route does it: the completion
 * writes inside one transaction, then — after the commit — whatever that
 * completed is issued and queued.
 */
async function pass(
  traineeId: number,
  academy: Academy,
  moduleNumber: number,
): Promise<Awaited<ReturnType<typeof recordStagePass>>> {
  const stageId = await stageIdOf(`${academy.toLowerCase()}${String(moduleNumber)}`);
  const level = academy === 'ZSCOPEL';
  const client = await need().pool.connect();
  let outcome;
  try {
    await client.query('BEGIN');
    outcome = await recordStagePass(client, {
      traineeId,
      stageId,
      track: academy as unknown as TrackCode,
      pct: 100,
      levelId: level ? 1 : null,
      dept: level ? null : academy,
    });
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }

  await issueCertificatesForPass({
    issuer: need().issuer,
    producers: need().producers,
    traineeId,
    track: academy,
    level: outcome.level,
    dept: outcome.dept?.dept ?? null,
  });
  return outcome;
}

interface CertRow {
  public_id: string;
  kind: string;
  scope_size: number | null;
  issued_at: Date;
  revoked_at: Date | null;
}

async function certsOf(traineeId: number): Promise<CertRow[]> {
  const { rows } = await need().pool.query<CertRow>(
    `SELECT public_id, kind, scope_size, issued_at, revoked_at
       FROM academy.certificates WHERE trainee_id = $1 ORDER BY id`,
    [traineeId],
  );
  return rows;
}

async function deptRow(
  traineeId: number,
  dept: string,
): Promise<{ completed_at: Date; recompleted_at: Date | null; modules_covered: number | null }> {
  const { rows } = await need().pool.query<{
    completed_at: Date;
    recompleted_at: Date | null;
    modules_covered: number | null;
  }>(
    `SELECT completed_at, recompleted_at, modules_covered
       FROM academy.dept_completions WHERE trainee_id = $1 AND dept = $2`,
    [traineeId, dept],
  );
  return rows[0]!;
}

async function verifyPublicly(publicId: string): Promise<{ valid: boolean; completed?: string }> {
  const res = await request(need().app).get(certVerifyApiPath(publicId));
  expect(res.status).toBe(200);
  return res.body as { valid: boolean; completed?: string };
}

afterAll(async () => {
  if (h === null) return;
  const { pool } = h;
  for (const sql of [
    'DELETE FROM academy.certificate_emails WHERE certificate_id IN (SELECT id FROM academy.certificates WHERE trainee_id = ANY($1::bigint[]))',
    'DELETE FROM academy.certificates WHERE trainee_id = ANY($1::bigint[])',
    'DELETE FROM academy.stage_completions WHERE trainee_id = ANY($1::bigint[])',
    'DELETE FROM academy.level_completions WHERE trainee_id = ANY($1::bigint[])',
    'DELETE FROM academy.dept_completions WHERE trainee_id = ANY($1::bigint[])',
    'DELETE FROM academy.audit_events WHERE trainee_id = ANY($1::bigint[])',
    'DELETE FROM academy.notifications_sent WHERE trainee_id = ANY($1::bigint[])',
    'DELETE FROM academy.trainees WHERE id = ANY($1::bigint[])',
  ]) {
    await pool.query(sql, [traineeIds]);
  }
  // The synthetic content goes too: nothing this suite invented may outlive it
  // in a shared database.
  await pool.query('DELETE FROM academy.track_visibility WHERE stage_id = ANY($1::bigint[])', [
    stageIds,
  ]);
  await pool.query('DELETE FROM academy.stages WHERE id = ANY($1::bigint[])', [stageIds]);
  await pool.query('DELETE FROM academy.departments WHERE code = ANY($1::text[])', [
    [...ACADEMIES],
  ]);
  await pool.query('DELETE FROM academy.tracks WHERE code = ANY($1::text[])', [[...ACADEMIES]]);
  await pool.end();
  await rm(h.mediaRoot, { recursive: true, force: true });
}, 60_000);

const describeDb = ready ? describe : describe.skip;

// ---------------------------------------------------------------------------

describeDb('an academy that grows after it has been completed', () => {
  it('records what a first completion covered, and issues one certificate for it', async () => {
    const trainee = await newTrainee('ZSCOPEB');

    expect((await pass(trainee, 'ZSCOPEB', 1)).dept).toBeNull();
    const finished = (await pass(trainee, 'ZSCOPEB', 2)).dept;

    expect(finished).toEqual({ dept: 'ZSCOPEB', modulesCovered: 2, afterGrowth: false });

    const row = await deptRow(trainee, 'ZSCOPEB');
    expect(row.modules_covered).toBe(2);
    expect(row.recompleted_at).toBeNull();

    const certs = await certsOf(trainee);
    expect(certs).toHaveLength(1);
    expect(certs[0]!.kind).toBe('DEPT');
    expect(certs[0]!.scope_size).toBe(2);
  });

  it('issues a NEW certificate when the academy has grown, and leaves the old one valid', async () => {
    const trainee = await newTrainee('ZSCOPEA');
    await pass(trainee, 'ZSCOPEA', 1);
    await pass(trainee, 'ZSCOPEA', 2);

    const before = await certsOf(trainee);
    expect(before).toHaveLength(1);
    const old = before[0]!;
    expect(old.scope_size).toBe(2);
    expect((await verifyPublicly(old.public_id)).valid).toBe(true);

    const firstCompletedAt = (await deptRow(trainee, 'ZSCOPEA')).completed_at;

    // The academy grows.
    await addModule(need().pool, 'ZSCOPEA', 3);

    const again = (await pass(trainee, 'ZSCOPEA', 3)).dept;
    expect(again).toEqual({ dept: 'ZSCOPEA', modulesCovered: 3, afterGrowth: true });

    // A second certificate, for the bigger academy.
    const after = await certsOf(trainee);
    expect(after).toHaveLength(2);
    expect(after.map((c) => c.scope_size)).toEqual([2, 3]);
    expect(after[1]!.public_id).not.toBe(old.public_id);

    // The one they already held is untouched and still verifies publicly.
    expect(after[0]!.public_id).toBe(old.public_id);
    expect(after[0]!.issued_at.getTime()).toBe(old.issued_at.getTime());
    expect(after[0]!.revoked_at).toBeNull();
    expect((await verifyPublicly(old.public_id)).valid).toBe(true);
    expect((await verifyPublicly(after[1]!.public_id)).valid).toBe(true);

    // The completion row records the new scope without rewriting when they
    // first finished.
    const row = await deptRow(trainee, 'ZSCOPEA');
    expect(row.modules_covered).toBe(3);
    expect(row.completed_at.getTime()).toBe(firstCompletedAt.getTime());
    expect(row.recompleted_at).not.toBeNull();

    // The completion row points at the CURRENT certificate.
    const { rows } = await need().pool.query<{ certificate_ref: string | null }>(
      'SELECT certificate_ref FROM academy.dept_completions WHERE trainee_id = $1 AND dept = $2',
      [trainee, 'ZSCOPEA'],
    );
    expect(rows[0]!.certificate_ref).toBe(after[1]!.public_id);

    // And passing the new module a second time adds nothing at all: the
    // recorded scope is already 3, so there is no growth left to certify.
    expect((await pass(trainee, 'ZSCOPEA', 3)).dept).toBeNull();
    expect((await pass(trainee, 'ZSCOPEA', 1)).dept).toBeNull();
    expect(await certsOf(trainee)).toEqual(after);
  });

  it('mints nothing further when the same module is passed again', async () => {
    const trainee = await newTrainee('ZSCOPEB');
    await pass(trainee, 'ZSCOPEB', 1);
    await pass(trainee, 'ZSCOPEB', 2);
    const after = await certsOf(trainee);
    expect(after).toHaveLength(1);
    expect(after[0]!.scope_size).toBe(2);

    // Three retakes, including the one that completed it in the first place.
    for (const module of [2, 1, 2]) {
      expect((await pass(trainee, 'ZSCOPEB', module)).dept).toBeNull();
    }
    expect(await certsOf(trainee)).toEqual(after);
  });

  it('does nothing on a completion whose recorded scope is unknown', async () => {
    // A row as it looked before 0013, and as it stays when the backfill could
    // find nothing truthful to put in the column. We must not guess: guessing
    // either strands them or mints a certificate for work we cannot see.
    const trainee = await newTrainee('ZSCOPEU');
    await pass(trainee, 'ZSCOPEU', 1);
    await pass(trainee, 'ZSCOPEU', 2);
    await need().pool.query(
      `UPDATE academy.dept_completions SET modules_covered = NULL
        WHERE trainee_id = $1 AND dept = 'ZSCOPEU'`,
      [trainee],
    );
    const before = await certsOf(trainee);
    expect(before).toHaveLength(1);

    await addModule(need().pool, 'ZSCOPEU', 3);
    expect((await pass(trainee, 'ZSCOPEU', 3)).dept).toBeNull();

    expect(await certsOf(trainee)).toHaveLength(1);
    expect((await deptRow(trainee, 'ZSCOPEU')).modules_covered).toBeNull();
  });

  it('treats a level that gains a stage exactly the same way', async () => {
    const trainee = await newTrainee('ZSCOPEL');
    await pass(trainee, 'ZSCOPEL', 1);
    const done = (await pass(trainee, 'ZSCOPEL', 2)).level;
    expect(done?.stagesCovered).toBe(2);
    expect(done?.afterGrowth).toBe(false);

    const before = await certsOf(trainee);
    expect(before).toHaveLength(1);
    expect(before[0]!.kind).toBe('LEVEL');
    expect(before[0]!.scope_size).toBe(2);

    await addModule(need().pool, 'ZSCOPEL', 3);
    const again = (await pass(trainee, 'ZSCOPEL', 3)).level;
    expect(again?.stagesCovered).toBe(3);
    expect(again?.afterGrowth).toBe(true);

    const after = await certsOf(trainee);
    expect(after).toHaveLength(2);
    expect(after.map((c) => c.scope_size)).toEqual([2, 3]);
    expect((await verifyPublicly(before[0]!.public_id)).valid).toBe(true);

    // And a retake still mints nothing.
    expect((await pass(trainee, 'ZSCOPEL', 3)).level).toBeNull();
    expect(await certsOf(trainee)).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// GET /api/track has to SAY so, or somebody who was finished just finds
// themselves at "2 of 3" with no explanation. The browser is told the answer;
// it never works it out. This runs on a real seeded track, because the whole
// point is the number the dashboard would show.
// ---------------------------------------------------------------------------
describeDb('what the dashboard is told about an academy that has grown', () => {
  async function deptHeadingFor(
    traineeId: number,
    covered: number | null,
  ): Promise<{ completedCount: number | null; currentCount: number; grownSince: boolean }> {
    await need().pool.query(
      `UPDATE academy.dept_completions SET modules_covered = $3
        WHERE trainee_id = $1 AND dept = $2`,
      [traineeId, 'ADMIN', covered],
    );
    const track = await buildTrack({ db: need().pool, stage1AuthRequired: false }, traineeId);
    const heading = track.depts.find((d) => d.code === 'ADMIN');
    if (heading === undefined) throw new Error('no ADMIN heading on /api/track');
    return heading;
  }

  it('says grownSince only when the recorded scope is smaller than what is there now', async () => {
    const trainee = await newTrainee('ADMIN' as Academy);
    await need().pool.query(
      `INSERT INTO academy.dept_completions (trainee_id, dept) VALUES ($1, 'ADMIN')`,
      [trainee],
    );

    // How many modules the seeded Admin academy has today, read back rather
    // than assumed: it is the number that grew in the first place.
    const now = await deptHeadingFor(trainee, null);
    expect(now.currentCount).toBeGreaterThan(1);

    // Finished a smaller academy -> it has grown.
    const grown = await deptHeadingFor(trainee, now.currentCount - 1);
    expect(grown.completedCount).toBe(now.currentCount - 1);
    expect(grown.grownSince).toBe(true);

    // Finished the one that is there -> nothing to say.
    expect((await deptHeadingFor(trainee, now.currentCount)).grownSince).toBe(false);

    // Scope unknown -> nothing to say, because nothing can be told. The
    // dashboard must not claim it on a guess.
    const unknown = await deptHeadingFor(trainee, null);
    expect(unknown.completedCount).toBeNull();
    expect(unknown.grownSince).toBe(false);
  });
});
