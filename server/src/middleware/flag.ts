import { FlagOffResponseSchema } from '@fac-academy/shared';
import type { FlagOffResponse } from '@fac-academy/shared';
import type { RequestHandler } from 'express';

/**
 * ACADEMY_V2 gate. While the flag is off every API route except /api/health
 * answers 503 { flag: 'off' }. Mounted on '/api' after the health router and
 * before every other API route.
 */
export function requireAcademyFlag(enabled: boolean): RequestHandler {
  const body: FlagOffResponse = FlagOffResponseSchema.parse({ flag: 'off' });
  return (_req, res, next) => {
    if (enabled) {
      next();
      return;
    }
    res.status(503).json(body);
  };
}
