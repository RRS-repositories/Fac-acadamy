import { Router } from 'express';
import type { Request, Response } from 'express';
import { MediaErrorSchema, VideoLibraryResponseSchema } from '@fac-academy/shared';
import type { MediaErrorCode } from '@fac-academy/shared';
import { authOf, requireAuth } from '../middleware/auth.js';
import { actor, writeAudit } from '../modules/audit/audit.js';
import { listLibraryVideos, loadLibraryRecording } from '../modules/training/recordings.js';
import type { MediaStreamDeps } from './routes.js';
import { parseRange } from './routes.js';
import { MediaKeyError, contentTypeForKey } from './store.js';

// The video library (user decision, 19 Oct):
//
//   GET /api/videos                 the shelf
//   GET /api/videos/:videoId/stream the bytes of one video on it
//
// A video is on the shelf exactly when its call_recordings row has no stage.
// `stage_id` was already nullable — 0001 calls a row with no stage an
// "unassigned library item" in so many words — so there is no new column, no new
// table and no migration here. A recording either belongs to a stage or it is on
// the shelf, and the two are mutually exclusive by construction.
//
// WHY THIS IS ITS OWN ROUTER, AND NOT A LOOSENING OF THE STREAM ROUTE
//
// /api/media/:recordingId/stream runs gate() against the recording's stage.
// There is no stage here, so there is nothing for gate() to check and no honest
// stage code to hand it. The temptation is to make the gated route skip the gate
// when the stage is missing; that is the one change nobody should make, because
// it turns the single statement "every byte on this path has been gated" into a
// statement with an exception in it, and an exception is a thing to get wrong.
// Instead the gated route's own lookup (loadGatedRecording) inner-joins
// academy.stages and so answers 404 for a stage-less row — see the comment at
// media/routes.ts where it is called — and the library gets this separate
// router, with its own lookup that can only ever return a stage-less row.
//
// Both halves of that pair matter, and both are pinned by tests:
// a locked stage's recording is unreachable HERE (loadLibraryRecording requires
// stage_id IS NULL), and a library video is unreachable THERE.
//
// WHAT THIS PATH STILL ENFORCES
//
//   1. the ACADEMY_V2 flag — app.ts mounts the flag gate on /api before this
//      router, so a switched-off academy answers 503 here like everywhere else,
//   2. requireAuth — no session, no shelf. The library is unlocked, which is not
//      the same as public: it is internal training material and a disabled
//      account is cut off on its very next request,
//   3. assertSafeKey inside the store — a crafted key is refused before any
//      filesystem call, so no request can read a file outside MEDIA_ROOT.
//
// WHAT IT DELIBERATELY DOES NOT DO
//
// There is no beacon route here and no write to academy.listen_progress, by
// design and not by omission. Watching a library video earns no credit towards
// any stage's listening requirement, so the shelf can never become a way around
// the no-skip player: there is simply no statement on this path that could pay a
// gate. The streaming handler below reads; it writes one audit row and nothing
// else.

/** One audit row per session per video per hour: see createAuditMemory. */
export const LIBRARY_AUDIT_WINDOW_MS = 60 * 60 * 1000;
const AUDIT_MEMORY_LIMIT = 5_000;

/**
 * The same quiet-period trick the stream route uses, and for the same reason: a
 * browser fetches a 25 MB video in dozens of Range requests and re-opens the
 * stream on every seek, so auditing each one would bury the rows that matter.
 * The first request for a video in a session is audited and the rest are quiet
 * for an hour.
 *
 * Its own map rather than the stream route's: the two paths are separate on
 * purpose, and sharing state would mean the gated route had to be edited to
 * hand it over. One map per router also means a trainee who plays a library
 * video is still audited the first time they open a stage recording, instead of
 * one path's bookkeeping silencing the other's.
 *
 * Per process, which is the right trade here: the API is a single pm2 process
 * and the worst a restart costs is one extra audit row. Nothing about access
 * control depends on it.
 */
function createAuditMemory(now: () => number) {
  const seen = new Map<string, number>();
  return function shouldAudit(sessionId: string, videoId: number): boolean {
    const at = now();
    const key = `${sessionId}:${String(videoId)}`;
    const last = seen.get(key);
    if (last !== undefined && at - last < LIBRARY_AUDIT_WINDOW_MS) return false;
    // Cheap eviction: drop what has aged out, then, if it is still full, the
    // oldest quarter. A busy day can never grow the map without end.
    if (seen.size >= AUDIT_MEMORY_LIMIT) {
      for (const [k, t] of seen) if (at - t >= LIBRARY_AUDIT_WINDOW_MS) seen.delete(k);
      if (seen.size >= AUDIT_MEMORY_LIMIT) {
        const oldest = [...seen.entries()].sort((a, b) => a[1] - b[1]);
        for (const [k] of oldest.slice(0, Math.ceil(AUDIT_MEMORY_LIMIT / 4))) seen.delete(k);
      }
    }
    seen.set(key, at);
    return true;
  };
}

function fail(res: Response, status: number, error: MediaErrorCode): void {
  res.status(status).json(MediaErrorSchema.parse({ error }));
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

export function videoLibraryRouter(deps: MediaStreamDeps): Router {
  const router = Router();
  const now = deps.now ?? Date.now;
  const shouldAudit = createAuditMemory(now);

  router.use(requireAuth(deps));

  /**
   * The shelf. Titles, descriptions and lengths — nothing else, because
   * VideoLibraryResponseSchema holds nothing else: no media key, no file size,
   * no content type and no stage (there is none). Parsed through the contract on
   * the way out so a column added to the table later cannot leak by accident.
   *
   * No lock, no gate, no per-trainee filtering: every signed-in trainee sees the
   * same shelf. That is what "belongs to no stage" means — there is no stage
   * whose lock could hide one of these, and nothing here is track-specific.
   */
  router.get('/', async (_req: Request, res: Response) => {
    const videos = await listLibraryVideos(deps.db);
    // Internal training material, access-checked on every request: no shared
    // cache and no disk copy may keep it, exactly as for the stream itself.
    res.setHeader('Cache-Control', 'private, no-store');
    res.status(200).json(VideoLibraryResponseSchema.parse({ videos }));
  });

  // Express routes HEAD to the GET handler when there is no HEAD route, so a
  // player can ask for the size and the type without pulling the file.
  router.get('/:videoId/stream', async (req: Request, res: Response) => {
    const { traineeId, sessionId } = authOf(req);

    const videoId = Number(req.params.videoId);
    if (!Number.isSafeInteger(videoId) || videoId <= 0) {
      fail(res, 404, 'not_found');
      return;
    }

    // Not on the shelf: no such row, withdrawn, an empty slot, stage-less audio,
    // or — the case this is really here for — a recording that belongs to a
    // stage, locked or not. All one answer, because telling them apart would
    // confirm which ids are stage content.
    const video = await loadLibraryRecording(deps.db, videoId);
    if (video === null) {
      fail(res, 404, 'not_found');
      return;
    }
    const { mediaKey } = video;

    let stats;
    try {
      // stat() runs assertSafeKey first, so a crafted key never reaches the
      // filesystem at all.
      stats = await deps.store.stat(mediaKey);
    } catch (err) {
      if (err instanceof MediaKeyError) {
        // A key that breaks the rules got into the database somehow (migration
        // 0005 has the same rule as a CHECK). Refuse it, tell the client
        // nothing, and leave a line for whoever looks. The message names the
        // reason, never the key and never the resolved path.
        console.warn(
          `[academy-api] library video ${String(videoId)} has an unusable media key: ${err.message}`,
        );
        fail(res, 404, 'not_found');
        return;
      }
      throw err;
    }
    if (stats === null) {
      // The row says there is a file and the disk disagrees: an upload that did
      // not finish, or a restore that missed MEDIA_ROOT (D15 warns that backups
      // must include it). The trainee sees "nothing there"; we log it.
      console.warn(
        `[academy-api] library video ${String(videoId)}: media file missing from MEDIA_ROOT`,
      );
      fail(res, 404, 'not_found');
      return;
    }

    const range = parseRange(req.header('range'), stats.size);

    res.setHeader('Accept-Ranges', 'bytes');
    // Internal training material, access-checked on every request, so no shared
    // cache and no disk copy may keep a copy of it.
    res.setHeader('Cache-Control', 'private, no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');

    if (range.kind === 'unsatisfiable') {
      res.setHeader('Content-Range', `bytes */${String(stats.size)}`);
      res.status(416).end();
      return;
    }

    // First stream of this video in this session (at most one an hour): one
    // audit row, written before a byte goes out. A failure here must never cost
    // the trainee their video, so it is logged and shrugged off.
    //
    // MEDIA_STREAM, the same event the gated route writes, so one query over the
    // trail still answers "what has this person watched". `stage` is null and
    // `library` is true, which is how the two are told apart — a null stage on a
    // MEDIA_STREAM row is a fact about the shelf, not a missing value.
    if (shouldAudit(sessionId, videoId)) {
      try {
        await writeAudit(deps.db, {
          traineeId,
          eventType: 'MEDIA_STREAM',
          actor: actor.trainee(traineeId),
          payload: {
            recordingId: videoId,
            stage: null,
            library: true,
            mediaType: 'VIDEO',
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
    // anything the client asked for. contentTypeForKey is only the fallback, for
    // a row seeded before the upload script filled content_type in.
    res.setHeader('Content-Type', video.contentType ?? contentTypeForKey(mediaKey));
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

    // Someone closing the tab, or seeking elsewhere, aborts the response. Let go
    // of the file handle straight away and do not shout about it.
    res.on('close', () => {
      if (!res.writableEnded) stream.destroy();
    });
    stream.on('error', (err: unknown) => {
      if (!isDisconnect(err)) {
        console.error(`[academy-api] streaming library video ${String(videoId)} failed:`, err);
      }
      // The headers are already out, so the only honest signal left is a broken
      // connection, which is what destroying the socket gives.
      res.destroy();
    });
    stream.pipe(res);
  });

  return router;
}
