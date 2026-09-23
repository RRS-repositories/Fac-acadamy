import { Router } from 'express';
import { z } from 'zod';
import { TRACK_CODES } from '@fac-academy/shared';
import type { TrackCode } from '@fac-academy/shared';
import { authOf } from '../../middleware/auth.js';
import { actor, writeAudit } from '../audit/audit.js';
import { context, fail, targetId } from './deps.js';
import type { ManagerDeps } from './deps.js';

// Manager account controls (S03 task 5, decision D13). The router is mounted
// by routes.ts, which has already applied requireAuth + requireRole('MANAGER').
// Disable is instant: the flag is set, every session of that trainee is
// deleted, and requireAuth re-checks the flag on every request anyway.
//
// Every action here writes exactly one audit row carrying the manager's
// identity (S07 task 7).

export type { ManagerDeps };

const TrackBodySchema = z.object({
  track: z.enum(TRACK_CODES as [TrackCode, ...TrackCode[]]),
});

export function accountsRouter(deps: ManagerDeps): Router {
  const router = Router();
  const { db } = deps;

  router.post('/trainees/:id/disable', async (req, res) => {
    const id = targetId(req, res);
    if (id === null) return;
    const manager = authOf(req);
    if (id === manager.traineeId) {
      // A manager cannot lock themselves out; another manager (or IT) can.
      fail(res, 400, 'invalid_request');
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
      fail(res, 404, 'not_found');
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
      fail(res, 404, 'not_found');
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
      fail(res, 400, 'invalid_request');
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
      fail(res, 404, 'not_found');
      return;
    }
    // The visible stage list is derived from trainees.track through
    // academy.track_visibility, so writing the column IS the recompute: the
    // trainee's next request sees the new track's stages and nothing else.
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
