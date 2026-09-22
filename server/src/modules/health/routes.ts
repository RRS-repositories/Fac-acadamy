import { Router } from 'express';
import { HealthResponseSchema } from '@fac-academy/shared';
import type { HealthResponse } from '@fac-academy/shared';

export const healthRouter: Router = Router();

healthRouter.get('/', (_req, res) => {
  // Phase 0 placeholders. S01 wires the real db and redis checks and the ACADEMY_V2 flag.
  const body: HealthResponse = { ok: true, db: false, redis: false, flag: false };
  res.status(200).json(HealthResponseSchema.parse(body));
});
