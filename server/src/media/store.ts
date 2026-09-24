import { createHash, randomUUID } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, rename, rm, stat as fsStat } from 'node:fs/promises';
import { dirname, extname, resolve, sep } from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';

// The storage seam (decision D15: there is no S3). Everything that reads or
// writes a media file goes through a MediaStore, so the streaming endpoint,
// the upload script and the tests all speak one small interface and none of
// them ever builds a filesystem path of its own.
//
// Today there is one implementation, createLocalMediaStore: files on the
// on-prem server's own disk, under MEDIA_ROOT, outside the repo and outside
// anything nginx serves. If storage ever moves, this file is what changes.
//
// Two rules hold everywhere in here:
//   * a key is checked with assertSafeKey BEFORE any filesystem call, and the
//     resolved path is then checked again to be inside MEDIA_ROOT (belt and
//     braces: the regex should make the second check unreachable);
//   * the content type comes from the caller, which took it from the file's
//     own bytes at upload time. It is never inferred from the name on the way
//     out to a browser.

/** What the store knows about one stored object. */
export interface MediaStat {
  key: string;
  size: number;
  contentType: string;
  mtime: Date;
}

export interface MediaStore {
  put(
    key: string,
    source: Readable | Buffer,
    opts: { contentType: string },
  ): Promise<MediaStat & { sha256: string }>;
  stat(key: string): Promise<MediaStat | null>;
  openRange(key: string, range?: { start: number; end: number }): Promise<Readable>;
  delete(key: string): Promise<void>;
}

/** A key that is not allowed, or a path that would escape MEDIA_ROOT. */
export class MediaKeyError extends Error {
  override name = 'MediaKeyError';
  readonly key: string;

  constructor(key: string, reason: string) {
    // The key is quoted, never the resolved absolute path: a caller's error
    // message must not hand out where the media folder lives.
    super(`unsafe media key (${reason})`);
    this.key = key;
  }
}

/**
 * Keys look like `academy/media/<file>`: a relative POSIX path with no way out
 * of the media folder.
 *
 * Allowed: letters, digits, `/`, `_`, `.` and `-`, starting with a letter or a
 * digit. Upper case is allowed because the seeded keys carry the prototype's
 * own file names (CS_2_UTL.mp3). Anything else — a leading or trailing slash,
 * a backslash, a drive letter, a `..`, a NUL or control character, a space, a
 * look-alike Unicode dot — is refused here, before any filesystem call.
 * Migration 0005 repeats the same rule as a CHECK constraint.
 */
const KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9/_.-]*$/;
const MAX_KEY_LENGTH = 512;

export function assertSafeKey(key: string): void {
  if (typeof key !== 'string' || key === '') throw new MediaKeyError(String(key), 'empty');
  if (key.length > MAX_KEY_LENGTH) throw new MediaKeyError(key, 'too long');
  if (key.includes('\\')) throw new MediaKeyError(key, 'backslash');
  if (key.startsWith('/')) throw new MediaKeyError(key, 'absolute path');
  if (key.endsWith('/')) throw new MediaKeyError(key, 'trailing slash');
  if (key.includes('..')) throw new MediaKeyError(key, 'parent reference');
  // Caught by the pattern as well; named separately so the reason is useful.
  if (key.includes('//')) throw new MediaKeyError(key, 'empty path segment');
  if (!KEY_PATTERN.test(key)) throw new MediaKeyError(key, 'character not allowed');
  // A lone '.' segment is inside the pattern's character set.
  if (key.split('/').some((segment) => segment === '.')) {
    throw new MediaKeyError(key, 'current-directory segment');
  }
}

/**
 * Types we are willing to name for a file already on disk, used only when the
 * caller has nothing better. The authoritative type is the one stored with the
 * recording (call_recordings.content_type, written at upload from the file's
 * own bytes); this map is the fallback, and anything unknown is served as
 * application/octet-stream rather than guessed.
 */
const TYPE_BY_EXTENSION = new Map<string, string>([
  ['.mp3', 'audio/mpeg'],
  ['.m4a', 'audio/mp4'],
  ['.wav', 'audio/wav'],
  ['.ogg', 'audio/ogg'],
  ['.mp4', 'video/mp4'],
  ['.webm', 'video/webm'],
  ['.mov', 'video/quicktime'],
  ['.pdf', 'application/pdf'],
]);

export const DEFAULT_CONTENT_TYPE = 'application/octet-stream';

export function contentTypeForKey(key: string): string {
  return TYPE_BY_EXTENSION.get(extname(key).toLowerCase()) ?? DEFAULT_CONTENT_TYPE;
}

function isMissing(err: unknown): boolean {
  const code = (err as { code?: unknown } | null)?.code;
  return code === 'ENOENT' || code === 'ENOTDIR';
}

/**
 * Files under `root`, one file per key. `root` is resolved once here, so every
 * later comparison is between two absolute, normalised paths.
 */
export function createLocalMediaStore(root: string): MediaStore {
  const base = resolve(root);

  /** The absolute path for a key, proven to be inside `base`. */
  function pathFor(key: string): string {
    assertSafeKey(key);
    const full = resolve(base, key);
    if (full !== base && !full.startsWith(base + sep)) {
      throw new MediaKeyError(key, 'escapes the media root');
    }
    if (full === base) throw new MediaKeyError(key, 'is the media root itself');
    return full;
  }

  return {
    async put(key, source, opts) {
      const full = pathFor(key);
      await mkdir(dirname(full), { recursive: true });

      // Written to a temporary name in the SAME folder and then renamed, so a
      // reader never sees a half-written file and an interrupted upload leaves
      // a .part file rather than a corrupt recording. Same folder matters:
      // rename is only atomic within one filesystem.
      const temp = `${full}.${randomUUID()}.part`;
      const hash = createHash('sha256');
      try {
        const bytes = Buffer.isBuffer(source) ? Readable.from(source) : source;
        // The checksum is taken from the bytes on their way to disk, in a
        // pass-through rather than a 'data' listener: a listener would put the
        // source into flowing mode and race the pipe.
        const tap = new Transform({
          transform(chunk: Buffer, _encoding, done) {
            hash.update(chunk);
            done(null, chunk);
          },
        });
        await pipeline(bytes, tap, createWriteStream(temp, { flags: 'wx' }));
        await rename(temp, full);
      } catch (err) {
        await rm(temp, { force: true }).catch(() => undefined);
        throw err;
      }

      const info = await fsStat(full);
      return {
        key,
        size: info.size,
        contentType: opts.contentType,
        mtime: info.mtime,
        sha256: hash.digest('hex'),
      };
    },

    async stat(key) {
      const full = pathFor(key);
      try {
        const info = await fsStat(full);
        // A folder is not an object: answer "nothing here" rather than throw.
        if (!info.isFile()) return null;
        return { key, size: info.size, contentType: contentTypeForKey(key), mtime: info.mtime };
      } catch (err) {
        if (isMissing(err)) return null;
        throw err;
      }
    },

    // async so that an unsafe key or a nonsense range comes back as a
    // rejected promise, not a synchronous throw the caller has to guard twice.
    async openRange(key, range) {
      const full = pathFor(key);
      if (range === undefined) return createReadStream(full);
      const { start, end } = range;
      if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end < start) {
        throw new RangeError('invalid byte range');
      }
      // Inclusive at both ends, the way HTTP means it and the way
      // createReadStream reads it. A range past the end of the file simply
      // yields the bytes that are there (the route answers 416 first).
      return createReadStream(full, { start, end });
    },

    async delete(key) {
      const full = pathFor(key);
      await rm(full, { force: true });
    },
  };
}
