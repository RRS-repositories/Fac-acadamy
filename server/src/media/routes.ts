import { Router } from 'express';
import type { Request, Response } from 'express';
import { LockedResponseSchema, MediaErrorSchema } from '@fac-academy/shared';
import type { MediaErrorCode } from '@fac-academy/shared';
import { authOf, requireAuth } from '../middleware/auth.js';
import { actor, writeAudit } from '../modules/audit/audit.js';
import { gate } from '../modules/training/gate.js';
import type { GateDenial } from '../modules/training/gate.js';
import { loadGatedRecording } from '../modules/training/recordings.js';
import type { TrainingDeps } from '../modules/training/repo.js';
import { MediaKeyError, contentTypeForKey } from './store.js';
import type { MediaStore } from './store.js';

// GET /api/media/:recordingId/stream — the ONLY way a recording or the video
// reaches a browser (decision D15: there is no S3 and no signed URL).
//
// Every byte passes through here, which means every byte is behind:
//   1. the ACADEMY_V2 flag (app.ts mounts the flag gate on /api first),
//   2. requireAuth — no session, no media, and a disabled account is cut off
//      on its very next request,
//   3. the one gate() — a locked stage's recording is refused even to a
//      signed-in trainee, with the same 403 shape the training routes use,
//   4. assertSafeKey inside the store — a crafted key is refused before any
//      filesystem call, so no request can read a file outside MEDIA_ROOT.
//
// MEDIA_ROOT is not served by nginx, so there is no second door.

/** One audit row per session per recording per hour: see createAuditMemory. */
export const AUDIT_WINDOW_MS = 60 * 60 * 1000;
const AUDIT_MEMORY_LIMIT = 5_000;

/** The training dependencies plus the store the bytes come out of. */
export interface MediaStreamDeps extends TrainingDeps {
  store: MediaStore;
}

/**
 * A trainee watching a 19-minute video sends dozens of Range requests, and a
 * browser re-opens the stream on every seek. Auditing each one would bury the
 * rows that matter, so the FIRST request for a recording in a session is
 * audited and the rest are quiet for an hour.
 *
 * The memory is per process, which is the right trade here: the API is a
 * single pm2 process, and the worst a restart costs is one extra audit row.
 * Nothing about access control depends on it.
 */
function createAuditMemory(now: () => number) {
  const seen = new Map<string, number>();
  return function shouldAudit(sessionId: string, recordingId: number): boolean {
    const at = now();
    const key = `${sessionId}:${String(recordingId)}`;
    const last = seen.get(key);
    if (last !== undefined && at - last < AUDIT_WINDOW_MS) return false;
    // Cheap eviction: drop what has aged out, then, if it is still full, the
    // oldest quarter. A busy day can never grow the map without end.
    if (seen.size >= AUDIT_MEMORY_LIMIT) {
      for (const [k, t] of seen) if (at - t >= AUDIT_WINDOW_MS) seen.delete(k);
      if (seen.size >= AUDIT_MEMORY_LIMIT) {
        const oldest = [...seen.entries()].sort((a, b) => a[1] - b[1]);
        for (const [k] of oldest.slice(0, Math.ceil(AUDIT_MEMORY_LIMIT / 4))) seen.delete(k);
      }
    }
    seen.set(key, at);
    return true;
  };
}

// ---------------------------------------------------------------------------
// Range header
// ---------------------------------------------------------------------------

export type ParsedRange =
  { kind: 'none' } | { kind: 'unsatisfiable' } | { kind: 'range'; start: number; end: number };

/**
 * A single byte range against a known size, per RFC 9110 §14.
 *
 *   bytes=10-19   the tenth to the nineteenth byte, both ends included
 *   bytes=10-     from the tenth byte to the end
 *   bytes=-500    the last 500 bytes
 *
 * Anything we do not handle — a header we cannot parse, a unit other than
 * bytes, more than one range — is treated as no range at all, which the RFC
 * allows and which means the whole file is sent. A range that starts past the
 * end of the file is 'unsatisfiable', and the caller answers 416.
 */
export function parseRange(header: string | undefined, size: number): ParsedRange {
  if (header === undefined) return { kind: 'none' };
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (match === null) return { kind: 'none' };
  const rawStart = match[1] ?? '';
  const rawEnd = match[2] ?? '';
  if (rawStart === '' && rawEnd === '') return { kind: 'none' };
  if (size === 0) return { kind: 'unsatisfiable' };

  let start: number;
  let end: number;
  if (rawStart === '') {
    // Suffix: the last N bytes. 'bytes=-0' asks for nothing, which cannot be
    // satisfied; asking for more than the file holds means the whole file.
    const suffix = Number(rawEnd);
    if (suffix === 0) return { kind: 'unsatisfiable' };
    start = Math.max(0, size - suffix);
    end = size - 1;
  } else {
    start = Number(rawStart);
    if (start >= size) return { kind: 'unsatisfiable' };
    end = rawEnd === '' ? size - 1 : Math.min(Number(rawEnd), size - 1);
    if (end < start) return { kind: 'unsatisfiable' };
  }
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end)) return { kind: 'unsatisfiable' };
  return { kind: 'range', start, end };
}

// ---------------------------------------------------------------------------
// Replies
// ---------------------------------------------------------------------------

function fail(res: Response, status: number, error: MediaErrorCode): void {
  res.status(status).json(MediaErrorSchema.parse({ error }));
}

/**
 * 403 for a locked stage, in the same shape the training routes use, so the
 * client has one handler for every lock. `requires` is the stage code they
 * must pass first, or null when the missing piece is their track (D13).
 */
function locked(res: Response, requires: string | null): void {
  res.status(403).json(LockedResponseSchema.parse({ error: 'locked', requires }));
}

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
      // A stage on another track is never acknowledged, locked or not.
      fail(res, 404, 'not_found');
      return;
  }
}

/** A client that closed the tab mid-stream is normal, not something to log. */
function isDisconnect(err: unknown): boolean {
  const code = (err as { code?: unknown } | null)?.code;
  return (
    code === 'ERR_STREAM_PREMATURE_CLOSE' ||
    code === 'ERR_STREAM_DESTROYED' ||
    code === 'EPIPE' ||
    code === 'ECONNRESET'
  );
}

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

export function mediaStreamRouter(deps: MediaStreamDeps): Router {
  const router = Router();
  const now = deps.now ?? Date.now;
  const shouldAudit = createAuditMemory(now);

  router.use(requireAuth(deps));

  // Express routes HEAD to the GET handler when there is no HEAD route, so a
  // player can ask for the size and the type without pulling the file.
  router.get('/:recordingId/stream', async (req: Request, res: Response) => {
    const { traineeId, sessionId } = authOf(req);

    const recordingId = Number(req.params.recordingId);
    if (!Number.isSafeInteger(recordingId) || recordingId <= 0) {
      fail(res, 404, 'not_found');
      return;
    }

    // No such row, withdrawn, or a library item with no stage: all answered
    // the same way, because telling them apart would leak what the library
    // holds.
    const recording = await loadGatedRecording(deps.db, recordingId);
    if (recording === null) {
      fail(res, 404, 'not_found');
      return;
    }

    // THE gate, before anything about the file is revealed — a locked stage
    // does not even disclose whether its recordings have been made yet.
    const allowed = await gate(deps.db, traineeId, recording.stageCode, {
      stage1AuthRequired: deps.stage1AuthRequired,
    });
    if (!allowed.allowed) {
      denied(res, allowed.reason, allowed.requires);
      return;
    }

    // D4: a "coming soon" slot is a normal row with no media. It is not an
    // error and it never blocks anything; there is simply nothing to send.
    if (recording.mediaKey === null) {
      fail(res, 404, 'not_found');
      return;
    }
    const mediaKey = recording.mediaKey;

    let stats;
    try {
      // stat() runs assertSafeKey first, so a crafted key never reaches the
      // filesystem at all.
      stats = await deps.store.stat(mediaKey);
    } catch (err) {
      if (err instanceof MediaKeyError) {
        // A key that breaks the rules got into the database somehow (migration
        // 0005 has the same rule as a CHECK). Refuse it, tell the client
        // nothing, and leave a line for whoever looks.
        console.warn(
          `[academy-api] recording ${String(recordingId)} has an unusable media key: ${err.message}`,
        );
        fail(res, 404, 'not_found');
        return;
      }
      throw err;
    }
    if (stats === null) {
      // The row says there is a file and the disk disagrees: an upload that
      // did not finish, or a restore that missed MEDIA_ROOT (D15 warns that
      // backups must include it). The trainee sees "nothing there"; we log it.
      console.warn(
        `[academy-api] recording ${String(recordingId)}: media file missing from MEDIA_ROOT`,
      );
      fail(res, 404, 'not_found');
      return;
    }

    const range = parseRange(req.header('range'), stats.size);

    res.setHeader('Accept-Ranges', 'bytes');
    // Training media is per-person and access-checked on every request, so no
    // shared cache and no disk copy may keep a copy of it.
    res.setHeader('Cache-Control', 'private, no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');

    if (range.kind === 'unsatisfiable') {
      res.setHeader('Content-Range', `bytes */${String(stats.size)}`);
      res.status(416).end();
      return;
    }

    // First stream of this recording in this session (at most one an hour):
    // one audit row, written before a byte goes out. A failure here must never
    // cost the trainee their recording, so it is logged and shrugged off.
    if (shouldAudit(sessionId, recordingId)) {
      try {
        await writeAudit(deps.db, {
          traineeId,
          eventType: 'MEDIA_STREAM',
          actor: actor.trainee(traineeId),
          payload: {
            recordingId,
            stage: recording.stageCode,
            mediaType: recording.mediaType,
            bytes: stats.size,
          },
        });
      } catch (err) {
        console.error('[academy-api] could not write the MEDIA_STREAM audit row:', err);
      }
    }

    const start = range.kind === 'range' ? range.start : 0;
    const end = range.kind === 'range' ? range.end : stats.size - 1;
    const length = stats.size === 0 ? 0 : end - start + 1;

    // The type is the one recorded at upload from the file's own bytes, never
    // anything the client asked for. contentTypeForKey is only the fallback,
    // for a slot seeded before the upload script filled content_type in.
    res.setHeader('Content-Type', recording.contentType ?? contentTypeForKey(mediaKey));
    res.setHeader('Content-Length', String(length));
    if (range.kind === 'range') {
      res.setHeader('Content-Range', `bytes ${String(start)}-${String(end)}/${String(stats.size)}`);
      res.status(206);
    } else {
      res.status(200);
    }

    // HEAD: the headers above are the whole answer.
    if (req.method === 'HEAD' || length === 0) {
      res.end();
      return;
    }

    const stream =
      range.kind === 'range'
        ? await deps.store.openRange(mediaKey, { start, end })
        : await deps.store.openRange(mediaKey);

    // Someone closing the tab, or seeking elsewhere, aborts the response. Let
    // go of the file handle straight away and do not shout about it.
    res.on('close', () => {
      if (!res.writableEnded) stream.destroy();
    });
    stream.on('error', (err: unknown) => {
      if (!isDisconnect(err)) {
        console.error(`[academy-api] streaming recording ${String(recordingId)} failed:`, err);
      }
      // The headers are already out, so the only honest signal left is a
      // broken connection, which is what destroying the socket gives.
      res.destroy();
    });
    stream.pipe(res);
  });

  return router;
}
