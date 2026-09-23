import { Router } from 'express';
import { StatusGuideResponseSchema } from '@fac-academy/shared';
import type { StatusGuideRow } from '@fac-academy/shared';
import type { Db, TrainingDeps } from './repo.js';

// GET /api/status-guide (S05): the reference table behind the Status Guide
// page. Mounted inside the training router, so it is already behind
// requireAuth and the ACADEMY_V2 flag gate in app.ts.
//
// No gate() call here: the Status Guide is reference material for the whole
// firm, not stage content, so every signed-in trainee may read it whatever
// their track or progress. It carries no answers and no lesson HTML.

/** Every status_guide row, in display order. */
export async function loadStatusGuide(db: Db): Promise<StatusGuideRow[]> {
  const { rows } = await db.query<{ status: string; client_line: string; sort: number }>(
    `SELECT status, client_line, sort::int AS sort
       FROM academy.status_guide
      ORDER BY sort`,
  );
  return rows.map((r) => ({ status: r.status, clientLine: r.client_line, sort: r.sort }));
}

export function statusGuideRouter(deps: TrainingDeps): Router {
  const router = Router();

  router.get('/', async (_req, res) => {
    // Reference data, the same for everyone, but it still goes only to a
    // signed-in browser: no shared cache may hold it.
    res.set('Cache-Control', 'private, no-store');
    res.status(200).json(StatusGuideResponseSchema.parse({ rows: await loadStatusGuide(deps.db) }));
  });

  return router;
}
