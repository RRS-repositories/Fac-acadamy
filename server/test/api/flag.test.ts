import { describe, expect, it } from 'vitest';
import request from 'supertest';
import { FlagOffResponseSchema } from '@fac-academy/shared';
import { createApp } from '../../src/app.js';

function app(flagEnabled: boolean) {
  return createApp({
    flagEnabled,
    checkDb: () => Promise.resolve(true),
    checkRedis: () => Promise.resolve(false),
  });
}

describe('ACADEMY_V2 off', () => {
  it('still serves /api/health', async () => {
    const res = await request(app(false)).get('/api/health');
    expect(res.status).toBe(200);
    expect(res.body.flag).toBe(false);
  });

  it('returns 503 { flag: "off" } for GET /api/track', async () => {
    const res = await request(app(false)).get('/api/track');
    expect(res.status).toBe(503);
    expect(res.body).toEqual({ flag: 'off' });
    expect(FlagOffResponseSchema.safeParse(res.body).success).toBe(true);
  });

  it('returns 503 { flag: "off" } for POST /api/anything', async () => {
    const res = await request(app(false)).post('/api/anything').send({ a: 1 });
    expect(res.status).toBe(503);
    expect(res.body).toEqual({ flag: 'off' });
  });
});

describe('ACADEMY_V2 on', () => {
  it('lets requests through to the JSON 404 for unknown routes', async () => {
    const res = await request(app(true)).get('/api/track');
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: 'not_found' });
  });
});
