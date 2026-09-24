import { Router } from 'express';
import type { Response } from 'express';
import { RateLimiterMemory } from 'rate-limiter-flexible';
import { MEDIA_BEACON_INTERVAL_MS, MediaProgressRequestSchema } from '@fac-academy/shared';
import type { MediaErrorCode, MediaProgressResponse } from '@fac-academy/shared';
import { authOf, requireAuth } from '../middleware/auth.js';
import { actor, writeAudit } from '../modules/audit/audit.js';
import { gate } from '../modules/training/gate.js';
import { loadGatedRecording } from '../modules/training/recordings.js';
import type { Db, TrainingDeps } from '../modules/training/repo.js';
import { applyBeacon, coveredSecs, parseCoverage, requiredSecs } from './coverage.js';
import type { Interval, ListenState } from './coverage.js';

// POST /api/media/:recordingId/progress — the listening beacon (S06).
//
// The player posts the stretches it has played; this route decides what that
// is worth. It is the same shape as every other content route: requireAuth,
// then gate() on the recording's stage, then the server's own arithmetic. The
// client's "listened" badge is whatever comes back in the response — nothing
// in the browser can set it.
//
// Audit: LISTEN_COMPLETE is written ONCE, inside the transaction that first
// flips completed_at. A row per beacon would put tens of thousands of rows a
// day into an append-only table and tell a reader nothing.

const RECORDING_ID = /^[0-9]{1,15}$/;

/**
 * A beacon every five seconds is two in ten; the flushes on pause, on resume
 * and at the end, and a retry after a dropped request, add a few more. Ten in
 * ten seconds leaves room for all of that and still refuses a flood. Per
 * (trainee, recording), so one busy player cannot rate-limit another.
 *
 * In memory on purpose. It is a politeness limit in front of a cheap upsert,
 * not a security control — the security control is the wall-clock budget in
 * coverage.ts, which no amount of beaconing can get around.
 */
export const BEACON_LIMIT = { points: 10, duration: 10 };

function fail(res: Response, status: number, error: MediaErrorCode): void {
  res.status(status).json({ error });
}

interface StoredProgress {
  coverage: Interval[];
  secondsHeard: number;
  lastBeaconAt: number | null;
  listened: boolean;
}

async function loadProgress(
  db: Db,
  traineeId: number,
  recordingId: number,
): Promise<StoredProgress> {
  const { rows } = await db.query<{
    coverage: unknown;
    seconds_heard: number;
    last_beacon_at: Date | null;
    completed_at: Date | null;
  }>(
    `SELECT coverage, seconds_heard, last_beacon_at, completed_at
       FROM academy.listen_progress
      WHERE trainee_id = $1 AND recording_id = $2`,
    [traineeId, recordingId],
  );
  const row = rows[0];
  if (row === undefined) {
    return { coverage: [], secondsHeard: 0, lastBeaconAt: null, listened: false };
  }
  const coverage = parseCoverage(row.coverage);
  return {
    coverage,
    secondsHeard: coveredSecs(coverage),
    lastBeaconAt: row.last_beacon_at === null ? null : row.last_beacon_at.getTime(),
    listened: row.completed_at !== null,
  };
}

export function mediaProgressRouter(deps: TrainingDeps): Router {
  const router = Router();
  const limiter = new RateLimiterMemory({ keyPrefix: 'academy-listen-beacon', ...BEACON_LIMIT });
  const now = deps.now ?? ((): number => Date.now());

  // requireAuth sits on the route, not on the router. /api/media carries the
  // streaming router as well, and a router-level guard here would re-check the
  // session for every one of a long video's Range requests on its way past.
  router.post('/:recordingId/progress', requireAuth(deps), async (req, res) => {
    const { traineeId } = authOf(req);
    const raw = String(req.params.recordingId ?? '');
    if (!RECORDING_ID.test(raw)) {
      fail(res, 400, 'invalid_request');
      return;
    }
    const recordingId = Number(raw);

    const body = MediaProgressRequestSchema.safeParse(req.body);
    if (!body.success) {
      fail(res, 400, 'invalid_request');
      return;
    }

    try {
      await limiter.consume(`${traineeId}:${recordingId}`);
    } catch (rejection) {
      if (rejection instanceof Error) throw rejection;
      res.set('Retry-After', String(Math.ceil(MEDIA_BEACON_INTERVAL_MS / 1000)));
      fail(res, 429, 'rate_limited');
      return;
    }

    // A "coming soon" slot has no media, so there is nothing to have listened
    // to; it answers exactly like a recording that does not exist (D4).
    const recording = await loadGatedRecording(deps.db, recordingId);
    if (recording === null || recording.mediaKey === null) {
      fail(res, 404, 'not_found');
      return;
    }

    // The same gate() as the stream endpoint and every other content route.
    const allowed = await gate(deps.db, traineeId, recording.stageCode, {
      stage1AuthRequired: deps.stage1AuthRequired,
    });
    if (!allowed.allowed) {
      // A stage on another track is never acknowledged, locked or not.
      if (allowed.reason === 'not_visible' || allowed.reason === 'not_found') {
        fail(res, 404, 'not_found');
        return;
      }
      // Same body as every other locked route: the client has one handler,
      // and `requires` names the stage they must pass first.
      res.status(403).json({ error: 'locked', requires: allowed.requires ?? null });
      return;
    }

    const payload = await recordBeacon(deps, {
      traineeId,
      recording,
      intervals: body.data.intervals,
      now: now(),
    });
    res.set('Cache-Control', 'no-store');
    res.status(200).json(payload);
  });

  return router;
}

interface BeaconInput {
  traineeId: number;
  recording: { id: number; title: string; stageCode: string; durationSecs: number | null };
  intervals: readonly (readonly [number, number])[];
  now: number;
}

/**
 * One beacon, one transaction.
 *
 * The stored coverage is read, merged and written back, so two beacons racing
 * each other must not read the same "before" and each write their own "after".
 * There is a row to lock only after the first beacon, so the transaction takes
 * a transaction-scoped advisory lock keyed on (trainee, recording) — the same
 * pattern the quiz submit uses, and for the same reason. It serialises one
 * trainee's beacons on one recording and nothing else.
 *
 * The write itself is a single upsert. `completed_at` is set with COALESCE so
 * a recording that is already listened keeps the time it was first finished.
 */
async function recordBeacon(
  deps: Pick<TrainingDeps, 'db'>,
  input: BeaconInput,
): Promise<MediaProgressResponse> {
  const { traineeId, recording } = input;
  const client = await deps.db.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [
      `academy.listen:${traineeId}:${recording.id}`,
    ]);

    const stored = await loadProgress(client, traineeId, recording.id);
    const state: ListenState = {
      coverage: stored.coverage,
      coveredSecs: stored.secondsHeard,
      lastBeaconAt: stored.lastBeaconAt,
      listened: stored.listened,
    };
    const next = applyBeacon(state, input.intervals, {
      now: input.now,
      durationSecs: recording.durationSecs,
    });

    await client.query(
      `INSERT INTO academy.listen_progress
         (trainee_id, recording_id, seconds_heard, coverage, last_beacon_at, completed_at)
       VALUES ($1, $2, $3, $4::jsonb, $5::timestamptz, $6::timestamptz)
       ON CONFLICT (trainee_id, recording_id) DO UPDATE
          SET seconds_heard  = EXCLUDED.seconds_heard,
              coverage       = EXCLUDED.coverage,
              last_beacon_at = EXCLUDED.last_beacon_at,
              completed_at   = COALESCE(academy.listen_progress.completed_at,
                                        EXCLUDED.completed_at)`,
      [
        traineeId,
        recording.id,
        Math.round(next.coveredSecs),
        JSON.stringify(next.coverage),
        new Date(input.now).toISOString(),
        next.listened ? new Date(input.now).toISOString() : null,
      ],
    );

    // Once, on the beacon that proves it — never one row per beacon.
    if (next.newlyListened) {
      await writeAudit(client, {
        traineeId,
        eventType: 'LISTEN_COMPLETE',
        actor: actor.trainee(traineeId),
        payload: {
          recordingId: recording.id,
          stage: recording.stageCode,
          coveredSecs: next.coveredSecs,
          durationSecs: recording.durationSecs,
        },
      });
    }

    await client.query('COMMIT');

    return {
      listened: next.listened,
      coveredSecs: next.coveredSecs,
      durationSecs: recording.durationSecs,
      requiredSecs: requiredSecs(recording.durationSecs),
    };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}
