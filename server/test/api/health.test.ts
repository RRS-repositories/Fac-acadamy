import { describe, expect, it } from 'vitest';
import request from 'supertest';
import { HealthResponseSchema } from '@fac-academy/shared';
import { createApp } from '../../src/app.js';

describe('GET /api/health', () => {
  it('returns 200 and a body that matches the shared contract', async () => {
    const res = await request(createApp()).get('/api/health');
    expect(res.status).toBe(200);
    expect(HealthResponseSchema.safeParse(res.body).success).toBe(true);
  });

  it('does not advertise Express', async () => {
    const res = await request(createApp()).get('/api/health');
    expect(res.headers['x-powered-by']).toBeUndefined();
  });
});

describe('unknown API routes', () => {
  it('returns a JSON 404', async () => {
    const res = await request(createApp()).get('/api/nope');
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: 'not_found' });
  });
});
