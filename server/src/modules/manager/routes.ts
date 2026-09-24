import { Router } from 'express';
import { z } from 'zod';
import {
  ManagerConfigSchema,
  PreviewTrackResponseSchema,
  RosterResponseSchema,
  StuckResponseSchema,
  TRACK_CODES,
  TraineeDetailSchema,
} from '@fac-academy/shared';
import type { TrackCode } from '@fac-academy/shared';
import { authOf, requireAuth, requireRole } from '../../middleware/auth.js';
import { actor, writeAudit } from '../audit/audit.js';
import { accountsRouter } from './accounts.js';
import { context, fail, targetId } from './deps.js';
import type { ManagerDeps } from './deps.js';
import { ExportThrottle, csvFilename, loadStageStatsFor, rosterCsv } from './export.js';
import { previewTrack } from './preview.js';
import { buildRoster, loadTraineeDetail } from './roster.js';
import { buildStuck } from './stuck.js';

// The manager API (S07). requireAuth + requireRole('MANAGER') are applied once,
// here, for every route in the module — a STAFF session gets 403 'forbidden'
// before any handler runs, and the whole router already sits behind the
// ACADEMY_V2 flag gate in app.ts.
//
// Reads of trainee data are audited (S07 task 5): one summary row per view,
// never one per trainee. Actions — disable, enable, reassign, export, preview
// — are audited individually, with the manager's identity.

const TrackParamSchema = z.enum(TRACK_CODES as [TrackCode, ...TrackCode[]]);

const RosterQuerySchema = z.object({
  track: TrackParamSchema.optional(),
  /** Name or email fragment. */
  q: z.string().max(100).optional(),
  /** Default true: a disabled account is still on the roster, greyed out. */
  includeDisabled: z.enum(['true', 'false']).optional(),
});

interface RosterFiltersParsed {
  track: TrackCode | null;
  q: string | null;
  includeDisabled: boolean;
}

function parseFilters(query: unknown): RosterFiltersParsed | null {
  const parsed = RosterQuerySchema.safeParse(query);
  if (!parsed.success) return null;
  const q = parsed.data.q?.trim() ?? '';
  return {
    track: parsed.data.track ?? null,
    q: q === '' ? null : q,
    includeDisabled: parsed.data.includeDisabled !== 'false',
  };
}

export function managerRouter(deps: ManagerDeps): Router {
  const router = Router();
  const { db } = deps;
  const now = deps.now ?? Date.now;
  const throttle = new ExportThrottle();

  router.use(requireAuth(deps), requireRole('MANAGER'));
  // Manager data is never cached: a roster one refresh out of date is wrong.
  router.use((_req, res, next) => {
    res.set('Cache-Control', 'no-store');
    next();
  });

  // A trivial manager-only route (the checklist's "staff → 403" probe).
  router.get('/ping', (_req, res) => {
    res.status(204).end();
  });

  // --- 1. The roster -------------------------------------------------------
  router.get('/roster', async (req, res) => {
    const filters = parseFilters(req.query);
    if (filters === null) {
      fail(res, 400, 'invalid_request');
      return;
    }
    const manager = authOf(req);
    const roster = await buildRoster(db, filters);
    await writeAudit(db, {
      traineeId: null,
      eventType: 'MANAGER_VIEW',
      actor: actor.manager(manager.traineeId),
      payload: { view: 'roster', counts: roster.counts, filters, ...context(req) },
    });
    res.status(200).json(RosterResponseSchema.parse(roster));
  });

  // --- 2. Who needs a hand -------------------------------------------------
  router.get('/stuck', async (req, res) => {
    const manager = authOf(req);
    const stuck = await buildStuck(db);
    await writeAudit(db, {
      traineeId: null,
      eventType: 'MANAGER_VIEW',
      actor: actor.manager(manager.traineeId),
      payload: { view: 'stuck', flagged: stuck.trainees.length, ...context(req) },
    });
    res.status(200).json(StuckResponseSchema.parse(stuck));
  });

  // --- 4. CSV export (declared before /trainee/:id is irrelevant; distinct path)
  router.get('/export.csv', async (req, res) => {
    const filters = parseFilters(req.query);
    if (filters === null) {
      fail(res, 400, 'invalid_request');
      return;
    }
    const manager = authOf(req);
    if (!throttle.allow(manager.traineeId, now())) {
      fail(res, 429, 'rate_limited');
      return;
    }
    const { trainees } = await buildRoster(db, filters);
    const stats = await loadStageStatsFor(
      db,
      trainees.map((t) => t.id),
    );
    const body = rosterCsv(trainees, stats);
    await writeAudit(db, {
      traineeId: null,
      eventType: 'EXPORT_CSV',
      actor: actor.manager(manager.traineeId),
      payload: { rows: trainees.length, filters, bytes: Buffer.byteLength(body), ...context(req) },
    });
    res.status(200);
    res.type('text/csv; charset=utf-8');
    res.set('Content-Disposition', `attachment; filename="${csvFilename(now())}"`);
    // The other download routes (certificates, media, verification) all say
    // this; the export was the one that did not. Without it a browser is free
    // to sniff the body as something else — a roster row is trainee-supplied
    // text, and HTML is one of the things it could be taken for.
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.send(body);
  });

  // --- 3. One trainee, stage by stage --------------------------------------
  router.get('/trainee/:id', async (req, res) => {
    const id = targetId(req, res);
    if (id === null) return;
    const manager = authOf(req);
    const detail = await loadTraineeDetail(deps, id);
    if (detail === null) {
      fail(res, 404, 'not_found');
      return;
    }
    await writeAudit(db, {
      traineeId: id,
      eventType: 'MANAGER_VIEW',
      actor: actor.manager(manager.traineeId),
      payload: { view: 'trainee', stages: detail.stages.length, ...context(req) },
    });
    res.status(200).json(TraineeDetailSchema.parse(detail));
  });

  // --- 5. Preview as track (read only) -------------------------------------
  router.get('/preview/:track', async (req, res) => {
    const track = TrackParamSchema.safeParse(req.params.track);
    if (!track.success) {
      fail(res, 404, 'not_found');
      return;
    }
    const manager = authOf(req);
    const preview = await previewTrack(db, track.data);
    await writeAudit(db, {
      traineeId: null,
      eventType: 'MANAGER_PREVIEW',
      actor: actor.manager(manager.traineeId),
      payload: { track: track.data, stages: preview.stages.length, ...context(req) },
    });
    res.status(200).json(PreviewTrackResponseSchema.parse(preview));
  });

  // --- 6. The flags, read-only (S07 task 4) --------------------------------
  router.get('/config', (_req, res) => {
    res.status(200).json(
      ManagerConfigSchema.parse({
        stage1AuthRequired: deps.stage1AuthRequired ?? false,
        academyV2: deps.academyV2 ?? true,
        provisioning: deps.provisioningEnabled ?? false,
      }),
    );
  });

  // --- Account controls (S03): disable, enable, track reassignment ---------
  router.use(accountsRouter(deps));

  return router;
}
