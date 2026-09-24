import { Router } from 'express';
import { HealthResponseSchema } from '@fac-academy/shared';
import type { HealthResponse } from '@fac-academy/shared';

export interface HealthDeps {
  flagEnabled: boolean;
  checkDb: () => Promise<boolean>;
  checkRedis: () => Promise<boolean>;
}

export function healthRouter(deps: HealthDeps): Router {
  const router = Router();

  router.get('/', async (_req, res) => {
    const [db, redis] = await Promise.all([deps.checkDb(), deps.checkRedis()]);
    // `ok` follows the database only. Redis is optional locally (no REDIS_URL
    // until the compose service is up) and is required by config in
    // production, so an unconfigured Redis must not mark the app unhealthy.
    // `redis` is still reported so monitoring can see it.
    const body: HealthResponse = { ok: db, db, redis, flag: deps.flagEnabled };
    res.status(body.ok ? 200 : 503).json(HealthResponseSchema.parse(body));
  });

  return router;
}
