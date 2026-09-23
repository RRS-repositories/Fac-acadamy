import type { Request, Response } from 'express';
import type { Pool } from 'pg';
import { z } from 'zod';
import type { ManagerError } from '@fac-academy/shared';
import type { RequireAuthDeps } from '../../middleware/auth.js';
import type { SessionManager } from '../auth/sessions.js';

// Shared plumbing for the manager module (S07). Every route in it sits behind
// requireAuth + requireRole('MANAGER'), which sits behind the ACADEMY_V2 flag
// gate in app.ts, so a STAFF session never reaches any handler here.

export interface ManagerDeps extends RequireAuthDeps {
  db: Pool;
  sessions: SessionManager;
  /**
   * Config flags, surfaced read-only by GET /api/manager/config (S07 task 4).
   * They are environment settings: this API never writes them.
   */
  stage1AuthRequired?: boolean;
  academyV2?: boolean;
  provisioningEnabled?: boolean;
  /** Injectable clock, for tests. Defaults to Date.now. */
  now?: () => number;
}

export const IdParamSchema = z.coerce.number().int().positive().max(Number.MAX_SAFE_INTEGER);

export function fail(res: Response, status: number, error: ManagerError['error']): void {
  res.status(status).json({ error } satisfies ManagerError);
}

/** The :id path parameter, or null when it was malformed (400 already sent). */
export function targetId(req: Request, res: Response): number | null {
  const parsed = IdParamSchema.safeParse(req.params.id);
  if (!parsed.success) {
    fail(res, 400, 'invalid_request');
    return null;
  }
  return parsed.data;
}

/** Request context for an audit payload. Never a cookie, never a session id. */
export function context(req: Request): { ip: string; userAgent: string | undefined } {
  return { ip: req.ip ?? '', userAgent: req.get('user-agent')?.slice(0, 300) };
}

/** pg gives timestamptz back as a Date; the contract carries ISO strings. */
export function toIso(value: Date | string | null): string | null {
  if (value === null) return null;
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

/** NUMERIC comes back as a string; keep null as null rather than 0. */
export function toNumber(value: string | number | null): number | null {
  if (value === null) return null;
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(n) ? n : null;
}
