// Sign-in behaviour that needs no database: the flag gate, missing sessions
// and the guards that answer before any query.
import request from 'supertest';
import type { Pool } from 'pg';
import { describe, expect, it } from 'vitest';
import { createApp } from '../../src/app.js';
import { createLoginLimiters } from '../../src/modules/auth/limits.js';
import { MemorySessionStore, createSessionManager } from '../../src/modules/auth/sessions.js';
import { FakeCrm, TEST_MFA_KEY } from './helpers/authHarness.js';

// Any query is a test failure here.
const noDb = {
  query: () => Promise.reject(new Error('this test must not touch the database')),
} as unknown as Pool;

function app(flagEnabled: boolean) {
  return createApp({
    flagEnabled,
    checkDb: () => Promise.resolve(true),
    checkRedis: () => Promise.resolve(false),
    auth: {
      db: noDb,
      sessions: createSessionManager({ db: noDb, store: new MemorySessionStore() }),
      crm: new FakeCrm(),
      limiters: createLoginLimiters(null),
      mfaKey: TEST_MFA_KEY,
      cookieSecure: false,
      now: Date.now,
    },
  });
}

describe('ACADEMY_V2 off: the auth routes are behind the flag', () => {
  it.each([
    ['post', '/api/auth/login'],
    ['post', '/api/auth/heartbeat'],
    ['post', '/api/auth/logout'],
    ['get', '/api/me'],
    ['get', '/api/manager/ping'],
  ] as const)('%s %s → 503 { flag: "off" }', async (method, path) => {
    const res = await request(app(false))[method](path).send({});
    expect(res.status).toBe(503);
    expect(res.body).toEqual({ flag: 'off' });
  });
});

describe('without a session', () => {
  it('GET /api/me → 401 not_signed_in', async () => {
    const res = await request(app(true)).get('/api/me');
    expect(res.status).toBe(401);
    expect(res.body).toEqual({ error: 'not_signed_in' });
  });

  it('manager routes → 401 not_signed_in', async () => {
    const res = await request(app(true)).post('/api/manager/trainees/1/disable');
    expect(res.status).toBe(401);
    expect(res.body).toEqual({ error: 'not_signed_in' });
  });

  // The authenticator step is gone: the route no longer exists, so it falls
  // through to the JSON 404 (no training router here to answer 401 first).
  it('POST /api/auth/mfa → 404 not_found (the authenticator step was removed)', async () => {
    const res = await request(app(true)).post('/api/auth/mfa').send({ code: '123456' });
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: 'not_found' });
  });

  it('POST /api/auth/logout → 204 and clears the cookie', async () => {
    const res = await request(app(true)).post('/api/auth/logout');
    expect(res.status).toBe(204);
    expect(String(res.headers['set-cookie'])).toMatch(/^academy_sid=;/);
  });

  it('POST /api/auth/login with a bad body → 400 before the CRM is called', async () => {
    const res = await request(app(true)).post('/api/auth/login').send({ email: 'x' });
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'invalid_request' });
  });
});
