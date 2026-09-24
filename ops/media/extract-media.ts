// S06 task 1: put the six call recordings the prototype embeds into the media
// store, and fill in what the database needs to know about each file.
//
//   MEDIA_ROOT=<folder> PROTOTYPE_PATH=<file outside the repo> \
//     npx tsx ops/media/extract-media.ts --expect-db <name> [--dry-run]
//
// The prototype keeps each recording as a base64 data: URL inside its MEDIA
// object. This script decodes one at a time and streams it straight into the
// media store under the key the S02 seed already wrote on the row
// (academy/media/<file>) — the bytes never touch a file inside the repo, and
// no transcript, client name, staff name or base64 is ever printed.
//
// Idempotent. A file whose sha256 already matches the row, with the same
// object already in the store, is reported `unchanged` and nothing is written.
//
// NOT here: the FOS portal video (video1437476061.mp4). It is a real screen
// recording and waits for Brad's PII review; ops/media/ingest-media.ts loads
// it when he has signed it off.
//
// Guards: --expect-db must not look like production and must equal
// current_database(); --dry-run does the reads, writes nothing and rolls back.

import { readFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { loadDotenvIfPresent } from '../../server/src/config/dotenv.js';
import { createLocalMediaStore } from '../../server/src/media/store.js';
import type { MediaStore } from '../../server/src/media/store.js';
import { connectAdmin, inTransaction } from '../admin/lib.js';
import type { Queryable } from '../admin/lib.js';
import { table } from '../dev/lib.js';
import { resolvePrototypePath } from '../lib/prototype-path.js';
import { mediaKeyFor } from '../seed/seed-content.js';
import { readEmbeddedMedia } from './embedded.js';
import type { EmbeddedMedia } from './embedded.js';
import {
  MediaError,
  assertWithinSize,
  maxMediaBytes,
  mb,
  parseExpectDb,
  probeDurationSecs,
  resolveMediaRoot,
  runIfMain,
  sha256Of,
} from './lib.js';

export interface ExtractArgs {
  expectDb: string;
  dryRun: boolean;
}

export function parseExtractArgs(argv: readonly string[]): ExtractArgs {
  let values: { 'expect-db'?: string | undefined; 'dry-run'?: boolean | undefined };
  try {
    ({ values } = parseArgs({
      args: [...argv],
      options: {
        'expect-db': { type: 'string' },
        'dry-run': { type: 'boolean', default: false },
      },
      allowPositionals: false,
    }));
  } catch (err) {
    throw new MediaError(
      `${(err as Error).message}\nUsage: extract-media.ts --expect-db <name> [--dry-run]`,
    );
  }
  return { expectDb: parseExpectDb(values['expect-db']), dryRun: values['dry-run'] === true };
}

type Status = 'stored' | 'unchanged' | 'no slot' | 'would store';

interface Row {
  file: string;
  status: Status;
  bytes: number;
  durationSecs: number | null;
  recordingCode: string | null;
}

/** One embedded recording: store the bytes, then update its row. */
async function extractOne(
  db: Queryable,
  store: MediaStore,
  media: EmbeddedMedia,
  dryRun: boolean,
  limitBytes: number,
): Promise<Row> {
  const key = mediaKeyFor(media.file);
  assertWithinSize(media.bytes.byteLength, limitBytes, media.file);
  const sha256 = sha256Of(media.bytes);
  const durationSecs = await probeDurationSecs(media.bytes, media.contentType);

  const { rows } = await db.query<{
    id: string;
    code: string | null;
    checksum_sha256: string | null;
    byte_size: string | null;
    content_type: string | null;
    duration_secs: number | null;
  }>(
    `SELECT id::text AS id, code, checksum_sha256, byte_size::text AS byte_size,
            content_type, duration_secs
       FROM academy.call_recordings
      WHERE media_key = $1
      ORDER BY id
      FOR UPDATE`,
    [key],
  );
  const base = { file: media.file, bytes: media.bytes.byteLength, durationSecs };
  if (rows.length === 0) {
    // The seed writes a row for every recording slot the prototype has, so
    // this only happens when the content seed has not been run yet.
    return { ...base, status: 'no slot', recordingCode: null };
  }
  const recordingCode = rows[0]?.code ?? null;

  const stored = await store.stat(key);
  const settled =
    stored !== null &&
    stored.size === media.bytes.byteLength &&
    rows.every(
      (r) =>
        r.checksum_sha256 === sha256 &&
        r.byte_size === String(media.bytes.byteLength) &&
        r.content_type === media.contentType &&
        r.duration_secs !== null,
    );
  if (settled) return { ...base, status: 'unchanged', recordingCode };

  if (dryRun) return { ...base, status: 'would store', recordingCode };

  const put = await store.put(key, media.bytes, { contentType: media.contentType });
  if (put.sha256 !== sha256 || put.size !== media.bytes.byteLength) {
    throw new MediaError(`${media.file}: the stored object does not match the decoded bytes.`);
  }

  await db.query(
    `UPDATE academy.call_recordings
        SET byte_size = $2, content_type = $3, checksum_sha256 = $4,
            duration_secs = COALESCE(duration_secs, $5), uploaded_at = now()
      WHERE media_key = $1`,
    [key, put.size, media.contentType, put.sha256, durationSecs],
  );
  return { ...base, status: 'stored', recordingCode };
}

export interface ExtractResult {
  rows: Row[];
  /** Rows that name a media file the prototype does not embed (the FOS video). */
  external: { code: string | null; mediaKey: string }[];
}

export async function extractMedia(
  db: Queryable,
  store: MediaStore,
  html: string,
  dryRun: boolean,
  limitBytes: number,
): Promise<ExtractResult> {
  const embedded = readEmbeddedMedia(html);
  const rows: Row[] = [];
  for (const media of embedded) {
    rows.push(await extractOne(db, store, media, dryRun, limitBytes));
  }

  const keys = embedded.map((m) => mediaKeyFor(m.file));
  const { rows: external } = await db.query<{ code: string | null; media_key: string }>(
    `SELECT code, media_key FROM academy.call_recordings
      WHERE media_key IS NOT NULL AND NOT (media_key = ANY($1::text[]))
      ORDER BY id`,
    [keys],
  );
  return { rows, external: external.map((r) => ({ code: r.code, mediaKey: r.media_key })) };
}

function report(result: ExtractResult, dryRun: boolean): void {
  const { rows } = result;
  console.log(
    '\n' +
      table(
        ['file', 'recording', 'bytes', 'MB', 'duration', 'result'],
        rows.map((r) => [
          r.file,
          r.recordingCode ?? '-',
          r.bytes,
          mb(r.bytes),
          r.durationSecs === null ? '?' : formatDuration(r.durationSecs),
          r.status,
        ]),
      ),
  );

  const count = (s: Status): number => rows.filter((r) => r.status === s).length;
  console.log(
    `\n${rows.length} embedded recording(s): ${count('stored')} stored, ` +
      `${count('would store')} would be stored, ${count('unchanged')} unchanged, ` +
      `${count('no slot')} with no matching row.`,
  );
  if (result.external.length > 0) {
    console.log(
      `\nNot embedded in the prototype, so NOT ingested here: ` +
        result.external.map((e) => `${e.mediaKey} (${e.code ?? 'no code'})`).join(', ') +
        '.\nThe FOS portal video needs Brad’s PII review; load it with ingest-media.ts after that.',
    );
  }
  if (dryRun)
    console.log('\nDry run: nothing was written to disk and the transaction rolled back.');
}

export function formatDuration(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}

async function main(): Promise<number> {
  const args = parseExtractArgs(process.argv.slice(2));
  loadDotenvIfPresent();
  const root = resolveMediaRoot();
  const limitBytes = maxMediaBytes();
  const prototype = resolvePrototypePath();
  const store = createLocalMediaStore(root);

  console.log(`Media root: ${root}`);
  const html = await readFile(prototype, 'utf8');

  const client = await connectAdmin(args.expectDb, args.dryRun);
  try {
    const result = await inTransaction(client, args.dryRun, () =>
      extractMedia(client, store, html, args.dryRun, limitBytes),
    );
    report(result, args.dryRun);
    return result.rows.some((r) => r.status === 'no slot') ? 1 : 0;
  } finally {
    await client.end().catch(() => undefined);
  }
}

runIfMain(import.meta.url, 'extract-media', main);
