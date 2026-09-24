import type { NextFunction, Request, RequestHandler, Response } from 'express';
import type { Pool } from 'pg';
import type { AuthError, Role } from '@fac-academy/shared';
import { SESSION_COOKIE, clearSessionCookie, readCookieId } from '../modules/auth/cookies.js';
import type { SessionManager } from '../modules/auth/sessions.js';

// requireAuth guards every signed-in route. On EVERY request it loads the
// server-side session and then re-reads academy.trainees.is_disabled by
// primary key, so a manager's disable takes effect on the very next request
// (checklist 03: within 5 s), even if a session somehow survived the sweep.
// requireRole('MANAGER') follows it on manager routes.

export interface AuthContext {
  traineeId: number;
  role: Role;
  sessionId: string;
  dbSessionId: number;
}

declare module 'express-serve-static-core' {
  interface Request {
    auth?: AuthContext;
  }
}

export interface RequireAuthDeps {
  db: Pool;
  sessions: SessionManager;
  cookieSecure: boolean;
}

function fail(res: Response, status: number, error: AuthError['error']): void {
  res.status(status).json({ error } satisfies AuthError);
}

export function requireAuth(deps: RequireAuthDeps): RequestHandler {
  return async (req: Request, res: Response, next: NextFunction) => {
    const id = readCookieId(req, SESSION_COOKIE);
    const session = id === null ? null : await deps.sessions.get(id);
    if (id === null || session === null) {
      if (req.cookies?.[SESSION_COOKIE] !== undefined) clearSessionCookie(res, deps.cookieSecure);
      fail(res, 401, 'not_signed_in');
      return;
    }

    const { rows } = await deps.db.query<{ is_disabled: boolean }>(
      'SELECT is_disabled FROM academy.trainees WHERE id = $1',
      [session.traineeId],
    );
    const row = rows[0];
    if (row === undefined || row.is_disabled) {
      await deps.sessions.revokeAll(session.traineeId);
      clearSessionCookie(res, deps.cookieSecure);
      if (row === undefined) fail(res, 401, 'not_signed_in');
      else fail(res, 403, 'disabled');
      return;
    }

    await deps.sessions.touch(id, session);
    req.auth = {
      traineeId: session.traineeId,
      role: session.role,
      sessionId: id,
      dbSessionId: session.dbSessionId,
    };
    next();
  };
}

/** Use after requireAuth. STAFF calling a MANAGER route gets 403 forbidden. */
export function requireRole(role: Role): RequestHandler {
  return (req, res, next) => {
    if (req.auth === undefined) {
      fail(res, 401, 'not_signed_in');
      return;
    }
    if (req.auth.role !== role) {
      fail(res, 403, 'forbidden');
      return;
    }
    next();
  };
}

/** For handlers behind requireAuth: the context is always there. */
export function authOf(req: Request): AuthContext {
  if (req.auth === undefined) throw new Error('authOf() used on a route without requireAuth');
  return req.auth;
}
