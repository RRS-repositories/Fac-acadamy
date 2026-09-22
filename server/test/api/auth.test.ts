// S03 CHECKLIST 03, against the real local test database. Runs only when
// MIGRATION_TEST_DB_NAME is set; otherwise skipped (see auth-nodb.test.ts for
// the parts that need no database).
import { createHash } from 'node:crypto';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { LoginResponseSchema, MfaResponseSchema } from '@fac-academy/shared';
import { createApp } from '../../src/app.js';
import { createLoginLimiters } from '../../src/modules/auth/limits.js';
import {
  MemoryPendingMfaStore,
  MemorySessionStore,
  PENDING_MFA_TTL_MS,
  SESSION_IDLE_MS,
  createSessionManager,
} from '../../src/modules/auth/sessions.js';
import {
  FakeCrm,
  TEST_DB,
  TEST_MFA_KEY,
  auditRows,
  cookiePair,
  cookieValue,
  get,
  login,
  mfa,
  openTestDb,
  post,
  setCookies,
  signIn,
} from './helpers/authHarness.js';
import type { Db, Harness } from './helpers/authHarness.js';

describe.skipIf(!TEST_DB)('S03 sign-in, sessions and account controls (test DB)', () => {
  let db: Db;

  beforeAll(async () => {
    db = await openTestDb();
  }, 120_000);

  afterAll(async () => {
    await db?.cleanup();
  });

  function setup(opts?: Parameters<Db['harness']>[0]): Harness {
    return db.harness(opts);
  }

  async function signedInManager(h: Harness) {
    const account = h.crm.add(db.newAccount({ role: 'Management' }));
    return signIn(h, account);
  }

  // ---- Checklist 1: CRM credentials + TOTP → session; role in /api/me ------

  describe('checklist 1: valid CRM credentials + TOTP establish a session', () => {
    it('first sign-in enrols, creates the trainee (track NULL) and /api/me shows STAFF', async () => {
      const h = setup();
      const account = h.crm.add(db.newAccount({ role: 'Sales' }));

      const res = await login(h, account.email, account.password);
      expect(res.status).toBe(200);
      const body = LoginResponseSchema.parse(res.body);
      expect(body.next).toBe('enrol');
      if (body.next !== 'enrol') throw new Error('unreachable');
      expect(body.enrol.account).toBe(account.email);
      expect(body.enrol.issuer).toBe('FAC Academy');
      expect(body.enrol.qrDataUrl.startsWith('data:image/png;base64,')).toBe(true);
      // The CRM got the client IP, not the proxy's.
      expect(h.crm.calls.at(-1)?.clientIp).toMatch(/^198\.51\.100\./);

      // No session yet: only the pending cookie.
      expect(cookiePair(res, 'academy_sid')).toBeNull();
      const pending = cookiePair(res, 'academy_mfa');
      expect(pending).not.toBeNull();
      expect((await get(h, '/api/me', pending!)).status).toBe(401);

      h.clock.nextStep();
      const done = await mfa(h, pending, h.clock.code(body.enrol.secret));
      expect(done.status).toBe(200);
      const { me } = MfaResponseSchema.parse(done.body);
      expect(me).toMatchObject({ email: account.email, role: 'STAFF', track: null });

      const cookie = cookiePair(done, 'academy_sid')!;
      const meRes = await get(h, '/api/me', cookie);
      expect(meRes.status).toBe(200);
      expect(meRes.body).toEqual({ me });

      const row = await db.pool.query(
        'SELECT crm_user_id, full_name, track, status FROM academy.trainees WHERE id = $1',
        [me.id],
      );
      expect(row.rows[0]).toEqual({
        crm_user_id: String(account.id),
        full_name: account.fullName,
        track: null,
        status: 'ACTIVE',
      });

      // The TOTP secret is stored encrypted, and the enrolment is complete.
      const mfaRow = await db.pool.query<{ secret_enc: Buffer; enrolled_at: Date | null }>(
        'SELECT secret_enc, enrolled_at FROM academy.trainee_mfa WHERE trainee_id = $1',
        [me.id],
      );
      expect(mfaRow.rows[0]!.enrolled_at).not.toBeNull();
      expect(mfaRow.rows[0]!.secret_enc.toString('latin1')).not.toContain(body.enrol.secret);

      // The academy.sessions mirror holds the hash of the id, never the id.
      const sid = cookieValue(cookie);
      const sessions = await db.pool.query<{ sid_hash: string }>(
        'SELECT sid_hash FROM academy.sessions WHERE trainee_id = $1',
        [me.id],
      );
      expect(sessions.rows.map((r) => r.sid_hash)).toEqual([
        createHash('sha256').update(sid).digest('hex'),
      ]);
    });

    it('a returning user gets the challenge and signs in with the next code', async () => {
      const h = setup();
      const account = h.crm.add(db.newAccount());
      const first = await signIn(h, account);

      const res = await login(h, account.email, account.password);
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ next: 'challenge' });
      h.clock.nextStep();
      const done = await mfa(h, cookiePair(res, 'academy_mfa'), h.clock.code(first.secret));
      expect(done.status).toBe(200);
      expect(done.body.me.id).toBe(first.me.id);
    });

    it("CRM role 'Management' is MANAGER; a role_overrides row wins", async () => {
      const h = setup();
      const manager = await signedInManager(h);
      expect(manager.me.role).toBe('MANAGER');
      expect((await get(h, '/api/me', manager.cookie)).body.me.role).toBe('MANAGER');

      const promoted = h.crm.add(db.newAccount({ role: 'IT' }));
      await db.pool.query(
        `INSERT INTO academy.role_overrides (crm_user_id, role, reason, granted_by)
         VALUES ($1, 'MANAGER', 'test', 'ops:test')`,
        [promoted.id],
      );
      expect((await signIn(h, promoted)).me.role).toBe('MANAGER');

      const demoted = h.crm.add(db.newAccount({ role: 'Management' }));
      await db.pool.query(
        `INSERT INTO academy.role_overrides (crm_user_id, role, reason, granted_by)
         VALUES ($1, 'STAFF', 'test', 'ops:test')`,
        [demoted.id],
      );
      expect((await signIn(h, demoted)).me.role).toBe('STAFF');
    });

    it('links an existing trainee row by email on first CRM sign-in', async () => {
      const h = setup();
      const account = db.newAccount();
      const { rows } = await db.pool.query<{ id: string }>(
        `INSERT INTO academy.trainees (full_name, email, track) VALUES ($1, $2, 'CS') RETURNING id`,
        [account.fullName, account.email.toUpperCase()],
      );
      h.crm.add(account);
      const { me } = await signIn(h, account);
      expect(me.id).toBe(Number(rows[0]!.id));
      expect(me.track).toBe('CS');
      const linked = await db.pool.query('SELECT crm_user_id FROM academy.trainees WHERE id = $1', [
        me.id,
      ]);
      expect(linked.rows[0]!.crm_user_id).toBe(String(account.id));
    });

    it('cookies are HttpOnly, SameSite=Lax, Path=/ and host-only (no Domain)', async () => {
      const h = setup();
      const account = h.crm.add(db.newAccount());
      const res = await login(h, account.email, account.password);
      h.clock.nextStep();
      const done = await mfa(
        h,
        cookiePair(res, 'academy_mfa'),
        h.clock.code((res.body as { enrol: { secret: string } }).enrol.secret),
      );
      const lines = [...setCookies(res), ...setCookies(done)].filter((l) =>
        /^academy_(sid|mfa)=[^;]/.test(l),
      );
      expect(lines.length).toBeGreaterThanOrEqual(2);
      for (const line of lines) {
        expect(line).toMatch(/;\s*HttpOnly/i);
        expect(line).toMatch(/;\s*SameSite=Lax/i);
        expect(line).toMatch(/;\s*Path=\//i);
        expect(line).not.toMatch(/;\s*Domain=/i);
      }
      // The pending cookie is short-lived; the session cookie has no Max-Age.
      expect(lines.find((l) => l.startsWith('academy_mfa='))).toMatch(/Max-Age=300/);
      expect(lines.find((l) => l.startsWith('academy_sid='))).not.toMatch(/Max-Age/i);
    });

    it('sets Secure when COOKIE_SECURE is on', async () => {
      // Built directly so cookieSecure can be true.
      const crm = new FakeCrm();
      const account = crm.add(db.newAccount());
      const app = createApp({
        flagEnabled: true,
        checkDb: () => Promise.resolve(true),
        checkRedis: () => Promise.resolve(false),
        auth: {
          db: db.pool,
          sessions: createSessionManager({ db: db.pool, store: new MemorySessionStore() }),
          pending: new MemoryPendingMfaStore(),
          crm,
          limiters: createLoginLimiters(null),
          mfaKey: TEST_MFA_KEY,
          cookieSecure: true,
          now: Date.now,
        },
      });
      const res = await request(app)
        .post('/api/auth/login')
        .send({ email: account.email, password: account.password });
      expect(res.status).toBe(200);
      expect(setCookies(res).find((l) => l.startsWith('academy_mfa='))).toMatch(/;\s*Secure/i);
    });
  });

  // ---- Checklist 2: invalid credentials and invalid TOTP rejected + audited --

  describe('checklist 2: bad password and bad code are rejected and audited', () => {
    it('wrong password → 401 invalid_credentials + LOGIN_FAIL', async () => {
      const h = setup();
      const account = h.crm.add(db.newAccount());
      const res = await login(h, account.email, 'wrong-password');
      expect(res.status).toBe(401);
      expect(res.body).toEqual({ error: 'invalid_credentials' });
      expect(cookiePair(res, 'academy_mfa')).toBeNull();
      const rows = await auditRows(db.pool, { email: account.email, eventType: 'LOGIN_FAIL' });
      expect(rows).toHaveLength(1);
      expect(rows[0]!.payload).toMatchObject({ reason: 'invalid_credentials' });
      expect(JSON.stringify(rows[0]!.payload)).not.toContain('wrong-password');
    });

    it('unknown email → the same 401 (never says which part was wrong)', async () => {
      const h = setup();
      const res = await login(h, `nobody.${db.tag}@example.com`, 'whatever');
      expect(res.status).toBe(401);
      expect(res.body).toEqual({ error: 'invalid_credentials' });
    });

    it('wrong code → 401 invalid_code + MFA_FAIL; no session', async () => {
      const h = setup();
      const account = h.crm.add(db.newAccount());
      const res = await login(h, account.email, account.password);
      const secret = (res.body as { enrol: { secret: string } }).enrol.secret;
      h.clock.nextStep();
      const good = h.clock.code(secret);
      const bad = good === '000000' ? '111111' : '000000';
      const wrong = await mfa(h, cookiePair(res, 'academy_mfa'), bad);
      expect(wrong.status).toBe(401);
      expect(wrong.body).toEqual({ error: 'invalid_code' });
      expect(cookiePair(wrong, 'academy_sid')).toBeNull();

      const trainee = await db.pool.query<{ id: string }>(
        'SELECT id FROM academy.trainees WHERE crm_user_id = $1',
        [account.id],
      );
      const traineeId = Number(trainee.rows[0]!.id);
      const rows = await auditRows(db.pool, { traineeId, eventType: 'MFA_FAIL' });
      expect(rows).toHaveLength(1);
      expect(JSON.stringify(rows[0]!.payload)).not.toContain(bad);

      // The right code still works afterwards (same pending step).
      const ok = await mfa(h, cookiePair(res, 'academy_mfa'), good);
      expect(ok.status).toBe(200);
    });

    it('rejects a replayed code (same TOTP step used twice)', async () => {
      const h = setup();
      const account = h.crm.add(db.newAccount());
      const first = await signIn(h, account);
      const usedCode = h.clock.code(first.secret); // the step signIn just used

      const res = await login(h, account.email, account.password);
      const replay = await mfa(h, cookiePair(res, 'academy_mfa'), usedCode);
      expect(replay.status).toBe(401);
      expect(replay.body).toEqual({ error: 'invalid_code' });
    });

    it('the pending step expires after 5 minutes → 401 mfa_required', async () => {
      const h = setup();
      const account = h.crm.add(db.newAccount());
      const res = await login(h, account.email, account.password);
      const secret = (res.body as { enrol: { secret: string } }).enrol.secret;
      h.clock.advance(PENDING_MFA_TTL_MS + 1_000);
      const late = await mfa(h, cookiePair(res, 'academy_mfa'), h.clock.code(secret));
      expect(late.status).toBe(401);
      expect(late.body).toEqual({ error: 'mfa_required' });
    });

    it('no pending cookie → 401 mfa_required', async () => {
      const h = setup();
      const res = await mfa(h, null, '123456');
      expect(res.status).toBe(401);
      expect(res.body).toEqual({ error: 'mfa_required' });
    });

    it('maps CRM outcomes: not approved 403, CRM-locked 423, CRM down 503', async () => {
      const h = setup();
      const pending = h.crm.add(db.newAccount({ isApproved: false }));
      expect((await login(h, pending.email, pending.password)).body).toEqual({
        error: 'not_approved',
      });
      const locked = h.crm.add(db.newAccount({ locked: true }));
      const lockedRes = await login(h, locked.email, locked.password);
      expect(lockedRes.status).toBe(423);
      expect(lockedRes.body).toEqual({ error: 'locked' });
      h.crm.mode = 'unavailable';
      const down = await login(h, pending.email, pending.password);
      expect(down.status).toBe(503);
      expect(down.body).toEqual({ error: 'auth_unavailable' });
    });

    it('rejects a malformed body with 400 invalid_request', async () => {
      const h = setup();
      const res = await request(h.app).post('/api/auth/login').send({ email: 'not-an-email' });
      expect(res.status).toBe(400);
      expect(res.body).toEqual({ error: 'invalid_request' });
      const junk = await request(h.app)
        .post('/api/auth/login')
        .set('Content-Type', 'application/json')
        .send('{"email":');
      expect(junk.status).toBe(400);
      expect(junk.body).toEqual({ error: 'invalid_request' });
    });
  });

  // ---- Checklist 3: STAFF on a manager endpoint → 403 ------------------------

  describe('checklist 3: staff calling a manager endpoint gets 403', () => {
    it('STAFF → 403 forbidden on every manager route; MANAGER → allowed', async () => {
      const h = setup();
      const staff = await signIn(h, h.crm.add(db.newAccount({ role: 'Sales' })));
      const manager = await signedInManager(h);

      const ping = await get(h, '/api/manager/ping', staff.cookie);
      expect(ping.status).toBe(403);
      expect(ping.body).toEqual({ error: 'forbidden' });
      for (const path of [
        `/api/manager/trainees/${manager.me.id}/disable`,
        `/api/manager/trainees/${manager.me.id}/enable`,
      ]) {
        expect((await post(h, path, staff.cookie)).status).toBe(403);
      }
      const track = await request(h.app)
        .put(`/api/manager/trainees/${staff.me.id}/track`)
        .set('Cookie', staff.cookie)
        .send({ track: 'SALES' });
      expect(track.status).toBe(403);

      expect((await get(h, '/api/manager/ping', manager.cookie)).status).toBe(204);
      expect((await get(h, '/api/manager/ping')).status).toBe(401);
    });
  });

  // ---- Checklist 4: disable while signed in → next request refused < 5 s ----

  describe('checklist 4: disabling a signed-in account takes effect at once', () => {
    it('the next request is refused within 5 s (timed)', async () => {
      const h = setup();
      const trainee = await signIn(h, h.crm.add(db.newAccount()));
      const manager = await signedInManager(h);
      expect((await get(h, '/api/me', trainee.cookie)).status).toBe(200);

      const started = performance.now();
      const disable = await post(
        h,
        `/api/manager/trainees/${trainee.me.id}/disable`,
        manager.cookie,
      );
      expect(disable.status).toBe(204);
      const next = await get(h, '/api/me', trainee.cookie);
      const elapsedMs = performance.now() - started;

      expect([401, 403]).toContain(next.status);
      expect(elapsedMs).toBeLessThan(5_000);
      console.log(`[checklist 4] disable → refused request in ${elapsedMs.toFixed(1)} ms`);

      // Every session of that trainee is gone from the store and marked revoked.
      expect(await h.sessions.get(cookieValue(trainee.cookie))).toBeNull();
      const rows = await db.pool.query<{ revoked: boolean }>(
        'SELECT revoked FROM academy.sessions WHERE trainee_id = $1',
        [trainee.me.id],
      );
      expect(rows.rows.length).toBeGreaterThan(0);
      expect(rows.rows.every((r) => r.revoked)).toBe(true);
      const t = await db.pool.query(
        'SELECT is_disabled, disabled_by, disabled_at FROM academy.trainees WHERE id = $1',
        [trainee.me.id],
      );
      expect(t.rows[0]).toMatchObject({ is_disabled: true, disabled_by: String(manager.me.id) });
      expect(t.rows[0]!.disabled_at).not.toBeNull();
    });

    it('a disable made directly in the DB is enforced on the next request too', async () => {
      const h = setup();
      const trainee = await signIn(h, h.crm.add(db.newAccount()));
      await db.pool.query('UPDATE academy.trainees SET is_disabled = TRUE WHERE id = $1', [
        trainee.me.id,
      ]);
      const res = await get(h, '/api/me', trainee.cookie);
      expect(res.status).toBe(403);
      expect(res.body).toEqual({ error: 'disabled' });
      expect(await h.sessions.get(cookieValue(trainee.cookie))).toBeNull();
    });

    it('a manager cannot disable themselves; unknown ids are 404', async () => {
      const h = setup();
      const manager = await signedInManager(h);
      expect(
        (await post(h, `/api/manager/trainees/${manager.me.id}/disable`, manager.cookie)).status,
      ).toBe(400);
      expect(
        (await post(h, '/api/manager/trainees/999999999999/disable', manager.cookie)).status,
      ).toBe(404);
      expect((await post(h, '/api/manager/trainees/abc/disable', manager.cookie)).status).toBe(400);
    });
  });

  // ---- Checklist 5: disabled cannot sign in; re-enable restores -------------

  describe('checklist 5: a disabled account cannot sign in; re-enabling restores it', () => {
    it('403 disabled at sign-in, then works again after enable', async () => {
      const h = setup();
      const account = h.crm.add(db.newAccount());
      const first = await signIn(h, account);
      const manager = await signedInManager(h);
      await post(h, `/api/manager/trainees/${first.me.id}/disable`, manager.cookie);

      const blocked = await login(h, account.email, account.password);
      expect(blocked.status).toBe(403);
      expect(blocked.body).toEqual({ error: 'disabled' });
      expect(cookiePair(blocked, 'academy_mfa')).toBeNull();
      expect(
        await auditRows(db.pool, { traineeId: first.me.id, eventType: 'LOGIN_BLOCKED_DISABLED' }),
      ).toHaveLength(1);

      const enable = await post(h, `/api/manager/trainees/${first.me.id}/enable`, manager.cookie);
      expect(enable.status).toBe(204);
      const again = await signIn(h, account, first.secret);
      expect(again.me.id).toBe(first.me.id);
      expect((await get(h, '/api/me', again.cookie)).status).toBe(200);
    });

    it('a disable between the password and the code step blocks the session', async () => {
      const h = setup();
      const account = h.crm.add(db.newAccount());
      const first = await signIn(h, account);
      const res = await login(h, account.email, account.password);
      await db.pool.query('UPDATE academy.trainees SET is_disabled = TRUE WHERE id = $1', [
        first.me.id,
      ]);
      h.clock.nextStep();
      const done = await mfa(h, cookiePair(res, 'academy_mfa'), h.clock.code(first.secret));
      expect(done.status).toBe(403);
      expect(done.body).toEqual({ error: 'disabled' });
      expect(cookiePair(done, 'academy_sid')).toBeNull();
    });
  });

  // ---- Checklist 6: 11 rapid failed logins → lockout -------------------------

  describe('checklist 6: rapid failed logins are locked out', () => {
    it('11 rapid failed logins from one IP → 429 after the 5th (default 5/min/IP)', async () => {
      const h = setup({ limits: { perIpPerMinute: 5 } });
      const account = h.crm.add(db.newAccount());
      const statuses: number[] = [];
      for (let i = 0; i < 11; i++) {
        const res = await login(h, account.email, `wrong-${i}`, '203.0.113.9');
        statuses.push(res.status);
      }
      expect(statuses).toEqual([401, 401, 401, 401, 401, 429, 429, 429, 429, 429, 429]);
      const last = await login(h, account.email, account.password, '203.0.113.9');
      expect(last.status).toBe(429);
      expect(last.body).toEqual({ error: 'rate_limited' });
      // Another IP is not affected by this one's limit.
      expect((await login(h, account.email, account.password, '203.0.113.10')).status).toBe(200);
    });

    it('10 failures on one email (any IPs) → 423 locked, even with the right password', async () => {
      const h = setup();
      const account = h.crm.add(db.newAccount());
      const statuses: number[] = [];
      for (let i = 0; i < 11; i++) {
        statuses.push((await login(h, account.email, `wrong-${i}`)).status);
      }
      expect(statuses.slice(0, 10)).toEqual(Array(10).fill(401));
      expect(statuses[10]).toBe(423);
      const right = await login(h, account.email, account.password);
      expect(right.status).toBe(423);
      expect(right.body).toEqual({ error: 'locked' });
      expect(await auditRows(db.pool, { email: account.email, eventType: 'LOCKOUT' })).toHaveLength(
        1,
      );
    });

    it('wrong codes count toward the same lockout', async () => {
      const h = setup();
      const account = h.crm.add(db.newAccount());
      const first = await signIn(h, account);
      for (let i = 0; i < 9; i++) await login(h, account.email, 'wrong');
      const res = await login(h, account.email, account.password);
      expect(res.status).toBe(200);
      h.clock.nextStep();
      const good = h.clock.code(first.secret);
      const wrong = await mfa(
        h,
        cookiePair(res, 'academy_mfa'),
        good === '000000' ? '111111' : '000000',
      );
      expect(wrong.status).toBe(401);
      // The 10th failure locked the account and ended the pending step.
      const retry = await mfa(h, cookiePair(res, 'academy_mfa'), good);
      expect(retry.status).toBe(401);
      expect(retry.body).toEqual({ error: 'mfa_required' });
      expect((await login(h, account.email, account.password)).status).toBe(423);
    });

    it('a successful sign-in resets the failure count', async () => {
      const h = setup();
      const account = h.crm.add(db.newAccount());
      const first = await signIn(h, account);
      for (let i = 0; i < 9; i++) await login(h, account.email, 'wrong');
      await signIn(h, account, first.secret);
      for (let i = 0; i < 9; i++) await login(h, account.email, 'wrong');
      expect((await login(h, account.email, account.password)).status).toBe(200);
    });
  });

  // ---- Sessions: heartbeat, logout, idle expiry ------------------------------

  describe('sessions', () => {
    it('heartbeat → 204 and updates last_seen_at; logout → 204, cookie cleared, signed out', async () => {
      const h = setup();
      const s = await signIn(h, h.crm.add(db.newAccount()));
      h.clock.advance(10_000);
      expect((await post(h, '/api/auth/heartbeat', s.cookie)).status).toBe(204);
      const seen = await db.pool.query<{ signed_in_at: Date; last_seen_at: Date }>(
        'SELECT signed_in_at, last_seen_at FROM academy.sessions WHERE trainee_id = $1',
        [s.me.id],
      );
      const row = seen.rows[0]!;
      expect(row.last_seen_at.getTime() - row.signed_in_at.getTime()).toBe(10_000);

      const out = await post(h, '/api/auth/logout', s.cookie);
      expect(out.status).toBe(204);
      expect(setCookies(out).some((l) => /^academy_sid=;/.test(l))).toBe(true);
      expect((await get(h, '/api/me', s.cookie)).status).toBe(401);
      const signedOut = await db.pool.query(
        'SELECT signed_out_at FROM academy.sessions WHERE trainee_id = $1',
        [s.me.id],
      );
      expect(signedOut.rows[0]!.signed_out_at).not.toBeNull();
      expect(await auditRows(db.pool, { traineeId: s.me.id, eventType: 'LOGOUT' })).toHaveLength(1);
    });

    it('expires after 12 h idle; activity slides the expiry', async () => {
      const h = setup();
      const s = await signIn(h, h.crm.add(db.newAccount()));
      h.clock.advance(SESSION_IDLE_MS - 60_000);
      expect((await get(h, '/api/me', s.cookie)).status).toBe(200); // slides
      h.clock.advance(SESSION_IDLE_MS - 60_000);
      expect((await get(h, '/api/me', s.cookie)).status).toBe(200);
      h.clock.advance(SESSION_IDLE_MS);
      const res = await get(h, '/api/me', s.cookie);
      expect(res.status).toBe(401);
      expect(res.body).toEqual({ error: 'not_signed_in' });
    });

    it('a forged or unknown session cookie → 401 not_signed_in', async () => {
      const h = setup();
      expect((await get(h, '/api/me', 'academy_sid=forged')).status).toBe(401);
      const unknown = await get(h, '/api/me', `academy_sid=${'A'.repeat(43)}`);
      expect(unknown.status).toBe(401);
      expect(unknown.body).toEqual({ error: 'not_signed_in' });
    });
  });

  // ---- Decision D13: manager assigns the track --------------------------------

  describe('manager track assignment (D13)', () => {
    it('PUT /api/manager/trainees/:id/track sets the track, shows in /api/me, is audited', async () => {
      const h = setup();
      const trainee = await signIn(h, h.crm.add(db.newAccount()));
      expect(trainee.me.track).toBeNull();
      const manager = await signedInManager(h);

      const bad = await request(h.app)
        .put(`/api/manager/trainees/${trainee.me.id}/track`)
        .set('Cookie', manager.cookie)
        .send({ track: 'NOPE' });
      expect(bad.status).toBe(400);

      const res = await request(h.app)
        .put(`/api/manager/trainees/${trainee.me.id}/track`)
        .set('Cookie', manager.cookie)
        .send({ track: 'SALES' });
      expect(res.status).toBe(204);
      expect((await get(h, '/api/me', trainee.cookie)).body.me.track).toBe('SALES');

      const rows = await auditRows(db.pool, {
        traineeId: trainee.me.id,
        eventType: 'TRACK_ASSIGNED',
      });
      expect(rows).toHaveLength(1);
      expect(rows[0]!.actor).toBe(`manager:${manager.me.id}`);
      expect(rows[0]!.payload).toMatchObject({ from: null, to: 'SALES' });
    });
  });

  // ---- Checklist 8: audit rows for every required event -----------------------

  describe('checklist 8: audit rows exist for login success, login fail, MFA fail, disable, re-enable', () => {
    it('writes each event with the right actor and no secrets', async () => {
      const h = setup();
      const account = h.crm.add(db.newAccount());
      await login(h, account.email, 'wrong-password'); // LOGIN_FAIL
      const res = await login(h, account.email, account.password);
      const secret = (res.body as { enrol: { secret: string } }).enrol.secret;
      h.clock.nextStep();
      const good = h.clock.code(secret);
      await mfa(h, cookiePair(res, 'academy_mfa'), good === '000000' ? '111111' : '000000'); // MFA_FAIL
      const done = await mfa(h, cookiePair(res, 'academy_mfa'), good); // MFA_ENROLLED + LOGIN_SUCCESS
      const traineeId = (done.body as { me: { id: number } }).me.id;
      const manager = await signedInManager(h);
      await post(h, `/api/manager/trainees/${traineeId}/disable`, manager.cookie);
      await post(h, `/api/manager/trainees/${traineeId}/enable`, manager.cookie);

      const byTrainee = await auditRows(db.pool, { traineeId });
      const failRows = await auditRows(db.pool, { email: account.email, eventType: 'LOGIN_FAIL' });
      const types = new Set([...byTrainee, ...failRows].map((r) => r.event_type));
      for (const t of [
        'LOGIN_SUCCESS',
        'LOGIN_FAIL',
        'MFA_FAIL',
        'MFA_ENROLLED',
        'ACCOUNT_DISABLED',
        'ACCOUNT_ENABLED',
      ]) {
        expect(types, t).toContain(t);
      }
      const disabled = byTrainee.find((r) => r.event_type === 'ACCOUNT_DISABLED')!;
      expect(disabled.actor).toBe(`manager:${manager.me.id}`);
      expect(byTrainee.find((r) => r.event_type === 'LOGIN_SUCCESS')!.actor).toBe(
        `trainee:${traineeId}`,
      );
      expect(byTrainee.find((r) => r.event_type === 'LOGIN_SUCCESS')!.payload).toMatchObject({
        role: 'STAFF',
        ip: expect.stringMatching(/^198\.51\.100\./),
        userAgent: expect.any(String),
      });

      const everything = JSON.stringify([...byTrainee, ...failRows]);
      expect(everything).not.toContain('wrong-password');
      expect(everything).not.toContain(account.password);
      expect(everything).not.toContain(secret);
      expect(everything).not.toContain(good);
    });
  });
});
