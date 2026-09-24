// Shared plumbing for the two media CLIs in ops/media/:
//   * extract-media.ts — the 6 call MP3s embedded in the prototype (S06 task 1),
//   * ingest-media.ts  — one new file at a time (the S11 collection pipeline).
//
// Both write bytes into the LOCAL media store (server/src/media/store.ts,
// rooted at MEDIA_ROOT on the on-prem server — decision of 23 Sep: no S3) and
// then fill in the academy.call_recordings row.
//
// Data hygiene (CLAUDE.md): the prototype holds six REAL client call
// recordings. Nothing here ever writes audio inside the repo, and nothing
// here logs a transcript, a client or staff name, or any base64. The only
// content that reaches the console is a technical file name, a byte count,
// a duration and a checksum.
//
// Guards, in this order and before any socket is opened:
//   1. --expect-db is required and must NOT look like a production database
//      (a name containing 'prod' or 'live' is refused outright);
//   2. it must equal current_database() (connectAdmin, shared with ops/admin).

import { createHash } from 'node:crypto';
import { createReadStream, existsSync, realpathSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseBuffer, parseFile } from 'music-metadata';
import { isProductionDbName, productionReason } from '../lib/production-db.js';

export class MediaError extends Error {
  override name = 'MediaError';
}

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

// ---------------------------------------------------------------------------
// Media types
// ---------------------------------------------------------------------------

export type MediaKind = 'AUDIO' | 'VIDEO';

export interface MediaTypeInfo {
  extension: string;
  contentType: string;
  /** academy.call_recordings.media_type */
  mediaType: MediaKind;
}

/**
 * The four formats the academy accepts (SECTION-11: mp3/m4a/wav for calls,
 * mp4 for screen recordings). Anything else is converted before it is offered
 * to these scripts; nothing here shells out to ffmpeg, which is not installed.
 */
export const MEDIA_TYPES: Readonly<Record<string, MediaTypeInfo>> = {
  '.mp3': { extension: '.mp3', contentType: 'audio/mpeg', mediaType: 'AUDIO' },
  '.m4a': { extension: '.m4a', contentType: 'audio/mp4', mediaType: 'AUDIO' },
  '.wav': { extension: '.wav', contentType: 'audio/wav', mediaType: 'AUDIO' },
  '.mp4': { extension: '.mp4', contentType: 'video/mp4', mediaType: 'VIDEO' },
};

export const MEDIA_EXTENSIONS: readonly string[] = Object.keys(MEDIA_TYPES);

/** The media type of a file name, by extension. Throws on anything else. */
export function mediaTypeOf(fileName: string): MediaTypeInfo {
  const ext = path.extname(fileName).toLowerCase();
  const info = MEDIA_TYPES[ext];
  if (info === undefined) {
    throw new MediaError(
      `Unsupported media file "${path.basename(fileName)}": accepted formats are ` +
        `${MEDIA_EXTENSIONS.join(', ')}. Convert anything else before ingesting it.`,
    );
  }
  return info;
}

/** Largest file the CLIs accept: the API's MEDIA_MAX_UPLOAD_MB default (env.ts). */
export const DEFAULT_MAX_MEDIA_MB = 200;

export function maxMediaBytes(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env['MEDIA_MAX_UPLOAD_MB']?.trim();
  if (raw === undefined || raw === '') return DEFAULT_MAX_MEDIA_MB * 1024 * 1024;
  const mb = Number(raw);
  if (!Number.isInteger(mb) || mb < 1 || mb > 10_000) {
    throw new MediaError('MEDIA_MAX_UPLOAD_MB must be a whole number of megabytes (1..4096).');
  }
  return mb * 1024 * 1024;
}

export function assertWithinSize(bytes: number, limitBytes: number, what: string): void {
  if (bytes > limitBytes) {
    throw new MediaError(
      `${what} is ${mb(bytes)} MB, over the ${mb(limitBytes)} MB limit (MEDIA_MAX_UPLOAD_MB).`,
    );
  }
  if (bytes === 0) throw new MediaError(`${what} is empty.`);
}

export function mb(bytes: number): string {
  return (bytes / (1024 * 1024)).toFixed(1);
}

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

// Windows paths are case-insensitive: E:\RRC and e:\rrc are the same folder.
function normCase(p: string): string {
  return process.platform === 'win32' ? p.toLowerCase() : p;
}

export function isInside(child: string, parent: string): boolean {
  const rel = path.relative(normCase(parent), normCase(child));
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

/**
 * A media file must never sit inside the repo, even for a moment: git would
 * pick it up on the next `git add .`. Both the path as given and its real
 * target are checked, so a symlink cannot hide it.
 */
export function assertMediaFileOutsideRepo(file: string): string {
  const given = path.resolve(file);
  if (!existsSync(given) || !statSync(given).isFile()) {
    throw new MediaError(`--file does not point at a file: ${given}`);
  }
  const resolved = realpathSync(given);
  const repoRoot = existsSync(REPO_ROOT) ? realpathSync(REPO_ROOT) : REPO_ROOT;
  if (isInside(given, REPO_ROOT) || isInside(resolved, repoRoot)) {
    throw new MediaError(
      'The file is inside the repo. Media never enters git: keep it outside the repo ' +
        '(the build pack or a working folder) and point --file there.',
    );
  }
  return resolved;
}

/** MEDIA_ROOT: the folder on the server's disk that holds every media object. */
export function resolveMediaRoot(env: NodeJS.ProcessEnv = process.env): string {
  const raw = env['MEDIA_ROOT']?.trim();
  if (raw === undefined || raw === '') {
    throw new MediaError(
      'MEDIA_ROOT is not set. It names the folder on disk that holds the media objects.',
    );
  }
  return path.resolve(raw);
}

// ---------------------------------------------------------------------------
// Database guards
// ---------------------------------------------------------------------------

/**
 * True when a database name is production and must never be touched by these
 * scripts. The rule lives in ops/lib/production-db.ts, which knows the CRM's
 * database by name — 'client_credentials' contains neither 'prod' nor 'live'
 * and used to sail straight through.
 */
export function looksLikeProduction(name: string): boolean {
  return isProductionDbName(name);
}

export function parseExpectDb(raw: string | undefined): string {
  const db = raw?.trim() ?? '';
  if (!db) throw new MediaError('--expect-db <database name> is required (wrong-database guard).');
  if (looksLikeProduction(db)) {
    throw new MediaError(
      `Refusing to run against "${db}": ${productionReason(db)}. These scripts run ` +
        'against a local or staging database; on the production server the operator runs them ' +
        'himself, the way he applies the migrations.',
    );
  }
  return db;
}

// ---------------------------------------------------------------------------
// Probing and hashing
// ---------------------------------------------------------------------------

/**
 * Whole-second duration, read with music-metadata (pure JavaScript: ffmpeg is
 * not installed here and may not be on the server). `duration: true` makes it
 * scan the frames when the header has no duration, which is the normal case
 * for a CBR MP3 without a Xing header.
 *
 * Returns null when the bytes cannot be parsed as the declared type.
 */
export async function probeDurationSecs(
  source: Buffer | string,
  contentType: string,
): Promise<number | null> {
  try {
    const meta =
      typeof source === 'string'
        ? await parseFile(source, { duration: true })
        : await parseBuffer(source, { mimeType: contentType }, { duration: true });
    const seconds = meta.format.duration;
    if (seconds === undefined || !Number.isFinite(seconds) || seconds <= 0) return null;
    // duration_secs is a positive INT (0002): never round a short clip to 0.
    return Math.max(1, Math.round(seconds));
  } catch {
    return null; // message withheld on purpose: it can quote file content
  }
}

export function sha256Of(buffer: Buffer): string {
  return createHash('sha256').update(buffer).digest('hex');
}

export async function sha256OfFile(file: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk as Buffer);
  return hash.digest('hex');
}

// ---------------------------------------------------------------------------
// Entry point helper
// ---------------------------------------------------------------------------

function isMain(moduleUrl: string): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  const a = path.resolve(entry);
  const b = fileURLToPath(moduleUrl);
  return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
}

/** Runs main() when the module is the entry point; exit 0 on success, 1 on any error. */
export function runIfMain(moduleUrl: string, name: string, main: () => Promise<number>): void {
  if (!isMain(moduleUrl)) return;
  main().then(
    (code) => process.exit(code),
    (err: unknown) => {
      // Message only: pg errors can echo parameter values, so no detail or stack.
      const e = err as { message?: string; code?: string; name?: string };
      const known = e.name === 'MediaError' || e.name === 'AdminError' || e.name === 'TypeError';
      console.error(
        `${name}: ${known ? e.message : `${e.code ?? ''} ${e.message ?? String(err)}`}`,
      );
      process.exit(1);
    },
  );
}
