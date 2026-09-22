import { Router } from 'express';
import type { Request, Response } from 'express';
import type { Pool } from 'pg';
import { z } from 'zod';
import { TRACK_CODES } from '@fac-academy/shared';
import type { TrackCode } from '@fac-academy/shared';
import { authOf, requireAuth, requireRole } from '../../middleware/auth.js';
import type { RequireAuthDeps } from '../../middleware/auth.js';
import { actor, writeAudit } from '../audit/audit.js';
import type { SessionManager } from '../auth/sessions.js';

// Manager account controls (S03 task 5, decision D13). Every route here is
// behind requireAuth + requireRole('MANAGER'). Disable is instant: the flag
// is set, every session of that trainee is deleted, and requireAuth re-checks
// the flag on every request anyway.

export interface ManagerDeps extends RequireAuthDeps {
  db: Pool;
  sessions: SessionManager;
}

const IdParamSchema = z.coerce.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const TrackBodySchema = z.object({
  track: z.enum(TRACK_CODES as [TrackCode, ...TrackCode[]]),
});

function targetId(req: Request, res: Response): number | null {
  const parsed = IdParamSchema.safeParse(req.params.id);
  if (!parsed.success) {
    res.status(400).json({ error: 'invalid_request' });
    return null;
  }
  return parsed.data;
}

function notFound(res: Response): void {
  res.status(404).json({ error: 'not_found' });
}

function context(req: Request): { ip: string; userAgent: string | undefined } {
  return { ip: req.ip ?? '', userAgent: req.get('user-agent')?.slice(0, 300) };
}

export function managerRouter(deps: ManagerDeps): Router {
  const router = Router();
  const { db } = deps;

  router.use(requireAuth(deps), requireRole('MANAGER'));

  // A trivial manager-only route (the checklist's "staff → 403" probe).
  router.get('/ping', (_req, res) => {
    res.status(204).end();
  });

  router.post('/trainees/:id/disable', async (req, res) => {
    const id = targetId(req, res);
    if (id === null) return;
    const manager = authOf(req);
    if (id === manager.traineeId) {
      // A manager cannot lock themselves out; another manager (or IT) can.
      res.status(400).json({ error: 'invalid_request' });
      return;
    }
    const { rows } = await db.query<{ was_disabled: boolean }>(
      `UPDATE academy.trainees t
       SET is_disabled = TRUE,
           disabled_by = $2,
           disabled_at = COALESCE(CASE WHEN old.is_disabled THEN old.disabled_at END, now())
       FROM academy.trainees old
       WHERE t.id = $1 AND old.id = t.id
       RETURNING old.is_disabled AS was_disabled`,
      [id, manager.traineeId],
    );
    if (rows[0] === undefined) {
      notFound(res);
      return;
    }
    const revoked = await deps.sessions.revokeAll(id);
    await writeAudit(db, {
      traineeId: id,
      eventType: 'ACCOUNT_DISABLED',
      actor: actor.manager(manager.traineeId),
      payload: { sessionsRevoked: revoked, alreadyDisabled: rows[0].was_disabled, ...context(req) },
    });
    res.status(204).end();
  });

  router.post('/trainees/:id/enable', async (req, res) => {
    const id = targetId(req, res);
    if (id === null) return;
    const manager = authOf(req);
    const { rows } = await db.query<{ was_disabled: boolean }>(
      `UPDATE academy.trainees t
       SET is_disabled = FALSE, disabled_by = NULL, disabled_at = NULL
       FROM academy.trainees old
       WHERE t.id = $1 AND old.id = t.id
       RETURNING old.is_disabled AS was_disabled`,
      [id],
    );
    if (rows[0] === undefined) {
      notFound(res);
      return;
    }
    await writeAudit(db, {
      traineeId: id,
      eventType: 'ACCOUNT_ENABLED',
      actor: actor.manager(manager.traineeId),
      payload: { wasDisabled: rows[0].was_disabled, ...context(req) },
    });
    res.status(204).end();
  });

  router.put('/trainees/:id/track', async (req, res) => {
    const id = targetId(req, res);
    if (id === null) return;
    const body = TrackBodySchema.safeParse(req.body);
    if (!body.success) {
      res.status(400).json({ error: 'invalid_request' });
      return;
    }
    const manager = authOf(req);
    const { rows } = await db.query<{ previous: string | null }>(
      `UPDATE academy.trainees t SET track = $2
       FROM academy.trainees old
       WHERE t.id = $1 AND old.id = t.id
       RETURNING old.track AS previous`,
      [id, body.data.track],
    );
    if (rows[0] === undefined) {
      notFound(res);
      return;
    }
    await writeAudit(db, {
      traineeId: id,
      eventType: 'TRACK_ASSIGNED',
      actor: actor.manager(manager.traineeId),
      payload: { from: rows[0].previous, to: body.data.track, ...context(req) },
    });
    res.status(204).end();
  });

  return router;
}
