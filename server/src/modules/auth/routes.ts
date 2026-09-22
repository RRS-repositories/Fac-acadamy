import { Router } from 'express';
import type { Request, Response } from 'express';
import type { Pool } from 'pg';
import {
  LoginRequestSchema,
  LoginResponseSchema,
  MfaRequestSchema,
  MfaResponseSchema,
} from '@fac-academy/shared';
import type { AuthError, LoginResponse, MfaResponse } from '@fac-academy/shared';
import type { CrmClient } from '../../integrations/crm/crmClient.js';
import { requireAuth, authOf } from '../../middleware/auth.js';
import { actor, writeAudit } from '../audit/audit.js';
import {
  PENDING_MFA_COOKIE,
  SESSION_COOKIE,
  clearPendingCookie,
  clearSessionCookie,
  readCookieId,
  setPendingCookie,
  setSessionCookie,
} from './cookies.js';
import type { LoginLimiters } from './limits.js';
import { emailKey } from './limits.js';
import { decryptSecret, encryptSecret } from './mfaCrypto.js';
import { resolveRole } from './roles.js';
import type { PendingMfaStore, SessionManager } from './sessions.js';
import { generateEnrolment, verifyCode } from './totp.js';
import {
  CrmIdentityConflict,
  findOrCreateFromCrm,
  findRoleOverride,
  findTraineeById,
  toMe,
} from './trainees.js';

// Sign-in (S03): CRM email + password via the CRM's academy-verify endpoint,
// then TOTP (enrol on first sign-in, challenge after). Contract:
// shared/src/contracts/auth.ts. Every outcome is audited.

export const MFA_ISSUER = 'FAC Academy';

export interface AuthDeps {
  db: Pool;
  sessions: SessionManager;
  pending: PendingMfaStore;
  crm: CrmClient;
  limiters: LoginLimiters;
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
    const key = emailKey(email);

    const loginFail = (reason: string, traineeId: number | null = null) =>
      writeAudit(db, {
        traineeId,
        eventType: 'LOGIN_FAIL',
        actor: traineeId === null ? actor.system : actor.trainee(traineeId),
        payload: { email: key, reason, ip, userAgent },
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
              payload: { email: key, ip, userAgent },
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

    const mfa = await db.query<{ enrolled_at: Date | null }>(
      'SELECT enrolled_at FROM academy.trainee_mfa WHERE trainee_id = $1',
      [trainee.id],
    );
    const enrolledAt = mfa.rows[0]?.enrolled_at;
    const enrolled = enrolledAt !== undefined && enrolledAt !== null;

    let body: LoginResponse;
    let pendingId: string;
    if (enrolled) {
      pendingId = await deps.pending.create({
        traineeId: trainee.id,
        email: key,
        stage: 'challenge',
        crmRole: result.user.role,
      });
      body = { next: 'challenge' };
    } else {
      // First sign-in (or an unfinished enrolment): a fresh secret every time.
      const enrolment = await generateEnrolment(trainee.email, MFA_ISSUER);
      const secretEnc = encryptSecret(enrolment.secret, deps.mfaKey);
      await db.query(
        `INSERT INTO academy.trainee_mfa (trainee_id, secret_enc, enrolled_at, last_used_step)
         VALUES ($1, $2, NULL, NULL)
         ON CONFLICT (trainee_id) DO UPDATE
           SET secret_enc = EXCLUDED.secret_enc, last_used_step = NULL, updated_at = now()
           WHERE academy.trainee_mfa.enrolled_at IS NULL`,
        [trainee.id, secretEnc],
      );
      pendingId = await deps.pending.create({
        traineeId: trainee.id,
        email: key,
        stage: 'enrol',
        crmRole: result.user.role,
        secretEnc: secretEnc.toString('base64'),
      });
      body = {
        next: 'enrol',
        enrol: {
          qrDataUrl: enrolment.qrDataUrl,
          secret: enrolment.secret,
          issuer: MFA_ISSUER,
          account: trainee.email,
        },
      };
    }

    setPendingCookie(res, pendingId, deps.cookieSecure);
    res.set('Cache-Control', 'no-store');
    res.status(200).json(LoginResponseSchema.parse(body));
  });

  router.post('/auth/mfa', async (req, res) => {
    const { ip, userAgent } = context(req);
    const pendingId = readCookieId(req, PENDING_MFA_COOKIE);
    const pending = pendingId === null ? null : await deps.pending.get(pendingId);
    if (pendingId === null || pending === null) {
      clearPendingCookie(res, deps.cookieSecure);
      fail(res, 401, 'mfa_required');
      return;
    }

    const parsed = MfaRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      fail(res, 400, 'invalid_request');
      return;
    }

    if (await deps.limiters.isLocked(pending.email)) {
      await deps.pending.destroy(pendingId);
      clearPendingCookie(res, deps.cookieSecure);
      fail(res, 423, 'locked');
      return;
    }

    const traineeId = pending.traineeId;
    const mfaRow = await db.query<{
      secret_enc: Buffer;
      enrolled_at: Date | null;
      last_used_step: string | null;
    }>(
      'SELECT secret_enc, enrolled_at, last_used_step FROM academy.trainee_mfa WHERE trainee_id = $1',
      [traineeId],
    );
    const row = mfaRow.rows[0];
    const enrolling = pending.stage === 'enrol';
    // Enrolling: the secret shown on this sign-in. Challenge: the enrolled one.
    const secretEnc =
      enrolling && pending.secretEnc !== undefined
        ? Buffer.from(pending.secretEnc, 'base64')
        : row?.secret_enc;
    const stale =
      row === undefined || (enrolling ? row.enrolled_at !== null : row.enrolled_at === null);
    if (secretEnc === undefined || stale) {
      // The MFA row changed under us (IT reset, or enrolment finished elsewhere).
      await deps.pending.destroy(pendingId);
      clearPendingCookie(res, deps.cookieSecure);
      fail(res, 401, 'mfa_required');
      return;
    }

    const lastUsedStep = row.last_used_step === null ? null : Number(row.last_used_step);
    const secret = decryptSecret(secretEnc, deps.mfaKey);
    const check = verifyCode(secret, parsed.data.code, lastUsedStep, deps.now());

    let accepted = false;
    if (check.ok) {
      // Conditional update: a code (step) is accepted once, even under a race.
      const updated = enrolling
        ? await db.query(
            `UPDATE academy.trainee_mfa
             SET secret_enc = $2, enrolled_at = now(), last_used_step = $3, updated_at = now()
             WHERE trainee_id = $1 AND enrolled_at IS NULL`,
            [traineeId, secretEnc, check.step],
          )
        : await db.query(
            `UPDATE academy.trainee_mfa SET last_used_step = $2, updated_at = now()
             WHERE trainee_id = $1 AND enrolled_at IS NOT NULL
               AND (last_used_step IS NULL OR last_used_step < $2)`,
            [traineeId, check.step],
          );
      accepted = updated.rowCount === 1;
    }

    if (!accepted) {
      await writeAudit(db, {
        traineeId,
        eventType: 'MFA_FAIL',
        actor: actor.trainee(traineeId),
        payload: { stage: pending.stage, ip, userAgent },
      });
      const { lockedNow } = await deps.limiters.recordFailure(pending.email);
      if (lockedNow) {
        await writeAudit(db, {
          traineeId,
          eventType: 'LOCKOUT',
          actor: actor.system,
          payload: { email: pending.email, ip, userAgent },
        });
        await deps.pending.destroy(pendingId);
        clearPendingCookie(res, deps.cookieSecure);
      }
      fail(res, 401, 'invalid_code');
      return;
    }

    await deps.pending.destroy(pendingId);
    clearPendingCookie(res, deps.cookieSecure);
    await deps.limiters.reset(pending.email);

    if (enrolling) {
      await writeAudit(db, {
        traineeId,
        eventType: 'MFA_ENROLLED',
        actor: actor.trainee(traineeId),
        payload: { ip, userAgent },
      });
    }

    // Re-read: the account may have been disabled between the two steps.
    const trainee = await findTraineeById(db, traineeId);
    if (trainee === null || trainee.isDisabled) {
      await writeAudit(db, {
        traineeId,
        eventType: 'LOGIN_BLOCKED_DISABLED',
        actor: actor.trainee(traineeId),
        payload: { ip, userAgent },
      });
      fail(res, 403, 'disabled');
      return;
    }

    const role = resolveRole(pending.crmRole, await findRoleOverride(db, trainee.crmUserId));
    const sessionId = await deps.sessions.create(trainee.id, role);
    await writeAudit(db, {
      traineeId,
      eventType: 'LOGIN_SUCCESS',
      actor: actor.trainee(traineeId),
      payload: { role, crmRole: pending.crmRole, ip, userAgent },
    });

    setSessionCookie(res, sessionId, deps.cookieSecure);
    res.set('Cache-Control', 'no-store');
    const body: MfaResponse = { me: toMe(trainee, role) };
    res.status(200).json(MfaResponseSchema.parse(body));
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
