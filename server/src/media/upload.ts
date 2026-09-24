// POST /api/manager/recordings — a manager adds a call recording or a screen
// recording to a stage (S06 task 6).
//
// The body IS the file. There is no multipart parser and no upload library:
// the browser sends the bytes raw with the file's own Content-Type, and the
// few text fields travel as query parameters (or x-academy-* headers, which
// is what a curl upload finds easier). That keeps a 500 MB video streaming
// straight through to disk with nothing buffered in memory and no new
// dependency in the request path.
//
// Order of work, and it matters:
//   1. authorise (requireAuth + requireRole MANAGER, behind ACADEMY_V2);
//   2. resolve the media type from the Content-Type -> 415 if we don't take it;
//   3. stream the body to a temporary file OUTSIDE the repo and outside
//      MEDIA_ROOT, counting bytes -> 413 the moment it passes the limit;
//   4. probe the duration with music-metadata; bytes that cannot be parsed as
//      the type they claim are 415, and nothing has entered the store yet;
//   5. put the object in the media store (atomic rename inside the store);
//   6. write the call_recordings row (uploaded_by = this manager) and the
//      MEDIA_UPLOADED audit row;
//   7. queue transcription + draft questions for the new recordingId.
//
// The temporary file is always removed, on every path.

import { createHash, randomUUID } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Router } from 'express';
import type { Request, Response } from 'express';
import type { Pool } from 'pg';
import { parseFile } from 'music-metadata';
import { ManagerUploadResponseSchema } from '@fac-academy/shared';
import type { ManagerUploadResponse, MediaErrorCode } from '@fac-academy/shared';
import { createMediaProducers } from '../jobs/mediaJobs.js';
import { requireAcademyFlag } from '../middleware/flag.js';
import { authOf, requireAuth, requireRole } from '../middleware/auth.js';
import type { RequireAuthDeps } from '../middleware/auth.js';
import { actor, writeAudit } from '../modules/audit/audit.js';
import type { SessionManager } from '../modules/auth/sessions.js';
import type { JobQueue } from '../queues/queue.js';
import type { MediaStore } from './store.js';

export interface MediaUploadDeps extends RequireAuthDeps {
  db: Pool;
  sessions: SessionManager;
  store: MediaStore;
  queue: JobQueue;
  /** MEDIA_MAX_UPLOAD_MB, already in bytes. */
  maxUploadBytes: number;
  /**
   * ACADEMY_V2. createApp already gates every /api route, so this is only for
   * a router mounted on its own (a test, or a future stand-alone mount).
   */
  flagEnabled?: boolean;
  /** Where the body is spooled before it is stored. Defaults to the OS temp dir. */
  tempDir?: string;
}

// ---------------------------------------------------------------------------
// Accepted types
// ---------------------------------------------------------------------------

export interface UploadType {
  extension: string;
  /** The type we store and later serve, normalised (audio/mp3 -> audio/mpeg). */
  contentType: string;
  mediaType: 'AUDIO' | 'VIDEO';
}

const MP3: UploadType = { extension: '.mp3', contentType: 'audio/mpeg', mediaType: 'AUDIO' };
const M4A: UploadType = { extension: '.m4a', contentType: 'audio/mp4', mediaType: 'AUDIO' };
const WAV: UploadType = { extension: '.wav', contentType: 'audio/wav', mediaType: 'AUDIO' };
const MP4: UploadType = { extension: '.mp4', contentType: 'video/mp4', mediaType: 'VIDEO' };

/**
 * Every spelling a browser or a phone recorder puts on these four formats.
 * Anything not in here is 415: the academy takes mp3, m4a, wav and mp4 only
 * (SECTION-11), and there is no ffmpeg on the server to convert the rest.
 */
const TYPES_BY_CONTENT_TYPE = new Map<string, UploadType>([
  ['audio/mpeg', MP3],
  ['audio/mp3', MP3],
  ['audio/x-mp3', MP3],
  ['audio/mp4', M4A],
  ['audio/m4a', M4A],
  ['audio/x-m4a', M4A],
  ['audio/aac', M4A],
  ['audio/wav', WAV],
  ['audio/wave', WAV],
  ['audio/x-wav', WAV],
  ['audio/vnd.wave', WAV],
  ['video/mp4', MP4],
]);

/** The `mediaType` field: a plain extension, for a client that cannot set Content-Type. */
const TYPES_BY_NAME = new Map<string, UploadType>([
  ['mp3', MP3],
  ['m4a', M4A],
  ['wav', WAV],
  ['mp4', MP4],
]);

export function resolveUploadType(
  contentType: string | undefined,
  mediaTypeField: string | undefined,
): UploadType | null {
  const declared = (contentType ?? '').split(';')[0]?.trim().toLowerCase() ?? '';
  const byContentType = TYPES_BY_CONTENT_TYPE.get(declared);
  if (byContentType !== undefined) return byContentType;
  // A generic or missing Content-Type is allowed only with an explicit field.
  if (declared === '' || declared === 'application/octet-stream') {
    const name = (mediaTypeField ?? '').trim().toLowerCase().replace(/^\./, '');
    return TYPES_BY_NAME.get(name) ?? null;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Fields
// ---------------------------------------------------------------------------

const STAGE_CODE_RE = /^[A-Za-z0-9_-]{1,32}$/;

export interface UploadFields {
  stageCode: string;
  title: string;
  description: string | null;
  mediaTypeField: string | undefined;
}

/** A field from the query string, else from its x-academy-* header. */
function field(req: Request, name: string, header: string): string | undefined {
  const fromQuery = req.query[name];
  if (typeof fromQuery === 'string') return fromQuery;
  const fromHeader = req.get(header);
  return typeof fromHeader === 'string' ? fromHeader : undefined;
}

export function readFields(req: Request): UploadFields | null {
  const stageCode = field(req, 'stageCode', 'x-academy-stage')?.trim() ?? '';
  const title = field(req, 'title', 'x-academy-title')?.trim() ?? '';
  const description = field(req, 'description', 'x-academy-description')?.trim() ?? '';
  if (!STAGE_CODE_RE.test(stageCode)) return null;
  if (title.length === 0 || title.length > 200) return null;
  if (description.length > 1000) return null;
  return {
    stageCode,
    title,
    description: description === '' ? null : description,
    mediaTypeField: field(req, 'mediaType', 'x-academy-media-type'),
  };
}

/** `academy/media/<slug>-<8 hex of sha256><ext>`: content-addressed, never a path. */
export function uploadKey(title: string, sha256: string, extension: string): string {
  const slug =
    title
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 40)
      .replace(/-+$/, '') || 'recording';
  return `academy/media/${slug}-${sha256.slice(0, 8)}${extension}`;
}

// ---------------------------------------------------------------------------
// Receiving the body
// ---------------------------------------------------------------------------

class TooLargeError extends Error {
  override name = 'TooLargeError';
}

export interface Received {
  bytes: number;
  sha256: string;
}

/**
 * Streams the request body to `file`, hashing as it goes and stopping the
 * moment it passes `maxBytes`. Nothing is buffered: the biggest thing in
 * memory is one chunk.
 */
async function receiveToFile(req: Request, file: string, maxBytes: number): Promise<Received> {
  const out = createWriteStream(file, { flags: 'wx' });
  const hash = createHash('sha256');
  let bytes = 0;

  await new Promise<void>((resolve, reject) => {
    const stop = (err: Error): void => {
      req.off('data', onData);
      req.off('end', onEnd);
      out.destroy();
      reject(err);
    };
    const onData = (chunk: Buffer): void => {
      bytes += chunk.byteLength;
      if (bytes > maxBytes) {
        stop(new TooLargeError());
        return;
      }
      hash.update(chunk);
      if (!out.write(chunk)) {
        req.pause();
        out.once('drain', () => req.resume());
      }
    };
    const onEnd = (): void => {
      out.end();
    };
    req.on('data', onData);
    req.once('end', onEnd);
    req.once('error', stop);
    req.once('aborted', () => stop(new Error('the upload was aborted')));
    out.once('error', stop);
    out.once('finish', resolve);
  });

  return { bytes, sha256: hash.digest('hex') };
}

// ---------------------------------------------------------------------------
// The route
// ---------------------------------------------------------------------------

function fail(res: Response, status: number, error: MediaErrorCode): void {
  res.status(status).json({ error });
}

interface StageRow {
  id: string;
  dept: string | null;
}

async function insertRecording(
  db: Pool,
  args: {
    stage: StageRow;
    fields: UploadFields;
    type: UploadType;
    mediaKey: string;
    byteSize: number;
    durationSecs: number;
    sha256: string;
    managerId: number;
  },
): Promise<number> {
  const category = await db
    .query<{ category: string }>(
      `SELECT category FROM academy.call_recordings
        WHERE stage_id = $1 GROUP BY category ORDER BY count(*) DESC LIMIT 1`,
      [args.stage.id],
    )
    .then((r) => r.rows[0]?.category ?? (args.stage.dept === null ? 'INDUCTION' : 'DEPARTMENT'));

  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO academy.call_recordings
       (stage_id, position, category, title, description, media_key, duration_secs, media_type,
        byte_size, content_type, checksum_sha256, uploaded_by, uploaded_at, transcript_status)
     VALUES ($1,
             (SELECT COALESCE(max(position), 0) + 1 FROM academy.call_recordings WHERE stage_id = $1),
             $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, now(), 'PENDING')
     RETURNING id::text AS id`,
    [
      args.stage.id,
      category,
      args.fields.title,
      args.fields.description,
      args.mediaKey,
      args.durationSecs,
      args.type.mediaType,
      args.byteSize,
      args.type.contentType,
      args.sha256,
      args.managerId,
    ],
  );
  const id = rows[0]?.id;
  if (id === undefined) throw new Error('the recording row was not created');
  return Number(id);
}

export function managerUploadRouter(deps: MediaUploadDeps): Router {
  const router = Router();
  const { db, store, queue } = deps;
  const producers = createMediaProducers(queue);
  const tempRoot = deps.tempDir ?? path.join(tmpdir(), 'academy-uploads');

  // Deliberately route-level, not router.use: this router shares the
  // /api/manager prefix with the S07 manager router, and a request for any
  // other manager route must fall straight through without paying for a
  // second session lookup.
  const guards = [
    ...(deps.flagEnabled === undefined ? [] : [requireAcademyFlag(deps.flagEnabled)]),
    requireAuth(deps),
    requireRole('MANAGER'),
  ];

  router.post('/recordings', ...guards, async (req: Request, res: Response) => {
    const manager = authOf(req);
    const fields = readFields(req);
    if (fields === null) {
      fail(res, 400, 'invalid_request');
      return;
    }
    const type = resolveUploadType(req.get('content-type'), fields.mediaTypeField);
    if (type === null) {
      fail(res, 415, 'unsupported_type');
      return;
    }
    // A declared length over the limit is refused before a byte is read.
    const declaredLength = Number(req.get('content-length') ?? '0');
    if (Number.isFinite(declaredLength) && declaredLength > deps.maxUploadBytes) {
      fail(res, 413, 'too_large');
      return;
    }
    const { rows } = await db.query<StageRow>(
      'SELECT id::text AS id, dept FROM academy.stages WHERE code = $1',
      [fields.stageCode],
    );
    const stage = rows[0];
    if (stage === undefined) {
      fail(res, 404, 'not_found');
      return;
    }

    await mkdir(tempRoot, { recursive: true });
    const temp = path.join(tempRoot, `${randomUUID()}${type.extension}`);
    try {
      let received: Received;
      try {
        received = await receiveToFile(req, temp, deps.maxUploadBytes);
      } catch (err) {
        if (err instanceof TooLargeError) {
          fail(res, 413, 'too_large');
          return;
        }
        throw err;
      }
      if (received.bytes === 0) {
        fail(res, 400, 'invalid_request');
        return;
      }

      // Bytes that cannot be read as the type they claim are not that type.
      const durationSecs = await probeDuration(temp);
      if (durationSecs === null) {
        fail(res, 415, 'unsupported_type');
        return;
      }

      const mediaKey = uploadKey(fields.title, received.sha256, type.extension);
      const put = await store.put(mediaKey, createReadStream(temp), {
        contentType: type.contentType,
      });

      const recordingId = await insertRecording(db, {
        stage,
        fields,
        type,
        mediaKey,
        byteSize: put.size,
        durationSecs,
        sha256: put.sha256,
        managerId: manager.traineeId,
      });

      await writeAudit(db, {
        traineeId: manager.traineeId,
        eventType: 'MEDIA_UPLOADED',
        actor: actor.manager(manager.traineeId),
        // Ids, codes and file facts only: no trainee name, no client detail.
        // `stage`, not `stageCode`: the audit scrubber redacts any key with
        // 'code' in it (it is looking for authenticator codes).
        payload: {
          recordingId,
          stage: fields.stageCode,
          mediaKey,
          byteSize: put.size,
          durationSecs,
          contentType: type.contentType,
          checksumSha256: put.sha256,
        },
      });

      // The two pieces of follow-up work. Drafted questions are never live.
      await producers.enqueueTranscription({
        recordingId,
        mediaKey,
        contentType: type.contentType,
        durationSecs,
      });
      await producers.enqueueQuestionGen({
        recordingId,
        stageId: Number(stage.id),
        approvalState: 'DRAFT',
      });

      const body: ManagerUploadResponse = ManagerUploadResponseSchema.parse({
        recordingId,
        mediaKey,
        byteSize: put.size,
        durationSecs,
        contentType: type.contentType,
      });
      res.status(201).json(body);
    } finally {
      await rm(temp, { force: true }).catch(() => undefined);
    }
  });

  return router;
}

/** Whole seconds, or null when music-metadata cannot read the file. */
async function probeDuration(file: string): Promise<number | null> {
  try {
    const meta = await parseFile(file, { duration: true });
    const seconds = meta.format.duration;
    if (seconds === undefined || !Number.isFinite(seconds) || seconds <= 0) return null;
    // duration_secs is a positive INT: never round a short clip down to zero.
    return Math.max(1, Math.round(seconds));
  } catch {
    return null; // message withheld: it can quote the file's own bytes
  }
}
