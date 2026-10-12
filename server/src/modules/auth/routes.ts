import { Router } from 'express';
import type { Request, Response } from 'express';
import type { Pool } from 'pg';
import { LoginRequestSchema, LoginResponseSchema } from '@fac-academy/shared';
import type { AuthError, LoginResponse } from '@fac-academy/shared';
import type { CrmClient } from '../../integrations/crm/crmClient.js';
import { requireAuth, authOf } from '../../middleware/auth.js';
import { actor, writeAudit } from '../audit/audit.js';
import { SESSION_COOKIE, clearSessionCookie, readCookieId, setSessionCookie } from './cookies.js';
import type { LoginLimiters } from './limits.js';
import { emailAuditKey, lockoutKey } from './limits.js';
import { resolveRole } from './roles.js';
import type { SessionManager } from './sessions.js';
import {
  CrmIdentityConflict,
  findOrCreateFromCrm,
  findRoleOverride,
  findTraineeById,
  toMe,
} from './trainees.js';

// Sign-in (S03): CRM email + password via the CRM's academy-verify endpoint,
// and a session straight away. There is no authenticator-app (TOTP) step: it
// was removed because it blocked new joiners (decision D21). The TOTP code and
// academy.trainee_mfa are kept but no longer used at sign-in. Contract:
// shared/src/contracts/auth.ts. Every outcome is audited.

export interface AuthDeps {
  db: Pool;
  sessions: SessionManager;
  crm: CrmClient;
  limiters: LoginLimiters;
  /**
   * MFA_ENCRYPTION_KEY. No longer encrypts anything at sign-in; it keys the
   * HMAC of the address in failed-sign-in audit rows (emailAuditKey).
   */
  mfaKey: Buffer;
  cookieSecure: boolean;
  now: () => number;
}

function fail(res: Response, status: number, error: AuthError['error']): void {
  res.status(status).json({ error } satisfies AuthError);
}

function context(req: Request): { ip: string; userAgent: string | undefined } {
  return { ip: req.ip ?? '', userAgent: req.get('user-agent')?.slice(0, 300) };
}

export function authRouter(deps: AuthDeps): Router {
  const router = Router();
  const { db } = deps;
  const auth = requireAuth(deps);

  router.post('/auth/login', async (req, res) => {
    const { ip, userAgent } = context(req);

    if (!(await deps.limiters.consumeIp(ip))) {
      fail(res, 429, 'rate_limited');
      return;
    }

    const parsed = LoginRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      fail(res, 400, 'invalid_request');
      return;
    }
    const { email, password } = parsed.data;
    const key = lockoutKey(email);

    const loginFail = (reason: string, traineeId: number | null = null) =>
      writeAudit(db, {
        traineeId,
        eventType: 'LOGIN_FAIL',
        actor: traineeId === null ? actor.system : actor.trainee(traineeId),
        // NEVER the address itself: anything at all can be typed into the
        // login box, and academy.audit_events keeps it for good.
        payload: { emailHash: emailAuditKey(key, deps.mfaKey), reason, ip, userAgent },
      });

    if (await deps.limiters.isLocked(key)) {
      await loginFail('locked_out');
      fail(res, 423, 'locked');
      return;
    }

    const result = await deps.crm.verify(email, password, ip);
    if (!result.ok) {
      await loginFail(result.reason);
      switch (result.reason) {
        case 'invalid_credentials': {
          const { lockedNow } = await deps.limiters.recordFailure(key);
          if (lockedNow) {
            await writeAudit(db, {
              traineeId: null,
              eventType: 'LOCKOUT',
              actor: actor.system,
              payload: { emailHash: emailAuditKey(key, deps.mfaKey), ip, userAgent },
            });
          }
          fail(res, 401, 'invalid_credentials');
          return;
        }
        case 'not_approved':
          fail(res, 403, 'not_approved');
          return;
        case 'locked':
          fail(res, 423, 'locked');
          return;
        case 'rate_limited':
          fail(res, 429, 'rate_limited');
          return;
        case 'unavailable':
          fail(res, 503, 'auth_unavailable');
          return;
      }
    }

    let trainee;
    try {
      trainee = await findOrCreateFromCrm(db, result.user);
    } catch (err) {
      if (!(err instanceof CrmIdentityConflict)) throw err;
      await loginFail('crm_identity_conflict');
      fail(res, 403, 'forbidden');
      return;
    }

    if (trainee.isDisabled) {
      await writeAudit(db, {
        traineeId: trainee.id,
        eventType: 'LOGIN_BLOCKED_DISABLED',
        actor: actor.trainee(trainee.id),
        payload: { ip, userAgent },
      });
      fail(res, 403, 'disabled');
      return;
    }

    await deps.limiters.reset(key);

    const role = resolveRole(result.user.role, await findRoleOverride(db, trainee.crmUserId));
    const sessionId = await deps.sessions.create(trainee.id, role);
    await writeAudit(db, {
      traineeId: trainee.id,
      eventType: 'LOGIN_SUCCESS',
      actor: actor.trainee(trainee.id),
      payload: { role, crmRole: result.user.role, ip, userAgent },
    });

    setSessionCookie(res, sessionId, deps.cookieSecure);
    res.set('Cache-Control', 'no-store');
    const body: LoginResponse = { me: toMe(trainee, role) };
    res.status(200).json(LoginResponseSchema.parse(body));
  });

  router.get('/me', auth, async (req, res) => {
    const { traineeId, role } = authOf(req);
    const trainee = await findTraineeById(db, traineeId);
    if (trainee === null) {
      fail(res, 401, 'not_signed_in');
      return;
    }
    res.set('Cache-Control', 'no-store');
    res.status(200).json({ me: toMe(trainee, role) });
  });

  router.post('/auth/heartbeat', auth, async (req, res) => {
    const { sessionId } = authOf(req);
    const session = await deps.sessions.get(sessionId);
    if (session !== null) await deps.sessions.touch(sessionId, session, true);
    res.status(204).end();
  });

  router.post('/auth/logout', async (req, res) => {
    const id = readCookieId(req, SESSION_COOKIE);
    const session = id === null ? null : await deps.sessions.destroy(id);
    if (session !== null) {
      const { ip, userAgent } = context(req);
      await writeAudit(db, {
        traineeId: session.traineeId,
        eventType: 'LOGOUT',
        actor: actor.trainee(session.traineeId),
        payload: { ip, userAgent },
      });
    }
    clearSessionCookie(res, deps.cookieSecure);
    res.status(204).end();
  });

  return router;
}
