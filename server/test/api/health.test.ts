import { describe, expect, it } from 'vitest';
import request from 'supertest';
import { HealthResponseSchema } from '@fac-academy/shared';
import { createApp } from '../../src/app.js';
import type { AppDeps } from '../../src/app.js';

function app(overrides: Partial<AppDeps> = {}) {
  return createApp({
    flagEnabled: true,
    checkDb: () => Promise.resolve(true),
    checkRedis: () => Promise.resolve(true),
    ...overrides,
  });
}

describe('GET /api/health', () => {
  it('returns 200 and a body that matches the shared contract', async () => {
    const res = await request(app()).get('/api/health');
    expect(res.status).toBe(200);
    expect(HealthResponseSchema.safeParse(res.body).success).toBe(true);
    expect(res.body).toEqual({ ok: true, db: true, redis: true, flag: true });
  });

  it('stays ok when the database is up and Redis is not', async () => {
    const res = await request(app({ checkRedis: () => Promise.resolve(false) })).get('/api/health');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, db: true, redis: false, flag: true });
  });

  it('returns 503 and ok false when the database is down', async () => {
    const res = await request(app({ checkDb: () => Promise.resolve(false) })).get('/api/health');
    expect(res.status).toBe(503);
    expect(res.body).toEqual({ ok: false, db: false, redis: true, flag: true });
  });

  it('reports the ACADEMY_V2 flag', async () => {
    const off = await request(app({ flagEnabled: false })).get('/api/health');
    expect(off.body.flag).toBe(false);
    const on = await request(app({ flagEnabled: true })).get('/api/health');
    expect(on.body.flag).toBe(true);
  });

  it('does not advertise Express', async () => {
    const res = await request(app()).get('/api/health');
    expect(res.headers['x-powered-by']).toBeUndefined();
  });
});

describe('unknown API routes', () => {
  it('returns a JSON 404', async () => {
    const res = await request(app()).get('/api/nope');
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: 'not_found' });
  });
});
