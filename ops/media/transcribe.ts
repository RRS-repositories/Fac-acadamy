// The backlog transcriber: give every recording that is still waiting for one a
// transcript, on THIS machine.
//
//   MEDIA_ROOT=<folder> TRANSCRIBE_PYTHON=… TRANSCRIBE_SCRIPT=… TRANSCRIBE_MODEL=small \
//     npx tsx ops/media/transcribe.ts --expect-db <name> [--commit] \
//       [--recording <id>] [--limit <n>] [--replace] [--confirm-production]
//
// WHY THIS EXISTS AT ALL, when the worker has a transcription queue: because the
// server cannot afford the backlog. It has 3 cores, runs 26 applications for the
// whole company and already sits at a load of about 6.5. The 15 recordings we have
// are 131 minutes of audio. That runs here, on 16 cores with nothing else
// competing, and it MEASURED at about 2.7x real time with the `small` model at
// beam 1 — 131 minutes of audio in a little under an hour, at no cost to anybody.
// The queue handler on the server exists for the trickle of new uploads
// afterwards, a few a week at most. (Plan §1 and §4.)
//
// It is a DRY RUN unless you pass --commit. That is the opposite way round from
// ingest-media, on purpose: ingest puts one named file in one named slot, and
// this walks every pending recording in the database and rewrites a column on
// each. The same convention as the migration runner, for the same reason.
//
// THE AUDIO NEVER LEAVES THIS MACHINE. The file is already on local disk under
// MEDIA_ROOT; a local interpreter reads it and prints text back. Only TEXT
// travels, and only as far as the database.
//
// WHAT IT PRINTS: recording ids, recording codes, the media key (a technical file
// name), durations, how long it took, segment and word counts, how much of the
// audio the segments account for, and how many lines it could attribute to a
// speaker. Never a word of a transcript, never a client, never a member of staff.
// A transcript is the content of a real client call and it belongs in the database
// and on the screen of somebody who could already play the recording — not in a
// terminal scrollback, a CI log or a screenshot.
//
// READ THE COVERAGE LINE. See coverageOf below: it is the only thing standing
// between us and a transcript that reads beautifully and is missing four minutes
// of the call. A flagged recording is not averaged into a total; it is named.

import { parseArgs } from 'node:util';
import { loadDotenvIfPresent } from '../../server/src/config/dotenv.js';
import { localPathFor } from '../../server/src/media/store.js';
import { TranscriberError, createTranscriberFromEnv } from '../../server/src/media/transcriber.js';
import type { Transcriber, TranscriptResult } from '../../server/src/media/transcriber.js';
import { markTranscriptFailed, storeTranscript } from '../../server/src/media/transcriptStore.js';
import { connectAdmin, inTransaction } from '../admin/lib.js';
import type { Queryable } from '../admin/lib.js';
import { formatDuration } from './extract-media.js';
import { MediaError, parseExpectDb, resolveMediaRoot, runIfMain } from './lib.js';

export interface TranscribeArgs {
  expectDb: string;
  /** Nothing is written unless this is true. The default is a dry run. */
  commit: boolean;
  /** Just this recording, by id. Null means every pending one. */
  recordingId: number | null;
  /** Stop after this many recordings. Null means no limit. */
  limit: number | null;
  /** Also re-do recordings that already have transcript text. */
  replace: boolean;
}

export function parseTranscribeArgs(argv: readonly string[]): TranscribeArgs {
  let values: Record<string, string | boolean | undefined>;
  try {
    ({ values } = parseArgs({
      args: [...argv],
      options: {
        'expect-db': { type: 'string' },
        'confirm-production': { type: 'boolean', default: false },
        commit: { type: 'boolean', default: false },
        // Accepted so that typing the safe thing is never an error, and so the
        // habit from every other script in this folder still works. It is what
        // happens anyway; passing it together with --commit is a contradiction
        // and is refused rather than guessed at.
        'dry-run': { type: 'boolean', default: false },
        recording: { type: 'string' },
        limit: { type: 'string' },
        replace: { type: 'boolean', default: false },
      },
      allowPositionals: false,
    }));
  } catch (err) {
    throw new MediaError(
      `${(err as Error).message}\nUsage: transcribe.ts --expect-db <name> [--commit] ` +
        '[--recording <id>] [--limit <n>] [--replace] [--confirm-production]\n' +
        'Without --commit it is a dry run: it reads what is pending and writes nothing.',
    );
  }

  const str = (name: string): string | undefined => {
    const value = values[name];
    return typeof value === 'string' ? value : undefined;
  };

  const commit = values['commit'] === true;
  if (commit && values['dry-run'] === true) {
    throw new MediaError('--commit and --dry-run contradict each other: pass one or neither.');
  }

  const rawId = str('recording')?.trim() ?? '';
  let recordingId: number | null = null;
  if (rawId !== '') {
    if (!/^[0-9]{1,15}$/.test(rawId)) throw new MediaError('--recording must be a recording id.');
    recordingId = Number(rawId);
    if (recordingId <= 0) throw new MediaError('--recording must be a recording id.');
  }

  const rawLimit = str('limit')?.trim() ?? '';
  let limit: number | null = null;
  if (rawLimit !== '') {
    if (!/^[0-9]{1,4}$/.test(rawLimit) || Number(rawLimit) < 1) {
      throw new MediaError('--limit must be a whole number of recordings, 1 or more.');
    }
    limit = Number(rawLimit);
  }

  return {
    expectDb: parseExpectDb(str('expect-db'), values['confirm-production'] === true),
    commit,
    recordingId,
    limit,
    replace: values['replace'] === true,
  };
}

// ---------------------------------------------------------------------------
// What is waiting
// ---------------------------------------------------------------------------

export interface PendingRecording {
  id: number;
  code: string | null;
  mediaKey: string;
  durationSecs: number | null;
  /** True when there is already transcript text: only re-done with --replace. */
  hasTranscript: boolean;
}

/**
 * The recordings waiting for a transcript.
 *
 * AUDIO only, and that is a decision rather than an oversight: the five screen
 * recordings have narration, but a transcript of a walkthrough is worth much
 * less than a transcript of a call and nobody has asked for one (plan §7). The
 * queue handler makes the same choice, so the two halves agree.
 *
 * A "coming soon" slot (media_key IS NULL, D4) has nothing to transcribe and is
 * not an error. An inactive recording is skipped too: it is not on anybody's
 * screen, so spending half an hour of CPU on it would be a waste.
 */
export async function findPending(
  db: Queryable,
  opts: { recordingId: number | null; limit: number | null; replace: boolean },
): Promise<PendingRecording[]> {
  const { rows } = await db.query<{
    id: string;
    code: string | null;
    media_key: string;
    duration_secs: number | null;
    has_transcript: boolean;
  }>(
    `SELECT r.id::text AS id,
            r.code,
            r.media_key,
            r.duration_secs,
            (r.transcript IS NOT NULL AND btrim(r.transcript) <> '') AS has_transcript
       FROM academy.call_recordings r
      WHERE r.is_active
        AND r.media_type = 'AUDIO'
        AND r.media_key IS NOT NULL
        AND ($1::bigint IS NULL OR r.id = $1::bigint)
        AND ($1::bigint IS NOT NULL OR r.transcript_status = 'PENDING')
        AND ($2::boolean OR r.transcript IS NULL OR btrim(r.transcript) = '')
      ORDER BY r.id`,
    [opts.recordingId, opts.replace],
  );
  const all = rows.map((row) => ({
    id: Number(row.id),
    code: row.code,
    mediaKey: row.media_key,
    durationSecs: row.duration_secs,
    hasTranscript: row.has_transcript,
  }));
  return opts.limit === null ? all : all.slice(0, opts.limit);
}

// The two writes live in server/src/media/transcriptStore.ts, not here: the
// worker's transcription handler performs exactly the same UPDATE from a
// different process, as a different database login, and the plan has both of them
// writing for months. Two copies of that statement would drift.

// ---------------------------------------------------------------------------
// The run
// ---------------------------------------------------------------------------

function secs(ms: number): string {
  return `${(ms / 1000).toFixed(0)}s`;
}

// ---------------------------------------------------------------------------
// Did it get the WHOLE recording? (the only check that matters after a run)
// ---------------------------------------------------------------------------

/**
 * How much of the audio the transcript actually accounts for.
 *
 * WHY THIS IS HERE AND NOT LEFT TO A READER'S EYE. A transcription does not fail
 * loudly when it goes wrong: it comes back shorter. During the trial (28 Sep 2026)
 * one configuration — a long vocabulary prompt plus `hotwords` — returned a
 * transcript that looked perfectly good, read well, had sensible timings, and was
 * MISSING 24% of what was said, including half of the compliance script. Nothing
 * about it was detectable from the text. The only thing that gave it away was
 * arithmetic on the timings.
 *
 * So every run prints these three numbers, and they have measured meanings:
 *
 *   covered   the seconds the segments span (overlaps merged) as a share of the
 *             media's length. The trial's good runs: 98.8%-100%. The bad one: 93%.
 *   maxGap    the longest silence between one segment and the next. Good runs:
 *             under 5 seconds, because these are busy two-party calls. The bad
 *             one: 19 seconds, four separate gaps over ten.
 *   wordsPerMin  the bad run read as 108 against the good runs' 143. A dropped
 *             passage takes its words with it.
 *
 * `perfect` is deliberately strict: anything it flags is to be looked at, not
 * averaged into a total. A transcript missing a minute of a client call is worse
 * than no transcript, because nobody goes looking for what a transcript does not
 * say.
 */
export interface Coverage {
  /** Share of the media's length the segments account for, 0-1. */
  covered: number;
  /** The longest gap between consecutive segments, in seconds. */
  maxGap: number;
  words: number;
  wordsPerMin: number;
  /** Where the words stop, as a share of the length: a truncated run shows here. */
  spanned: number;
  /** False when this run needs a human to look at it. */
  perfect: boolean;
}

/** Below this share of the media covered, somebody has to look. */
const MIN_COVERED = 0.97;
/** A silence longer than this in the middle of a phone call is not a silence. */
const MAX_GAP_SECS = 10;

export function coverageOf(
  segments: readonly { start: number; end: number; text: string }[],
  durationSecs: number | null,
): Coverage {
  const words = segments.reduce((sum, s) => sum + s.text.split(/\s+/).filter(Boolean).length, 0);
  const sorted = [...segments].sort((a, b) => a.start - b.start || a.end - b.end);
  const merged: { start: number; end: number }[] = [];
  for (const seg of sorted) {
    const last = merged[merged.length - 1];
    if (last !== undefined && seg.start <= last.end) last.end = Math.max(last.end, seg.end);
    else merged.push({ start: seg.start, end: seg.end });
  }
  let maxGap = 0;
  for (let i = 1; i < merged.length; i += 1) {
    maxGap = Math.max(maxGap, merged[i]!.start - merged[i - 1]!.end);
  }
  const heard = merged.reduce((sum, m) => sum + (m.end - m.start), 0);
  const first = merged[0];
  const last = merged[merged.length - 1];
  // No duration means the engine did not say how long the file was; the shares
  // are then unknowable rather than 0, and only the gap is worth anything.
  const usable = durationSecs !== null && durationSecs > 0;
  const covered = usable ? heard / durationSecs : 0;
  const spanned = usable && first !== undefined && last !== undefined ? last.end / durationSecs : 0;
  const minutes = usable ? durationSecs / 60 : heard / 60;
  return {
    covered,
    maxGap,
    words,
    wordsPerMin: minutes > 0 ? words / minutes : 0,
    spanned,
    perfect: usable && covered >= MIN_COVERED && maxGap <= MAX_GAP_SECS,
  };
}

async function main(): Promise<number> {
  // ---- Guards, in this order, BEFORE any socket is opened -----------------
  //
  //  1. the arguments, including the production refusal (parseExpectDb);
  //  2. the environment: MEDIA_ROOT, and the interpreter, script and model. A
  //     missing one is a message that names it, here, rather than after the
  //     first recording has been read out of the database;
  //  3. only then does anything connect.
  const args = parseTranscribeArgs(process.argv.slice(2));
  loadDotenvIfPresent();
  const mediaRoot = resolveMediaRoot();

  let transcriber: Transcriber;
  try {
    transcriber = createTranscriberFromEnv();
  } catch (err) {
    if (err instanceof TranscriberError) throw new MediaError(err.message);
    throw err;
  }

  console.log(
    `Media root: ${mediaRoot}\nEngine:     ${transcriber.name}\n` +
      `Mode:       ${args.commit ? 'COMMIT — transcripts will be written' : 'dry run — nothing will be written'}`,
  );

  const client = await connectAdmin(args.expectDb, !args.commit);
  let done = 0;
  let failed = 0;
  const flagged: number[] = [];
  try {
    const pending = await findPending(client, args);
    if (pending.length === 0) {
      console.log('\nNothing is waiting for a transcript.');
      return 0;
    }

    const totalSecs = pending.reduce((sum, r) => sum + (r.durationSecs ?? 0), 0);
    console.log(
      `\n${String(pending.length)} recording(s) waiting, ${formatDuration(totalSecs)} of audio.` +
        ' Measured on this machine: about 2.7x real time, so roughly 40% of that' +
        ' in processing.',
    );

    for (const recording of pending) {
      const label = `#${String(recording.id)} (${recording.code ?? 'no code'})`;
      const length = recording.durationSecs === null ? '?' : formatDuration(recording.durationSecs);
      console.log(`\n${label}  ${recording.mediaKey}  ${length}`);

      if (!args.commit) {
        console.log(
          `  dry run: would transcribe with ${transcriber.name}` +
            `${recording.hasTranscript ? ' and REPLACE the transcript it already has' : ''}.`,
        );
        continue;
      }

      const startedAt = Date.now();
      let result: TranscriptResult;
      try {
        result = await transcriber.transcribe(localPathFor(mediaRoot, recording.mediaKey));
      } catch (err) {
        failed += 1;
        const reason = err instanceof TranscriberError ? err.reason : 'unexpected';
        // The status is recorded so the row stops looking like it is still
        // waiting, and the run carries on: one unreadable file must not stop
        // the other fourteen.
        await inTransaction(client, false, () => markTranscriptFailed(client, recording.id));
        console.error(
          `  FAILED after ${secs(Date.now() - startedAt)} (${reason}). ` +
            `transcript_status is now FAILED. ${(err as Error).message}`,
        );
        continue;
      }

      await inTransaction(client, false, () => storeTranscript(client, recording.id, result));
      done += 1;

      const wall = Date.now() - startedAt;
      const mediaSecs = result.durationSecs ?? recording.durationSecs;
      const cover = coverageOf(result.segments, mediaSecs);
      const labelled = result.segments.filter((s) => s.speaker !== undefined).length;
      console.log(
        `  done in ${secs(wall)}` +
          (mediaSecs === null || mediaSecs === 0
            ? ''
            : ` (${(mediaSecs / (wall / 1000)).toFixed(2)}x real time)`) +
          `: ${String(result.segments.length)} segments, ${String(cover.words)} words, ` +
          `language ${result.language ?? 'unknown'}.`,
      );
      console.log(
        `  covered ${(100 * cover.covered).toFixed(1)}% of the audio, ` +
          `longest gap ${cover.maxGap.toFixed(1)}s, ${cover.wordsPerMin.toFixed(0)} words/min, ` +
          `speaker known on ${String(labelled)} of ${String(result.segments.length)} lines.`,
      );
      if (!cover.perfect) {
        // NOT a failure and not a retry: the transcript is saved, because a
        // partial one is still worth reading. It is a line that says a person has
        // to go and listen to the parts the arithmetic says are missing.
        flagged.push(recording.id);
        // WHICH KIND of loss, because the two need different things done about
        // them and the difference is visible in the numbers:
        //   * the words stop early  -> the run was cut off. Re-run it.
        //   * a long gap in the middle -> a passage the decoder walked past.
        //     That is the failure the long vocabulary prompt caused. Listen to it.
        //   * neither, and the total is simply a little short -> pauses. A call
        //     with a lot of short silences covers less of its own length, and
        //     nothing is missing. Check, then ignore.
        const kind =
          cover.spanned < 0.95
            ? `the words stop at ${(100 * cover.spanned).toFixed(0)}% of the way through`
            : cover.maxGap > MAX_GAP_SECS
              ? `there is a ${cover.maxGap.toFixed(0)}-second hole in the middle of it`
              : 'the total is short but the words run the whole length, so this is probably pauses';
        console.log(
          `  ** LOOK AT THIS ONE ** ${kind}. Listen against the transcript before ` +
            'anybody relies on it.',
        );
      }
    }

    console.log(
      `\n${args.commit ? 'Written' : 'Dry run'}: ${String(done)} transcribed, ` +
        `${String(failed)} failed, ${String(pending.length - done - failed)} not attempted.`,
    );
    if (flagged.length > 0) {
      // Named, not counted, and never folded into an average: an average over
      // fifteen recordings hides the one that lost four minutes, which is the
      // whole failure this check exists to catch.
      console.log(
        `Recording(s) ${flagged.map((id) => `#${String(id)}`).join(', ')} did not cover the ` +
          'whole of their audio. Each one needs a listen against the transcript.',
      );
    }
    if (!args.commit) {
      console.log('Nothing was written. Re-run with --commit when the list above looks right.');
    }
    return failed > 0 ? 1 : 0;
  } finally {
    await client.end().catch(() => undefined);
  }
}

runIfMain(import.meta.url, 'transcribe', main);
