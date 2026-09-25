// The S11 collection pipeline: put ONE new recording or screen recording into
// the academy. Section 11 works its manifest top to bottom, one item at a time,
// and every item arrives here.
//
//   MEDIA_ROOT=<folder> npx tsx ops/media/ingest-media.ts \
//     --file "<path OUTSIDE the repo>" --stage <stageCode> --title "..." \
//     [--description "..."] [--recording-code <code>] \
//     --expect-db <name> [--confirm-production] [--dry-run]
//
// What it does, in order:
//   1. refuses a file inside the repo (media never enters git) and any format
//      other than mp3, m4a, wav or mp4;
//   2. checks the size against MEDIA_MAX_UPLOAD_MB and probes the duration
//      with music-metadata (pure JavaScript: there is no ffmpeg here);
//   3. streams the bytes into the media store under a content-addressed key;
//   4. fills the stage's first empty "coming soon" slot (or the slot named by
//      --recording-code), or adds a new call_recordings row when the stage has
//      no empty slot left;
//   5. queues the transcription and draft-question jobs for that recording.
//
// Nothing in the output names a client or a member of staff: it prints the
// stage code, the recording code, the file name, the size and the duration.
// AI-drafted questions are never live: the consumer writes them as DRAFT for
// human approval (S11 rule).

import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { loadDotenvIfPresent } from '../../server/src/config/dotenv.js';
import { createMediaProducers } from '../../server/src/jobs/mediaJobs.js';
import { createLocalMediaStore } from '../../server/src/media/store.js';
import type { MediaStore } from '../../server/src/media/store.js';
import { createInMemoryQueue } from '../../server/src/queues/queue.js';
import { connectAdmin, inTransaction } from '../admin/lib.js';
import type { Queryable } from '../admin/lib.js';
import { formatDuration } from './extract-media.js';
import {
  MediaError,
  assertMediaFileOutsideRepo,
  assertWithinSize,
  maxMediaBytes,
  mb,
  mediaTypeOf,
  parseExpectDb,
  probeDurationSecs,
  resolveMediaRoot,
  runIfMain,
  sha256OfFile,
} from './lib.js';

export interface IngestArgs {
  file: string;
  stageCode: string;
  title: string;
  description: string | null;
  recordingCode: string | null;
  expectDb: string;
  dryRun: boolean;
  /** Overwrite a slot that already has media (a re-record, or a seeded key
   *  whose file was never loaded). Off unless asked for. */
  replace: boolean;
}

// academy.stages.code (0002) and academy.call_recordings.code (the seed's
// '<stage>-rec<n>'). Both are operator-typed here, so both are shape-checked.
const CODE_RE = /^[A-Za-z0-9_-]{1,32}$/;
const RECORDING_CODE_RE = /^[A-Za-z0-9_-]{1,64}$/;

function required(value: string | undefined, flag: string): string {
  const text = value?.trim() ?? '';
  if (!text) throw new MediaError(`${flag} is required.`);
  return text;
}

export function parseIngestArgs(argv: readonly string[]): IngestArgs {
  let values: Record<string, string | boolean | undefined>;
  try {
    ({ values } = parseArgs({
      args: [...argv],
      options: {
        file: { type: 'string' },
        stage: { type: 'string' },
        title: { type: 'string' },
        description: { type: 'string' },
        'recording-code': { type: 'string' },
        'expect-db': { type: 'string' },
        'confirm-production': { type: 'boolean', default: false },
        'dry-run': { type: 'boolean', default: false },
        replace: { type: 'boolean', default: false },
      },
      allowPositionals: false,
    }));
  } catch (err) {
    throw new MediaError(
      `${(err as Error).message}\nUsage: ingest-media.ts --file <path outside the repo> ` +
        '--stage <stageCode> --title "..." [--description "..."] [--recording-code <code>] ' +
        '--expect-db <name> [--confirm-production] [--dry-run] [--replace]',
    );
  }

  const str = (name: string): string | undefined => {
    const value = values[name];
    return typeof value === 'string' ? value : undefined;
  };

  const stageCode = required(str('stage'), '--stage');
  if (!CODE_RE.test(stageCode)) {
    throw new MediaError('--stage must be a stage code: letters, digits, _ and - (max 32).');
  }
  const recordingCode = str('recording-code')?.trim() ?? '';
  if (recordingCode !== '' && !RECORDING_CODE_RE.test(recordingCode)) {
    throw new MediaError(
      '--recording-code must be letters, digits, _ and - (max 64), e.g. s4-rec1.',
    );
  }
  const title = required(str('title'), '--title');
  if (title.length > 200) throw new MediaError('--title is too long (max 200 characters).');
  const description = str('description')?.trim() ?? '';
  if (description.length > 1000) {
    throw new MediaError('--description is too long (max 1000 characters).');
  }

  return {
    file: required(str('file'), '--file'),
    stageCode,
    title,
    description: description === '' ? null : description,
    recordingCode: recordingCode === '' ? null : recordingCode,
    expectDb: parseExpectDb(str('expect-db'), values['confirm-production'] === true),
    dryRun: values['dry-run'] === true,
    replace: values['replace'] === true,
  };
}

/**
 * The store key for a new file: `academy/media/<name>-<first 8 of sha256><ext>`.
 * Content-addressed, so ingesting the same file twice lands on the same key
 * and two different files can never collide on one name.
 */
export function ingestKey(fileName: string, sha256: string): string {
  const info = mediaTypeOf(fileName);
  const stem = path
    .basename(fileName, path.extname(fileName))
    .replace(/[^A-Za-z0-9_-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^[-_]+|[-_]+$/g, '')
    .slice(0, 60);
  const safeStem = /^[A-Za-z0-9]/.test(stem) ? stem : `media-${stem}`;
  return `academy/media/${safeStem}-${sha256.slice(0, 8)}${info.extension}`;
}

interface StageRow {
  id: string;
  dept: string | null;
}

interface SlotRow {
  id: string;
  code: string | null;
  position: number | null;
  category: string;
}

export interface IngestResult {
  action: 'filled a coming-soon slot' | 'created a new recording' | 'would create/fill (dry run)';
  recordingId: string;
  recordingCode: string | null;
  stageCode: string;
  mediaKey: string;
  byteSize: number;
  durationSecs: number;
  contentType: string;
  sha256: string;
}

async function findStage(db: Queryable, stageCode: string): Promise<StageRow> {
  const { rows } = await db.query<StageRow>(
    'SELECT id::text AS id, dept FROM academy.stages WHERE code = $1',
    [stageCode],
  );
  const stage = rows[0];
  if (stage === undefined) throw new MediaError(`No stage with code "${stageCode}".`);
  return stage;
}

/** The empty slot to fill, or null when the stage has none left. */
async function findEmptySlot(
  db: Queryable,
  stageId: string,
  recordingCode: string | null,
  replace = false,
): Promise<SlotRow | null> {
  if (recordingCode !== null) {
    const { rows } = await db.query<
      SlotRow & { media_key: string | null; stage_id: string | null }
    >(
      `SELECT id::text AS id, code, position, category, media_key, stage_id::text AS stage_id
         FROM academy.call_recordings WHERE code = $1 FOR UPDATE`,
      [recordingCode],
    );
    const slot = rows[0];
    if (slot === undefined) return null; // a new row will be created with this code
    if (slot.media_key !== null && !replace) {
      throw new MediaError(
        `Recording "${recordingCode}" already has media. Pass --replace to overwrite it, or ` +
          'ingest under a new code.',
      );
    }
    if (slot.stage_id !== null && slot.stage_id !== stageId) {
      throw new MediaError(
        `Recording "${recordingCode}" belongs to another stage. Pass its own --stage, or drop ` +
          '--recording-code to fill the first empty slot of this stage.',
      );
    }
    return slot;
  }
  const { rows } = await db.query<SlotRow>(
    `SELECT id::text AS id, code, position, category
       FROM academy.call_recordings
      WHERE stage_id = $1 AND media_key IS NULL AND is_active
      ORDER BY position NULLS LAST, id
      LIMIT 1
      FOR UPDATE`,
    [stageId],
  );
  return rows[0] ?? null;
}

/** The category a new row takes: whatever the stage's other recordings use. */
async function categoryForStage(db: Queryable, stage: StageRow): Promise<string> {
  const { rows } = await db.query<{ category: string }>(
    `SELECT category FROM academy.call_recordings
      WHERE stage_id = $1 GROUP BY category ORDER BY count(*) DESC LIMIT 1`,
    [stage.id],
  );
  return rows[0]?.category ?? (stage.dept === null ? 'INDUCTION' : 'DEPARTMENT');
}

export interface IngestInput {
  args: IngestArgs;
  mediaKey: string;
  sha256: string;
  byteSize: number;
  durationSecs: number;
  contentType: string;
  mediaType: 'AUDIO' | 'VIDEO';
}

/** The database half: fill a slot or add a row. Runs inside the transaction. */
export async function writeRecording(db: Queryable, input: IngestInput): Promise<IngestResult> {
  const { args } = input;
  const stage = await findStage(db, args.stageCode);
  const slot = await findEmptySlot(db, stage.id, args.recordingCode, args.replace);

  const common = {
    stageCode: args.stageCode,
    mediaKey: input.mediaKey,
    byteSize: input.byteSize,
    durationSecs: input.durationSecs,
    contentType: input.contentType,
    sha256: input.sha256,
  };

  if (slot !== null) {
    await db.query(
      `UPDATE academy.call_recordings
          SET stage_id = $2, title = $3, description = COALESCE($4, description),
              media_key = $5, duration_secs = $6, media_type = $7, byte_size = $8,
              content_type = $9, checksum_sha256 = $10, uploaded_at = now(),
              transcript_status = 'PENDING', is_active = TRUE
        WHERE id = $1`,
      [
        slot.id,
        stage.id,
        args.title,
        args.description,
        input.mediaKey,
        input.durationSecs,
        input.mediaType,
        input.byteSize,
        input.contentType,
        input.sha256,
      ],
    );
    return {
      ...common,
      action: 'filled a coming-soon slot',
      recordingId: slot.id,
      recordingCode: slot.code,
    };
  }

  const category = await categoryForStage(db, stage);
  const { rows } = await db.query<{ id: string; code: string | null }>(
    `INSERT INTO academy.call_recordings
       (code, stage_id, position, category, title, description, media_key, duration_secs,
        media_type, byte_size, content_type, checksum_sha256, uploaded_at, transcript_status)
     VALUES ($1, $2,
             (SELECT COALESCE(max(position), 0) + 1 FROM academy.call_recordings WHERE stage_id = $2),
             $3, $4, $5, $6, $7, $8, $9, $10, $11, now(), 'PENDING')
     RETURNING id::text AS id, code`,
    [
      args.recordingCode,
      stage.id,
      category,
      args.title,
      args.description,
      input.mediaKey,
      input.durationSecs,
      input.mediaType,
      input.byteSize,
      input.contentType,
      input.sha256,
    ],
  );
  const created = rows[0];
  if (created === undefined) throw new MediaError('The recording row was not created.');
  return {
    ...common,
    action: 'created a new recording',
    recordingId: created.id,
    recordingCode: created.code,
  };
}

async function main(): Promise<number> {
  const args = parseIngestArgs(process.argv.slice(2));
  loadDotenvIfPresent();
  const root = resolveMediaRoot();
  const limitBytes = maxMediaBytes();

  // 1. The file: outside the repo, a format we accept, within the size limit.
  const file = assertMediaFileOutsideRepo(args.file);
  const info = mediaTypeOf(file);
  const size = (await stat(file)).size;
  assertWithinSize(size, limitBytes, path.basename(file));

  // 2. Duration and checksum before anything is written anywhere.
  const durationSecs = await probeDurationSecs(file, info.contentType);
  if (durationSecs === null) {
    throw new MediaError(
      `${path.basename(file)} could not be read as ${info.contentType}. Convert it to a ` +
        'standard mp3, m4a, wav or mp4 and try again.',
    );
  }
  const sha256 = await sha256OfFile(file);
  const mediaKey = ingestKey(file, sha256);

  const store: MediaStore = createLocalMediaStore(root);
  console.log(
    `Media root: ${root}\nFile: ${path.basename(file)} (${mb(size)} MB, ` +
      `${formatDuration(durationSecs)}, ${info.contentType})\nKey:  ${mediaKey}`,
  );

  const client = await connectAdmin(args.expectDb, args.dryRun);
  try {
    // 3. The bytes go in first: a row must never point at an object that is
    //    not there. A rolled-back transaction leaves an orphan object, which
    //    a later ingest of the same file simply overwrites (same key).
    if (!args.dryRun) {
      const put = await store.put(mediaKey, createReadStream(file), {
        contentType: info.contentType,
      });
      if (put.sha256 !== sha256 || put.size !== size) {
        throw new MediaError('The stored object does not match the file on disk.');
      }
    }

    const result = await inTransaction(client, args.dryRun, () =>
      writeRecording(client, {
        args,
        mediaKey,
        sha256,
        byteSize: size,
        durationSecs,
        contentType: info.contentType,
        mediaType: info.mediaType,
      }),
    );

    // 4. The follow-up work. Until S08 installs BullMQ the queue seam is the
    //    in-memory one (server/src/queues/queue.ts), so this records the two
    //    jobs and their payloads; transcript_status = 'PENDING' on the row is
    //    the durable marker the S08 worker picks the recording up from.
    const queue = createInMemoryQueue();
    const producers = createMediaProducers(queue);
    const recordingId = Number(result.recordingId);
    await producers.enqueueTranscription({
      recordingId,
      mediaKey,
      contentType: info.contentType,
      durationSecs,
    });
    await producers.enqueueQuestionGen({ recordingId, stageId: null, approvalState: 'DRAFT' });

    console.log(
      `\n${args.dryRun ? 'Dry run — would have: ' : ''}${result.action}: recording #${
        result.recordingId
      } (${result.recordingCode ?? 'no code'}) on stage ${result.stageCode}.`,
    );
    console.log(
      `Queued: ${queue.jobs.map((j) => `${j.queue}/${j.name}`).join(', ')} for recording #` +
        `${result.recordingId}. Draft questions stay DRAFT until a human approves them.`,
    );
    if (args.dryRun) console.log('Nothing was written to disk and the transaction rolled back.');
    return 0;
  } finally {
    await client.end().catch(() => undefined);
  }
}

runIfMain(import.meta.url, 'ingest-media', main);
