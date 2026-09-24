import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { parseEnv } from 'node:util';
import cookieParser from 'cookie-parser';
import express from 'express';
import type { ErrorRequestHandler, Express } from 'express';
import pg from 'pg';
import request from 'supertest';
import type { Response } from 'supertest';
import { afterAll, describe, expect, it } from 'vitest';
import { certDownloadPath, certVerifyApiPath } from '@fac-academy/shared';
import { certsRouter } from '../../src/certs/routes.js';
import { certVerifyRouter } from '../../src/certs/verify.routes.js';
import { createCertificateIssuer } from '../../src/certs/issue.js';
import { createCertificateJobHandler } from '../../src/certs/jobs.js';
import { closeCertificateRenderer } from '../../src/certs/render.js';
import { pgConfig } from '../../src/db/connection.js';
import { applyMigrations, settingsFromEnv } from '../../src/db/migrate.js';
import { createLocalMediaStore } from '../../src/media/store.js';
import { MemorySessionStore, createSessionManager } from '../../src/modules/auth/sessions.js';
import { createQuizRouter } from '../../src/modules/training/quiz.routes.js';
import { QUEUE_NAMES, createInMemoryQueue, createProducers } from '../../src/queues/index.js';
import type { InMemoryJobQueue } from '../../src/queues/index.js';
import { isSeeded } from './helpers/quizHarness.js';

// S09 certificates, against the seeded local test database and a throw-away
// MEDIA_ROOT under the OS temp folder.
//
// What this suite is careful about:
//
//   * **No training content lives here.** Every stage is passed by reading the
//     correct answers back out of the database, and every assertion about
//     wording compares the API's answer with what the database holds — never
//     with a string in this file.
//   * **No real people.** Invented @example.com accounts, tagged per run.
//   * **Real PDFs.** The certificate is rendered by the real Chromium, stored
//     through the real MediaStore and read back off the disk, because "a PDF
//     was produced" is the thing S09 has to prove. The browser is closed in
//     afterAll, so no run leaves one behind.

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

/** The stub the quiz routes run behind: S03 is tested to death elsewhere. */
const TRAINEE_HEADER = 'x-test-trainee';

interface Harness {
  app: Express;
  pool: pg.Pool;
  queue: InMemoryJobQueue;
  mediaRoot: string;
  sessions: ReturnType<typeof createSessionManager>;
  issuer: ReturnType<typeof createCertificateIssuer>;
  tag: string;
}

let h: Harness | null = null;
let ready = false;
const traineeIds: number[] = [];

if (TEST_DB === '') {
  console.warn('[certs.test] MIGRATION_TEST_DB_NAME is not set: skipping the certificate tests.');
} else {
  try {
    const settings = { ...settingsFromEnv(env), DB_NAME: TEST_DB };
    await applyMigrations({ commit: true, expectDb: TEST_DB, settings, log: quiet });
    const pool = new pg.Pool(pgConfig(settings, { applicationName: 'academy-certs-test', max: 6 }));
    ready = await isSeeded(pool);
    if (!ready) {
      console.warn(
        `[certs.test] ${TEST_DB} has no seeded content: run the S02 seed into it first. Skipping.`,
      );
      await pool.end();
    } else {
      const mediaRoot = await mkdtemp(join(tmpdir(), 'academy-certs-'));
      const store = createLocalMediaStore(mediaRoot);
      const issuer = createCertificateIssuer({
        db: pool,
        store,
        publicBaseUrl: 'https://academy.example.com',
      });
      const queue = createInMemoryQueue();
      const sessions = createSessionManager({ db: pool, store: new MemorySessionStore() });

      const app = express();
      app.set('trust proxy', 'loopback');
      app.use(express.json({ limit: '100kb' }));
      app.use(cookieParser());

      // The PUBLIC verify route, mounted first — exactly as app.ts mounts it,
      // before anything that asks for a session.
      app.use('/api', certVerifyRouter({ db: pool, redis: null }));

      // The quiz, behind the header stub, so a pass can be driven over HTTP.
      app.use(
        '/api/stage/:code/quiz',
        (req, res, next) => {
          const header = req.header(TRAINEE_HEADER);
          if (header === undefined) {
            res.status(401).json({ error: 'not_signed_in' });
            return;
          }
          req.auth = {
            traineeId: Number(header),
            role: 'STAFF',
            sessionId: 'test-session',
            dbSessionId: 0,
          };
          next();
        },
        createQuizRouter({
          db: pool,
          stage1AuthRequired: false,
          producers: createProducers(queue),
          certificates: issuer,
        }),
      );

      // The signed-in certificate routes, with the REAL requireAuth and real
      // session cookies.
      app.use('/api', certsRouter({ db: pool, sessions, cookieSecure: false, store, issuer }));

      app.use('/api', (_req, res) => {
        res.status(404).json({ error: 'not_found' });
      });
      const onError: ErrorRequestHandler = (err: unknown, _req, res, _next) => {
        console.error('[certs.test] unhandled:', err);
        if (!res.headersSent) res.status(500).json({ error: 'internal' });
      };
      app.use(onError);

      h = {
        app,
        pool,
        queue,
        mediaRoot,
        sessions,
        issuer,
        tag: randomBytes(4).toString('hex'),
      };
    }
  } catch (err) {
    console.warn(`[certs.test] test database unavailable: ${(err as Error).message}`);
  }
}

function need(): Harness {
  if (h === null) throw new Error('no test harness');
  return h;
}

afterAll(async () => {
  // The browser first: a leaked Chromium outlives the test run.
  await closeCertificateRenderer();
  if (h === null) return;
  const { pool } = h;
  await pool.query(
    `DELETE FROM academy.certificate_emails
      WHERE certificate_id IN (SELECT id FROM academy.certificates
                                WHERE trainee_id = ANY($1::bigint[]))`,
    [traineeIds],
  );
  await pool.query(
    `DELETE FROM academy.attempt_answers
      WHERE attempt_id IN (SELECT id FROM academy.quiz_attempts
                            WHERE trainee_id = ANY($1::bigint[]))`,
    [traineeIds],
  );
  for (const table of [
    'certificates',
    'quiz_attempts',
    'lesson_progress',
    'stage_completions',
    'level_completions',
    'dept_completions',
    'audit_events',
    'sessions',
  ]) {
    await pool.query(`DELETE FROM academy.${table} WHERE trainee_id = ANY($1::bigint[])`, [
      traineeIds,
    ]);
  }
  // The trainees themselves last, and by their own primary key.
  await pool.query('DELETE FROM academy.trainees WHERE id = ANY($1::bigint[])', [traineeIds]);
  await pool.end();
  await rm(h.mediaRoot, { recursive: true, force: true });
  // Generous: closing Chromium and deleting a temp folder on a slow disk can
  // take a few seconds, and the default hook timeout is 10.
}, 120_000);

const describeDb = ready ? describe : describe.skip;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let seq = 0;

async function newTrainee(track: string | null): Promise<number> {
  seq++;
  const { rows } = await need().pool.query<{ id: string }>(
    `INSERT INTO academy.trainees (full_name, email, track)
     VALUES ($1, $2, $3) RETURNING id`,
    [`Cert Tester ${seq}`, `cert${seq}.${need().tag}@example.com`, track],
  );
  const id = Number(rows[0]!.id);
  traineeIds.push(id);
  return id;
}

async function cookieFor(traineeId: number, role: 'STAFF' | 'MANAGER'): Promise<string> {
  return `academy_sid=${await need().sessions.create(traineeId, role)}`;
}

async function stageId(code: string): Promise<number> {
  const { rows } = await need().pool.query<{ id: string }>(
    'SELECT id FROM academy.stages WHERE code = $1',
    [code],
  );
  return Number(rows[0]!.id);
}

/** Read every lesson of the stage, then answer every question correctly. */
async function passStage(traineeId: number, code: string): Promise<Response> {
  const id = await stageId(code);
  await need().pool.query(
    `INSERT INTO academy.lesson_progress (trainee_id, lesson_id)
     SELECT $1, l.id FROM academy.lessons l WHERE l.stage_id = $2
     ON CONFLICT DO NOTHING`,
    [traineeId, id],
  );
  const { rows } = await need().pool.query<{ question_id: string; option_id: string }>(
    `SELECT DISTINCT ON (q.id) q.id AS question_id, o.id AS option_id
       FROM academy.questions q
       JOIN academy.quizzes z ON z.id = q.quiz_id
       JOIN academy.question_options o ON o.question_id = q.id
      WHERE z.stage_id = $1 AND q.is_active AND q.approval_state = 'APPROVED'
        AND o.is_correct
      ORDER BY q.id, o.position`,
    [id],
  );
  const answers = rows.map((r) => ({
    questionId: Number(r.question_id),
    optionId: Number(r.option_id),
  }));
  const res = await request(need().app)
    .post(`/api/stage/${code}/quiz`)
    .set(TRAINEE_HEADER, String(traineeId))
    .send({ answers });
  if (res.status !== 200 || (res.body as { passed?: boolean }).passed !== true) {
    throw new Error(`could not pass ${code}: ${res.status} ${JSON.stringify(res.body)}`);
  }
  return res;
}

interface CertRow {
  id: string;
  public_id: string;
  kind: string;
  media_key: string | null;
  byte_size: string | null;
  checksum_sha256: string | null;
  issued_by: string;
  revoked_at: Date | null;
}

async function certsOf(traineeId: number): Promise<CertRow[]> {
  const { rows } = await need().pool.query<CertRow>(
    `SELECT id, public_id, kind, media_key, byte_size, checksum_sha256, issued_by, revoked_at
       FROM academy.certificates WHERE trainee_id = $1 ORDER BY id`,
    [traineeId],
  );
  return rows;
}

/** The ADMIN track's Level 1: this is read from the database, not assumed. */
async function level1StageCodes(track: string): Promise<string[]> {
  const { rows } = await need().pool.query<{ code: string }>(
    `SELECT s.code
       FROM academy.track_visibility v
       JOIN academy.stages s ON s.id = v.stage_id
       JOIN academy.levels l ON l.id = s.level_id
      WHERE v.track_code = $1 AND l.level_number = 1
      ORDER BY v.position`,
    [track],
  );
  return rows.map((r) => r.code);
}

// ---------------------------------------------------------------------------

describeDb('S09 certificates', () => {
  it('completing a level issues exactly one certificate with a stored PDF', async () => {
    const trainee = await newTrainee('ADMIN');
    need().queue.clear();

    const codes = await level1StageCodes('ADMIN');
    expect(codes.length).toBeGreaterThan(0);
    for (const code of codes) await passStage(trainee, code);

    const certs = await certsOf(trainee);
    expect(certs).toHaveLength(1);
    const cert = certs[0]!;
    expect(cert.kind).toBe('LEVEL');
    expect(cert.issued_by).toBe('system');
    // 18 random bytes as base64url: 24 characters, unguessable.
    expect(cert.public_id).toMatch(/^[A-Za-z0-9_-]{22,64}$/);

    // The PDF is on disk, under academy/certs/, and it really is a PDF.
    expect(cert.media_key).toBe(`academy/certs/${cert.public_id}.pdf`);
    const bytes = await readFile(join(need().mediaRoot, cert.media_key!));
    expect(bytes.subarray(0, 5).toString('latin1')).toBe('%PDF-');
    expect(Number(cert.byte_size)).toBe(bytes.byteLength);
    expect(cert.checksum_sha256).toMatch(/^[0-9a-f]{64}$/);

    // The completion row points at it (checklist 09).
    const ref = await need().pool.query<{ certificate_ref: string | null }>(
      'SELECT certificate_ref FROM academy.level_completions WHERE trainee_id = $1',
      [trainee],
    );
    expect(ref.rows[0]?.certificate_ref).toBe(cert.public_id);

    // One audit row, and one job on the certificates queue.
    const audit = await need().pool.query<{ payload: Record<string, unknown> }>(
      `SELECT payload FROM academy.audit_events
          WHERE trainee_id = $1 AND event_type = 'CERT_ISSUED'`,
      [trainee],
    );
    expect(audit.rows).toHaveLength(1);
    expect(audit.rows[0]?.payload).toMatchObject({ certificate: cert.public_id, kind: 'LEVEL' });

    const jobs = need().queue.jobsOn(QUEUE_NAMES.certificates);
    expect(jobs).toHaveLength(1);
    expect(jobs[0]?.data).toEqual({ kind: 'LEVEL', traineeId: trainee, level: 1 });
  }, 240_000);

  it('issuing twice produces one certificate and re-uses the same PDF', async () => {
    const trainee = await newTrainee('ADMIN');
    for (const code of await level1StageCodes('ADMIN')) await passStage(trainee, code);
    const [first] = await certsOf(trainee);

    const levelId = await need()
      .pool.query<{ id: number }>('SELECT id FROM academy.levels WHERE level_number = 1')
      .then((r) => Number(r.rows[0]!.id));
    const again = await need().issuer.issueForLevel({
      traineeId: trainee,
      levelId,
      track: 'ADMIN',
    });

    expect(again?.newlyIssued).toBe(false);
    expect(again?.rendered).toBe(false);
    expect(again?.certificate.publicId).toBe(first!.public_id);
    expect(await certsOf(trainee)).toHaveLength(1);
  }, 240_000);

  it('a department academy earns its own certificate, worded from the database', async () => {
    const trainee = await newTrainee('ADMIN');
    for (const code of await level1StageCodes('ADMIN')) await passStage(trainee, code);

    const { rows: modules } = await need().pool.query<{ code: string }>(
      `SELECT s.code
           FROM academy.track_visibility v
           JOIN academy.stages s ON s.id = v.stage_id
          WHERE v.track_code = 'ADMIN' AND s.dept IS NOT NULL
          ORDER BY v.position`,
    );
    for (const row of modules) await passStage(trainee, row.code);

    const certs = await certsOf(trainee);
    expect(certs.map((c) => c.kind).sort()).toEqual(['DEPT', 'LEVEL']);
    const dept = certs.find((c) => c.kind === 'DEPT')!;
    expect(existsSync(join(need().mediaRoot, dept.media_key!))).toBe(true);

    // The wording on the wire is the wording in the database — this test
    // never states what it is.
    const expected = await need().pool.query<{ academy_name: string; accomplishment: string }>(
      `SELECT academy_name, accomplishment FROM academy.departments WHERE code = 'ADMIN'`,
    );
    const cookie = await cookieFor(trainee, 'STAFF');
    const mine = await request(need().app).get('/api/certs').set('Cookie', cookie);
    expect(mine.status).toBe(200);
    const listed = (mine.body as { certificates: { publicId: string }[] }).certificates;
    expect(listed).toHaveLength(2);
    const deptPayload = listed.find((c) => c.publicId === dept.public_id) as unknown as {
      title: string;
      accomplishment: string;
      kind: string;
      downloadable: boolean;
    };
    expect(deptPayload.title).toBe(expected.rows[0]?.academy_name);
    expect(deptPayload.accomplishment).toBe(expected.rows[0]?.accomplishment);
    expect(deptPayload.downloadable).toBe(true);

    // The completion row points at it too.
    const ref = await need().pool.query<{ certificate_ref: string | null }>(
      `SELECT certificate_ref FROM academy.dept_completions
          WHERE trainee_id = $1 AND dept = 'ADMIN'`,
      [trainee],
    );
    expect(ref.rows[0]?.certificate_ref).toBe(dept.public_id);
  }, 240_000);

  describe('download', () => {
    let owner = 0;
    let publicId = '';

    it('sets it up: one trainee with one certificate', async () => {
      owner = await newTrainee('ADMIN');
      for (const code of await level1StageCodes('ADMIN')) await passStage(owner, code);
      publicId = (await certsOf(owner))[0]!.public_id;
    }, 240_000);

    it('streams the PDF to its owner as an attachment', async () => {
      const res = await request(need().app)
        .get(certDownloadPath(publicId))
        .set('Cookie', await cookieFor(owner, 'STAFF'))
        .buffer()
        .parse((r, cb) => {
          const chunks: Buffer[] = [];
          r.on('data', (c: Buffer) => chunks.push(c));
          r.on('end', () => cb(null, Buffer.concat(chunks)));
        });

      expect(res.status).toBe(200);
      expect(res.headers['content-type']).toBe('application/pdf');
      expect(res.headers['content-disposition']).toContain('attachment');
      expect(res.headers['content-disposition']).toContain(publicId);
      expect(res.headers['cache-control']).toBe('private, no-store');
      expect((res.body as Buffer).subarray(0, 5).toString('latin1')).toBe('%PDF-');

      const audit = await need().pool.query(
        `SELECT 1 FROM academy.audit_events
          WHERE trainee_id = $1 AND event_type = 'CERT_DOWNLOAD'`,
        [owner],
      );
      expect(audit.rowCount).toBe(1);
    });

    it('lets a manager download it, and refuses another trainee', async () => {
      const manager = await newTrainee('MGMT');
      const other = await newTrainee('CS');

      const asManager = await request(need().app)
        .get(certDownloadPath(publicId))
        .set('Cookie', await cookieFor(manager, 'MANAGER'));
      expect(asManager.status).toBe(200);

      const asOther = await request(need().app)
        .get(certDownloadPath(publicId))
        .set('Cookie', await cookieFor(other, 'STAFF'));
      // 404, not 403: a certificate id must not become a way of asking
      // whether a colleague passed something.
      expect(asOther.status).toBe(404);
      expect(asOther.body).toEqual({ error: 'not_found' });
    });

    it('needs a session at all', async () => {
      const res = await request(need().app).get(certDownloadPath(publicId));
      expect(res.status).toBe(401);
    });

    it('answers 404 for an id that does not exist', async () => {
      const res = await request(need().app)
        .get(certDownloadPath('AAAAAAAAAAAAAAAAAAAAAA'))
        .set('Cookie', await cookieFor(owner, 'STAFF'));
      expect(res.status).toBe(404);
    });
  });

  describe('public verification', () => {
    let owner = 0;
    let publicId = '';
    let holderName = '';

    it('sets it up: one trainee with one certificate', async () => {
      owner = await newTrainee('ADMIN');
      for (const code of await level1StageCodes('ADMIN')) await passStage(owner, code);
      publicId = (await certsOf(owner))[0]!.public_id;
      const { rows } = await need().pool.query<{ full_name: string }>(
        'SELECT full_name FROM academy.trainees WHERE id = $1',
        [owner],
      );
      holderName = rows[0]!.full_name;
    }, 240_000);

    it('verifies a real id with no session and nothing extra', async () => {
      const res = await request(need().app).get(certVerifyApiPath(publicId));
      expect(res.status).toBe(200);
      const body = res.body as Record<string, unknown>;
      expect(body.valid).toBe(true);
      expect(body.name).toBe(holderName);
      expect(body.track).toBe('ADMIN');
      expect(body.kind).toBe('LEVEL');
      expect(typeof body.completed).toBe('string');
      expect(typeof body.issuedAt).toBe('string');
      // Five facts and the flag: nothing else may ever appear here.
      expect(Object.keys(body).sort()).toEqual([
        'completed',
        'issuedAt',
        'kind',
        'name',
        'track',
        'valid',
      ]);
      expect(res.headers['cache-control']).toBe('no-store');
    });

    it('answers {valid:false} for a tampered id, in the same shape', async () => {
      const tampered = `${publicId.slice(0, -1)}${publicId.endsWith('A') ? 'B' : 'A'}`;
      const res = await request(need().app).get(certVerifyApiPath(tampered));
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ valid: false });

      // A malformed id is answered identically: not a 400, not a 404.
      const nonsense = await request(need().app).get('/api/cert/nope/verify');
      expect(nonsense.status).toBe(200);
      expect(nonsense.body).toEqual({ valid: false });
    });

    it('verifies a revoked certificate as invalid, and refuses the download', async () => {
      const revoked = await newTrainee('ADMIN');
      const levelId = await need()
        .pool.query<{ id: number }>('SELECT id FROM academy.levels WHERE level_number = 1')
        .then((r) => Number(r.rows[0]!.id));
      const issued = await need().issuer.issueForLevel({
        traineeId: revoked,
        levelId,
        track: 'ADMIN',
      });
      const id = issued!.certificate.publicId;
      await need().pool.query(
        'UPDATE academy.certificates SET revoked_at = now() WHERE public_id = $1',
        [id],
      );

      const verify = await request(need().app).get(certVerifyApiPath(id));
      expect(verify.body).toEqual({ valid: false });

      const download = await request(need().app)
        .get(certDownloadPath(id))
        .set('Cookie', await cookieFor(revoked, 'STAFF'));
      expect(download.status).toBe(404);
    }, 120_000);

    it('rate-limits to 30 a minute per address: the 31st is refused', async () => {
      const app = express();
      app.set('trust proxy', 'loopback');
      app.use('/api', certVerifyRouter({ db: need().pool, redis: null }));
      const ip = `198.51.100.${String(30 + (seq % 200))}`;

      let last: Response | null = null;
      for (let i = 0; i < 30; i++) {
        last = await request(app).get(certVerifyApiPath(publicId)).set('X-Forwarded-For', ip);
        expect(last.status).toBe(200);
      }
      const over = await request(app).get(certVerifyApiPath(publicId)).set('X-Forwarded-For', ip);
      expect(over.status).toBe(429);
      expect(over.body).toEqual({ error: 'rate_limited' });

      // The limit is per address, so a different caller is unaffected.
      const elsewhere = await request(app)
        .get(certVerifyApiPath(publicId))
        .set('X-Forwarded-For', '203.0.113.9');
      expect(elsewhere.status).toBe(200);
    }, 60_000);
  });

  it('the certificates job composes the email, records it, and sends nothing', async () => {
    const trainee = await newTrainee('ADMIN');
    const levelId = await need()
      .pool.query<{ id: number }>('SELECT id FROM academy.levels WHERE level_number = 1')
      .then((r) => Number(r.rows[0]!.id));

    const handle = createCertificateJobHandler({
      db: need().pool,
      issuer: need().issuer,
      publicBaseUrl: 'https://academy.example.com',
    });
    await handle({ kind: 'LEVEL', traineeId: trainee, level: 1 });
    // At-least-once: running it again must not compose a second email.
    await handle({ kind: 'LEVEL', traineeId: trainee, level: 1 });

    const certs = await certsOf(trainee);
    expect(certs).toHaveLength(1);
    expect(certs[0]!.media_key).not.toBeNull();
    expect(levelId).toBeGreaterThan(0);

    const { rows } = await need().pool.query<{
      subject: string;
      body_text: string;
      to_email: string;
      attachment_key: string | null;
      sent_at: Date | null;
      provider: string | null;
    }>(
      `SELECT e.subject, e.body_text, e.to_email, e.attachment_key, e.sent_at, e.provider
           FROM academy.certificate_emails e
           JOIN academy.certificates c ON c.id = e.certificate_id
          WHERE c.trainee_id = $1`,
      [trainee],
    );
    expect(rows).toHaveLength(1);
    const email = rows[0]!;
    expect(email.to_email).toContain('@example.com');
    expect(email.attachment_key).toBe(certs[0]!.media_key);
    expect(email.body_text).toContain(certs[0]!.public_id);
    // No provider has been chosen, so nothing was sent — the row is the
    // backlog, not a receipt.
    expect(email.sent_at).toBeNull();
    expect(email.provider).toBeNull();
  }, 240_000);
});
