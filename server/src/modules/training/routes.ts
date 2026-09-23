import { Router } from 'express';
import type { Response } from 'express';
import { z } from 'zod';
import {
  LockedResponseSchema,
  StageResponseSchema,
  TrackResponseSchema,
  TrainingErrorSchema,
} from '@fac-academy/shared';
import type { TrainingError } from '@fac-academy/shared';
import { authOf, requireAuth } from '../../middleware/auth.js';
import { gate } from './gate.js';
import type { GateDenial } from './gate.js';
import { readLesson } from './lessons.js';
import { createQuizRouter } from './quiz.routes.js';
import type { TrainingDeps } from './repo.js';
import { buildStage } from './stages.js';
import { buildTrack } from './track.js';

// The training API (S04). Every route here is behind requireAuth (mounted in
// app.ts after the ACADEMY_V2 flag gate), and every route that serves content
// asks gate() first. Nothing is served on the strength of what the client sent.

/** Matches academy.stages.code (migration 0002, stages_code_format). */
const StageCodeSchema = z.string().regex(/^[A-Za-z0-9_-]{1,32}$/);
const LessonIdSchema = z.coerce.number().int().positive().max(Number.MAX_SAFE_INTEGER);

function fail(res: Response, status: number, error: TrainingError['error']): void {
  res.status(status).json(TrainingErrorSchema.parse({ error }));
}

/** 403 for a locked stage. `requires` is null when the track is what is missing. */
function locked(res: Response, requires: string | null): void {
  res.status(403).json(LockedResponseSchema.parse({ error: 'locked', requires }));
}

/**
 * One mapping from a gate denial to an HTTP answer, used by every route.
 * A stage on another track is a 404: the trainee is never told it exists.
 */
function denied(res: Response, reason: GateDenial, requires?: string): void {
  switch (reason) {
    case 'no_track':
      locked(res, null);
      return;
    case 'locked':
      locked(res, requires ?? null);
      return;
    case 'not_visible':
    case 'not_found':
      fail(res, 404, 'not_found');
      return;
  }
}

export function trainingRouter(deps: TrainingDeps): Router {
  const router = Router();

  router.use(requireAuth(deps));

  router.get('/track', async (req, res) => {
    const { traineeId } = authOf(req);
    res.set('Cache-Control', 'no-store');
    res.status(200).json(TrackResponseSchema.parse(await buildTrack(deps, traineeId)));
  });

  router.get('/stage/:code', async (req, res) => {
    const { traineeId } = authOf(req);
    const code = StageCodeSchema.safeParse(req.params.code);
    if (!code.success) {
      fail(res, 404, 'not_found');
      return;
    }
    const allowed = await gate(deps.db, traineeId, code.data, {
      stage1AuthRequired: deps.stage1AuthRequired,
    });
    if (!allowed.allowed) {
      denied(res, allowed.reason, allowed.requires);
      return;
    }
    res.set('Cache-Control', 'no-store');
    res
      .status(200)
      .json(StageResponseSchema.parse(await buildStage(deps, traineeId, allowed.stage)));
  });

  router.post('/lesson/:id/read', async (req, res) => {
    const { traineeId } = authOf(req);
    const id = LessonIdSchema.safeParse(req.params.id);
    if (!id.success) {
      fail(res, 400, 'invalid_request');
      return;
    }
    const result = await readLesson(deps, traineeId, id.data);
    if (!result.ok) {
      denied(res, result.reason, result.requires);
      return;
    }
    res.status(204).end();
  });

  // GET/POST /api/stage/:code/quiz: questions without any correct flag, and
  // server-side grading. Its own router (mergeParams), on the same gate() and
  // the same contract file. Mounted after GET /stage/:code, which it must not
  // shadow.
  router.use('/stage/:code/quiz', createQuizRouter(deps));

  return router;
}
