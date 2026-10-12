// S03 CHECKLIST 03, against the real local test database. Runs only when
// MIGRATION_TEST_DB_NAME is set; otherwise skipped (see auth-nodb.test.ts for
// the parts that need no database).
//
// Sign-in is CRM email + password and nothing else: the authenticator-app
// (TOTP) step was removed (decision D21), so POST /api/auth/login creates the
// session itself and POST /api/auth/mfa no longer exists.
import { createHash } from 'node:crypto';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { LoginResponseSchema } from '@fac-academy/shared';
import { createApp } from '../../src/app.js';
import { createLoginLimiters, emailAuditKey } from '../../src/modules/auth/limits.js';
import {
  MemorySessionStore,
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

  async function sessionRows(traineeId: number): Promise<number> {
    const { rows } = await db.pool.query<{ n: string }>(
      'SELECT count(*) AS n FROM academy.sessions WHERE trainee_id = $1',
      [traineeId],
    );
    return Number(rows[0]!.n);
  }

  // ---- Checklist 1: CRM credentials → session; role in /api/me ---------------

  describe('checklist 1: valid CRM credentials establish a session', () => {
    it('login returns { me } and sets academy_sid; new trainee (track NULL) is STAFF', async () => {
      const h = setup();
      const account = h.crm.add(db.newAccount({ role: 'Sales' }));

      const res = await login(h, account.email, account.password);
      expect(res.status).toBe(200);
      expect(res.headers['cache-control']).toBe('no-store');
      // Exactly { me }: nothing about an authenticator, no "next" step.
      expect(Object.keys(res.body as object)).toEqual(['me']);
      const { me } = LoginResponseSchema.parse(res.body);
      expect(me).toMatchObject({ email: account.email, role: 'STAFF', track: null });
      // The CRM got the client IP, not the proxy's.
      expect(h.crm.calls.at(-1)?.clientIp).toMatch(/^198\.51\.100\./);

      // The session cookie, and only that one: no pending-step cookie any more.
      const cookie = cookiePair(res, 'academy_sid');
      expect(cookie).not.toBeNull();
      expect(cookiePair(res, 'academy_mfa')).toBeNull();
      const meRes = await get(h, '/api/me', cookie!);
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

      // The academy.sessions mirror holds the hash of the id, never the id.
      const sid = cookieValue(cookie!);
      const sessions = await db.pool.query<{ sid_hash: string }>(
        'SELECT sid_hash FROM academy.sessions WHERE trainee_id = $1',
        [me.id],
      );
      expect(sessions.rows.map((r) => r.sid_hash)).toEqual([
        createHash('sha256').update(sid).digest('hex'),
      ]);
    });

    it('login writes no academy.trainee_mfa row', async () => {
      const h = setup();
      const account = h.crm.add(db.newAccount());
      const first = await signIn(h, account);
      await signIn(h, account);
      const { rows } = await db.pool.query<{ n: string }>(
        'SELECT count(*) AS n FROM academy.trainee_mfa WHERE trainee_id = $1',
        [first.me.id],
      );
      expect(Number(rows[0]!.n)).toBe(0);
    });

    it('a returning user signs in again with the password alone', async () => {
      const h = setup();
      const account = h.crm.add(db.newAccount());
      const first = await signIn(h, account);
      const again = await signIn(h, account);
      expect(again.me.id).toBe(first.me.id);
      expect(again.cookie).not.toBe(first.cookie);
      // Both sessions are live: signing in again does not sign the other one out.
      expect((await get(h, '/api/me', first.cookie)).status).toBe(200);
      expect((await get(h, '/api/me', again.cookie)).status).toBe(200);
      expect(await sessionRows(first.me.id)).toBe(2);
    });

    it('POST /api/auth/mfa → 404 (the authenticator step no longer exists)', async () => {
      const h = setup();
      const s = await signIn(h, h.crm.add(db.newAccount()));
      // Signed in, so the training router's session check lets the request
      // through to the JSON 404 for an unknown route.
      const res = await post(h, '/api/auth/mfa', s.cookie, { code: '123456' });
      expect(res.status).toBe(404);
      expect(res.body).toEqual({ error: 'not_found' });
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

    it('an email linked to a different CRM user → 403 forbidden, audited, no session', async () => {
      const h = setup();
      const original = h.crm.add(db.newAccount());
      const first = await signIn(h, original);
      // Another CRM user (a different id) now presents the same address.
      const other = h.crm.add(db.newAccount({ email: original.email }));
      expect(other.id).not.toBe(original.id);

      const res = await login(h, other.email, other.password);
      expect(res.status).toBe(403);
      expect(res.body).toEqual({ error: 'forbidden' });
      expect(cookiePair(res, 'academy_sid')).toBeNull();
      const fails = await auditRows(db.pool, { email: original.email, eventType: 'LOGIN_FAIL' });
      expect(fails.map((r) => r.payload['reason'])).toContain('crm_identity_conflict');
      // Still only the one session from the original sign-in.
      expect(await sessionRows(first.me.id)).toBe(1);
    });

    it('the session cookie is HttpOnly, SameSite=Lax, Path=/, host-only, no Max-Age', async () => {
      const h = setup();
      const account = h.crm.add(db.newAccount());
      const res = await login(h, account.email, account.password);
      expect(res.status).toBe(200);
      const lines = setCookies(res).filter((l) => /^academy_[a-z]+=[^;]/.test(l));
      expect(lines).toHaveLength(1);
      const line = lines[0]!;
      expect(line.startsWith('academy_sid=')).toBe(true);
      expect(line).toMatch(/;\s*HttpOnly/i);
      expect(line).toMatch(/;\s*SameSite=Lax/i);
      expect(line).toMatch(/;\s*Path=\//i);
      expect(line).not.toMatch(/;\s*Domain=/i);
      expect(line).not.toMatch(/Max-Age/i);
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
      expect(setCookies(res).find((l) => l.startsWith('academy_sid='))).toMatch(/;\s*Secure/i);
    });
  });

  // ---- Checklist 2: invalid credentials rejected + audited -------------------

  describe('checklist 2: bad credentials are rejected and audited', () => {
    it('wrong password → 401 invalid_credentials + LOGIN_FAIL; no session', async () => {
      const h = setup();
      const account = h.crm.add(db.newAccount());
      const res = await login(h, account.email, 'wrong-password');
      expect(res.status).toBe(401);
      expect(res.body).toEqual({ error: 'invalid_credentials' });
      expect(cookiePair(res, 'academy_sid')).toBeNull();
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

    // academy.audit_events is append-only, manager-readable and exported as
    // CSV. A failed sign-in carries whatever was typed into the login box, so
    // what lands in the table is a keyed hash of it and never the text itself.
    it('a failed sign-in stores a hash of the address, never the address', async () => {
      const h = setup();
      // Nobody's account: whoever is at the login box types what they like,
      // and it is kept for ever.
      const typed = `not-a-user.${db.tag}@attacker.example`;
      const res = await login(h, typed, 'whatever');
      expect(res.status).toBe(401);

      const { rows } = await db.pool.query<{ payload: Record<string, unknown> }>(
        `SELECT payload FROM academy.audit_events
          WHERE event_type = 'LOGIN_FAIL'
            AND payload->>'emailHash' = $1`,
        [emailAuditKey(typed, TEST_MFA_KEY)],
      );
      expect(rows).toHaveLength(1);
      const payload = rows[0]!.payload;
      expect(payload['email']).toBeUndefined();
      expect(payload['emailHash']).toMatch(/^[0-9a-f]{32}$/);
      // Not the address, not any part of it, and nothing that was typed.
      const asText = JSON.stringify(payload);
      expect(asText).not.toContain('@');
      expect(asText).not.toContain(db.tag);
      expect(asText).not.toContain('not-a-user');

      // The hash is keyed: another key gives a different digest for the same
      // address, so the digests cannot be rebuilt from a list of addresses.
      expect(emailAuditKey(typed, Buffer.alloc(32, 9))).not.toBe(
        emailAuditKey(typed, TEST_MFA_KEY),
      );
      // …and it is stable, which is what makes repeated attempts correlatable.
      expect(emailAuditKey(` ${typed.toUpperCase()} `, TEST_MFA_KEY)).toBe(
        emailAuditKey(typed, TEST_MFA_KEY),
      );

      await db.pool.query(`DELETE FROM academy.audit_events WHERE payload->>'emailHash' = $1`, [
        emailAuditKey(typed, TEST_MFA_KEY),
      ]);
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
    it('403 disabled at sign-in with no session, then works again after enable', async () => {
      const h = setup();
      const account = h.crm.add(db.newAccount());
      const first = await signIn(h, account);
      const manager = await signedInManager(h);
      await post(h, `/api/manager/trainees/${first.me.id}/disable`, manager.cookie);
      const before = await sessionRows(first.me.id);

      const blocked = await login(h, account.email, account.password);
      expect(blocked.status).toBe(403);
      expect(blocked.body).toEqual({ error: 'disabled' });
      expect(cookiePair(blocked, 'academy_sid')).toBeNull();
      expect(await sessionRows(first.me.id)).toBe(before);
      expect(
        await auditRows(db.pool, { traineeId: first.me.id, eventType: 'LOGIN_BLOCKED_DISABLED' }),
      ).toHaveLength(1);
      expect(
        await auditRows(db.pool, { traineeId: first.me.id, eventType: 'LOGIN_SUCCESS' }),
      ).toHaveLength(1);

      const enable = await post(h, `/api/manager/trainees/${first.me.id}/enable`, manager.cookie);
      expect(enable.status).toBe(204);
      const again = await signIn(h, account);
      expect(again.me.id).toBe(first.me.id);
      expect((await get(h, '/api/me', again.cookie)).status).toBe(200);
    });

    it('an account disabled directly in the DB is refused at sign-in with no session', async () => {
      const h = setup();
      const account = h.crm.add(db.newAccount());
      const first = await signIn(h, account);
      await db.pool.query('UPDATE academy.trainees SET is_disabled = TRUE WHERE id = $1', [
        first.me.id,
      ]);
      const res = await login(h, account.email, account.password);
      expect(res.status).toBe(403);
      expect(res.body).toEqual({ error: 'disabled' });
      expect(cookiePair(res, 'academy_sid')).toBeNull();
      expect(await sessionRows(first.me.id)).toBe(1);
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

    it('a successful sign-in resets the failure count', async () => {
      const h = setup();
      const account = h.crm.add(db.newAccount());
      for (let i = 0; i < 9; i++) await login(h, account.email, 'wrong');
      await signIn(h, account);
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

  describe('checklist 8: audit rows exist for login success, login fail, disable, re-enable', () => {
    it('LOGIN_SUCCESS is audited with the resolved role, the CRM role, ip and user agent', async () => {
      const h = setup();
      const s = await signedInManager(h);
      const rows = await auditRows(db.pool, { traineeId: s.me.id, eventType: 'LOGIN_SUCCESS' });
      expect(rows).toHaveLength(1);
      expect(rows[0]!.actor).toBe(`trainee:${s.me.id}`);
      expect(rows[0]!.payload).toEqual({
        role: 'MANAGER',
        crmRole: 'Management',
        ip: expect.stringMatching(/^198\.51\.100\./),
        userAgent: 'auth-test',
      });
    });

    it('writes each event in order, with the right actor and no secrets', async () => {
      const h = setup();
      const account = h.crm.add(db.newAccount());
      await login(h, account.email, 'wrong-password'); // LOGIN_FAIL
      const done = await login(h, account.email, account.password); // LOGIN_SUCCESS
      expect(done.status).toBe(200);
      const traineeId = (done.body as { me: { id: number } }).me.id;
      const manager = await signedInManager(h);
      await post(h, `/api/manager/trainees/${traineeId}/disable`, manager.cookie);
      await post(h, `/api/manager/trainees/${traineeId}/enable`, manager.cookie);

      const byTrainee = await auditRows(db.pool, { traineeId });
      const failRows = await auditRows(db.pool, { email: account.email, eventType: 'LOGIN_FAIL' });
      expect(failRows).toHaveLength(1);
      // The trainee's own trail, in the order it happened. No MFA_* event is
      // written any more: there is no authenticator step to enrol in or fail.
      expect(byTrainee.map((r) => r.event_type)).toEqual([
        'LOGIN_SUCCESS',
        'ACCOUNT_DISABLED',
        'ACCOUNT_ENABLED',
      ]);
      const disabled = byTrainee.find((r) => r.event_type === 'ACCOUNT_DISABLED')!;
      expect(disabled.actor).toBe(`manager:${manager.me.id}`);
      const success = byTrainee.find((r) => r.event_type === 'LOGIN_SUCCESS')!;
      expect(success.actor).toBe(`trainee:${traineeId}`);
      expect(success.payload).toMatchObject({
        role: 'STAFF',
        crmRole: 'Sales',
        ip: expect.stringMatching(/^198\.51\.100\./),
        userAgent: expect.any(String),
      });

      const everything = JSON.stringify([...byTrainee, ...failRows]);
      expect(everything).not.toContain('wrong-password');
      expect(everything).not.toContain(account.password);
      expect(everything).not.toContain(cookieValue(cookiePair(done, 'academy_sid')!));
    });
  });
});
