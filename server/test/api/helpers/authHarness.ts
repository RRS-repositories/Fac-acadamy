// Test harness for the S03 sign-in routes: the real app and the real local
// test database (MIGRATION_TEST_DB_NAME), with a fake CRM, in-memory session
// stores and a controllable clock. Every account is invented (@example.com)
// and tagged per run so runs never collide; rows are removed afterwards.
import { randomBytes, randomInt } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseEnv } from 'node:util';
import pg from 'pg';
import request from 'supertest';
import type { Response } from 'supertest';
import type { Express } from 'express';
import { createApp } from '../../../src/app.js';
import type {
  CrmClient,
  CrmUser,
  CrmVerifyResult,
} from '../../../src/integrations/crm/crmClient.js';
import { pgConfig } from '../../../src/db/connection.js';
import type { DbSettings } from '../../../src/db/connection.js';
import { applyMigrations, settingsFromEnv } from '../../../src/db/migrate.js';
import type { MediaStore } from '../../../src/media/store.js';
import { createLoginLimiters } from '../../../src/modules/auth/limits.js';
import type { LoginLimitSettings } from '../../../src/modules/auth/limits.js';
import {
  MemoryPendingMfaStore,
  MemorySessionStore,
  createSessionManager,
} from '../../../src/modules/auth/sessions.js';
import { codeForStep, stepAt } from '../../../src/modules/auth/totp.js';
import type { JobQueue } from '../../../src/queues/queue.js';

function envWithDotenv(): NodeJS.ProcessEnv {
  const candidates = process.env.ENV_FILE
    ? [resolve(process.env.ENV_FILE)]
    : [resolve(process.cwd(), '.env'), resolve(process.cwd(), '..', '.env')];
  const file = candidates.find((f) => existsSync(f));
  const fromFile = file ? parseEnv(readFileSync(file, 'utf8')) : {};
  return { ...fromFile, ...process.env };
}

const env = envWithDotenv();
export const TEST_DB = env.MIGRATION_TEST_DB_NAME?.trim() || '';

/** 32 synthetic key bytes for the tests only. */
export const TEST_MFA_KEY = Buffer.alloc(32, 7);
export const PASSWORD = 'correct-horse-synthetic';

export type FakeAccount = CrmUser & { password: string };

/** A CRM stand-in. `mode` forces an outcome for every call. */
export class FakeCrm implements CrmClient {
  readonly accounts = new Map<string, FakeAccount>();
  readonly calls: { email: string; clientIp: string | undefined }[] = [];
  mode: 'normal' | 'unavailable' = 'normal';

  add(account: FakeAccount): FakeAccount {
    this.accounts.set(account.email.toLowerCase(), account);
    return account;
  }

  async verify(email: string, password: string, clientIp?: string): Promise<CrmVerifyResult> {
    this.calls.push({ email, clientIp });
    if (this.mode === 'unavailable') return { ok: false, reason: 'unavailable' };
    const a = this.accounts.get(email.toLowerCase());
    if (a === undefined || a.password !== password) {
      return { ok: false, reason: 'invalid_credentials' };
    }
    if (a.locked) return { ok: false, reason: 'locked' };
    if (!a.isApproved) return { ok: false, reason: 'not_approved' };
    const { password: _pw, ...user } = a;
    return { ok: true, user };
  }
}

export class Clock {
  t = Date.UTC(2026, 8, 22, 9, 0, 0);
  now = (): number => this.t;
  advance(ms: number): void {
    this.t += ms;
  }
  /** Move to the start of the next 30-second TOTP step. */
  nextStep(): void {
    this.t = (stepAt(this.t) + 1) * 30_000 + 1_000;
  }
  code(secret: string): string {
    return codeForStep(secret, stepAt(this.t));
  }
}

export interface Harness {
  app: Express;
  crm: FakeCrm;
  clock: Clock;
  sessions: MemorySessionStore;
}

export interface Db {
  pool: pg.Pool;
  settings: DbSettings;
  tag: string;
  newAccount(opts?: Partial<FakeAccount>): FakeAccount;
  harness(opts?: {
    limits?: Partial<LoginLimitSettings>;
    flagEnabled?: boolean;
    /** S04 gate flag: a manager must authorise progress past stage 1. */
    stage1AuthRequired?: boolean;
    /**
     * S06: where media files live. Given, the app also mounts
     * GET /api/media/:recordingId/stream; left out there is no streaming
     * route, which is what every suite but the media one wants.
     */
    mediaStore?: MediaStore;
    /**
     * S06: given together with mediaStore, the app also mounts
     * POST /api/manager/recordings (the manager upload).
     */
    mediaUpload?: { queue: JobQueue; maxUploadBytes: number };
  }): Harness;
  cleanup(): Promise<void>;
}

const quiet = (): undefined => undefined;

/** Connects to the test DB and brings it up to the latest migration. */
export async function openTestDb(): Promise<Db> {
  const settings: DbSettings = { ...settingsFromEnv(env), DB_NAME: TEST_DB };
  await applyMigrations({ commit: true, expectDb: TEST_DB, settings, log: quiet });
  const pool = new pg.Pool(pgConfig(settings, { applicationName: 'academy-auth-test', max: 5 }));
  const tag = randomBytes(4).toString('hex');
  const crmIds: number[] = [];
  let seq = 0;

  return {
    pool,
    settings,
    tag,
    newAccount(opts = {}) {
      seq++;
      const id = randomInt(700_000_000, 799_999_999);
      crmIds.push(id);
      return {
        id,
        email: `user${seq}.${tag}@example.com`,
        fullName: `Test User ${seq}`,
        role: 'Sales',
        isApproved: true,
        locked: false,
        password: PASSWORD,
        ...opts,
      };
    },
    harness(opts = {}) {
      const clock = new Clock();
      const crm = new FakeCrm();
      const sessions = new MemorySessionStore(clock.now);
      const app = createApp({
        // Spread, not `mediaStore: opts.mediaStore`: exactOptionalPropertyTypes
        // means an explicit undefined is not the same as leaving it out.
        ...(opts.mediaStore === undefined ? {} : { mediaStore: opts.mediaStore }),
        ...(opts.mediaUpload === undefined ? {} : { mediaUpload: opts.mediaUpload }),
        flagEnabled: opts.flagEnabled ?? true,
        checkDb: () => Promise.resolve(true),
        checkRedis: () => Promise.resolve(false),
        auth: {
          db: pool,
          sessions: createSessionManager({ db: pool, store: sessions, now: clock.now }),
          pending: new MemoryPendingMfaStore(clock.now),
          crm,
          limiters: createLoginLimiters(null, {
            perIpPerMinute: 1_000,
            lockoutThreshold: 10,
            lockoutSeconds: 900,
            ...opts.limits,
          }),
          mfaKey: TEST_MFA_KEY,
          cookieSecure: false,
          now: clock.now,
        },
        training: {
          db: pool,
          sessions: createSessionManager({ db: pool, store: sessions, now: clock.now }),
          cookieSecure: false,
          stage1AuthRequired: opts.stage1AuthRequired ?? false,
          now: clock.now,
        },
      });
      return { app, crm, clock, sessions };
    },
    async cleanup() {
      const emails = `%.${tag}@example.com`;
      const ids = await pool.query<{ id: string }>(
        'SELECT id FROM academy.trainees WHERE email LIKE $1 OR crm_user_id = ANY($2::bigint[])',
        [emails, crmIds],
      );
      const traineeIds = ids.rows.map((r) => r.id);
      await pool.query(
        `DELETE FROM academy.audit_events
         WHERE trainee_id = ANY($1::bigint[]) OR payload->>'email' LIKE $2`,
        [traineeIds, emails],
      );
      await pool.query('DELETE FROM academy.sessions WHERE trainee_id = ANY($1::bigint[])', [
        traineeIds,
      ]);
      // S04 progress rows, children first: a trainee row cannot go while
      // anything still references it.
      await pool.query(
        `DELETE FROM academy.attempt_answers
          WHERE attempt_id IN (SELECT id FROM academy.quiz_attempts
                                WHERE trainee_id = ANY($1::bigint[]))`,
        [traineeIds],
      );
      for (const table of [
        'quiz_attempts',
        'lesson_progress',
        'listen_progress',
        'stage_completions',
        'level_completions',
        'dept_completions',
        'progression_authorisations',
      ]) {
        await pool.query(`DELETE FROM academy.${table} WHERE trainee_id = ANY($1::bigint[])`, [
          traineeIds,
        ]);
      }
      await pool.query('DELETE FROM academy.trainee_mfa WHERE trainee_id = ANY($1::bigint[])', [
        traineeIds,
      ]);
      await pool.query('DELETE FROM academy.role_overrides WHERE crm_user_id = ANY($1::bigint[])', [
        crmIds,
      ]);
      await pool.query('DELETE FROM academy.trainees WHERE id = ANY($1::bigint[])', [traineeIds]);
      await pool.end();
    },
  };
}

// ---------------------------------------------------------------------------
// Request helpers
// ---------------------------------------------------------------------------

let ipCounter = 0;
/** A distinct client IP per call (sent as X-Forwarded-For from loopback). */
export function nextIp(): string {
  ipCounter++;
  return `198.51.100.${(ipCounter % 250) + 1}`;
}

/** All Set-Cookie lines of a response. */
export function setCookies(res: Response): string[] {
  const raw = res.headers['set-cookie'] as unknown;
  if (Array.isArray(raw)) return raw as string[];
  return typeof raw === 'string' ? [raw] : [];
}

/** `name=value` for a cookie set by the response, or null. */
export function cookiePair(res: Response, name: string): string | null {
  const line = setCookies(res).find((c) => c.startsWith(`${name}=`));
  if (line === undefined) return null;
  const pair = line.split(';')[0]!;
  return pair === `${name}=` ? null : pair;
}

export function cookieValue(pair: string): string {
  return pair.slice(pair.indexOf('=') + 1);
}

export function login(h: Harness, email: string, password: string, ip = nextIp()) {
  return request(h.app)
    .post('/api/auth/login')
    .set('X-Forwarded-For', ip)
    .set('User-Agent', 'auth-test')
    .send({ email, password });
}

export function mfa(h: Harness, pendingCookie: string | null, code: string, ip = nextIp()) {
  const req = request(h.app)
    .post('/api/auth/mfa')
    .set('X-Forwarded-For', ip)
    .set('User-Agent', 'auth-test');
  if (pendingCookie !== null) req.set('Cookie', pendingCookie);
  return req.send({ code });
}

export interface SignedIn {
  /** `academy_sid=<id>` for the Cookie header. */
  cookie: string;
  secret: string;
  me: { id: number; fullName: string; email: string; role: string; track: string | null };
}

/**
 * Full sign-in: password, then enrol or challenge. `secret` is needed for a
 * returning (already enrolled) account. Moves the clock to a fresh TOTP step.
 */
export async function signIn(h: Harness, account: FakeAccount, secret?: string): Promise<SignedIn> {
  const res = await login(h, account.email, account.password);
  if (res.status !== 200)
    throw new Error(`login failed: ${res.status} ${JSON.stringify(res.body)}`);
  const pending = cookiePair(res, 'academy_mfa');
  const body = res.body as { next: string; enrol?: { secret: string } };
  const key = body.next === 'enrol' ? body.enrol!.secret : secret;
  if (key === undefined) throw new Error('signIn: account is enrolled; pass its secret');
  h.clock.nextStep();
  const done = await mfa(h, pending, h.clock.code(key));
  if (done.status !== 200) {
    throw new Error(`mfa failed: ${done.status} ${JSON.stringify(done.body)}`);
  }
  const cookie = cookiePair(done, 'academy_sid');
  if (cookie === null) throw new Error('no session cookie');
  return { cookie, secret: key, me: (done.body as { me: SignedIn['me'] }).me };
}

export function get(h: Harness, path: string, cookie?: string) {
  const req = request(h.app).get(path);
  if (cookie !== undefined) req.set('Cookie', cookie);
  return req;
}

export function post(h: Harness, path: string, cookie?: string, body?: object) {
  const req = request(h.app).post(path);
  if (cookie !== undefined) req.set('Cookie', cookie);
  return body === undefined ? req.send() : req.send(body);
}

export async function auditRows(
  pool: pg.Pool,
  where: { traineeId?: number; email?: string; eventType?: string },
): Promise<{ event_type: string; actor: string; payload: Record<string, unknown> }[]> {
  const { rows } = await pool.query<{
    event_type: string;
    actor: string;
    payload: Record<string, unknown>;
  }>(
    `SELECT event_type, actor, payload FROM academy.audit_events
     WHERE ($1::bigint IS NULL OR trainee_id = $1)
       AND ($2::text IS NULL OR payload->>'email' = $2)
       AND ($3::text IS NULL OR event_type = $3)
     ORDER BY id`,
    [where.traineeId ?? null, where.email?.toLowerCase() ?? null, where.eventType ?? null],
  );
  return rows;
}
