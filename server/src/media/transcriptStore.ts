import type pg from 'pg';
import type { TranscriptSegment } from '@fac-academy/shared';
import type { TranscriptResult } from './transcriber.js';

// Reading and writing the transcript columns of academy.call_recordings
// (migration 0010: transcript_segments, transcript_engine, transcript_at, on top
// of 0001's transcript and transcript_status).
//
// ONE place, shared by the two things that write a transcript: the worker's
// transcription handler (server/src/jobs/mediaJobs.ts) and the backlog script
// (ops/media/transcribe.ts). They run in different processes, as different
// database logins, on different machines — so if each had its own UPDATE they
// would drift, and a transcript written on the development machine would not be
// quite the same row as one written by the server. The plan has both of them
// writing for months, which makes that drift a certainty rather than a risk.
//
// Nothing in this file logs. Every value it touches is either the content of a
// real client call or a fact about one.
//
// A DECISION, TAKEN DELIBERATELY (28 Sep 2026): THE TRANSCRIPTS ARE STORED WHOLE,
// WITH NOTHING HELD BACK.
//
// A real call contains real personal details of a real client, and faster-whisper
// transcribes them correctly: dates of birth, partial postcodes, surnames, email
// addresses spelled out letter by letter. All of that is written to this column as
// it was said. There is no redaction step, no masking and no filter, and their
// absence is a CHOICE rather than an omission — the user asked for full
// transcripts, on the grounds that a training recording with holes punched in it
// teaches the wrong thing, and that anybody who can read the transcript can
// already press play and hear the same words.
//
// So: do not add masking here later on the assumption it was forgotten. If it is
// ever wanted, it is a new decision, and the honest place for it is the pipeline
// that writes the text, not a filter on the way out — a redacted read over an
// unredacted column is a promise the database cannot keep.
//
// What that decision does NOT relax is where the text may go. It lives in this
// column and is served by the gated endpoint in transcript.ts to somebody who
// could already play the recording. It is never logged, never printed by the ops
// script, never bundled and never written to a file outside the media folder.

/** Anything with pg's `query`: a Pool, a PoolClient or a Client. */
export type TranscriptDb = Pick<pg.ClientBase, 'query'>;

/** What the transcript columns of one recording hold. */
export interface TranscriptRow {
  /** 0001's transcript_status. */
  status: 'PENDING' | 'DONE' | 'FAILED' | 'NOT_REQUIRED';
  /** The transcript text, or null when there is none. Blank counts as none. */
  text: string | null;
  /**
   * The timed lines. Empty when there are none — which is legal and normal for a
   * transcript a person typed in: 0010 allows text without timings on purpose.
   */
  segments: TranscriptSegment[];
  mediaType: 'AUDIO' | 'VIDEO';
  /** Null for a "coming soon" slot (D4): there is nothing to transcribe. */
  mediaKey: string | null;
}

/**
 * Whatever is in transcript_segments, as an array we can trust.
 *
 * 0010's CHECK guarantees it is a JSONB array, and pg hands a JSONB array back
 * as a JavaScript array — but the elements are unchecked, and one malformed row
 * (a hand-written backfill, a future pipeline) must not throw on the way to a
 * player. Anything that is not a usable segment is dropped, and the rest is
 * served. A partly readable transcript is better than a broken page.
 */
export function readSegments(value: unknown): TranscriptSegment[] {
  if (!Array.isArray(value)) return [];
  const out: TranscriptSegment[] = [];
  for (const raw of value) {
    if (typeof raw !== 'object' || raw === null) continue;
    const { start, end, text } = raw as Record<string, unknown>;
    if (typeof start !== 'number' || !Number.isFinite(start) || start < 0) continue;
    if (typeof end !== 'number' || !Number.isFinite(end)) continue;
    if (typeof text !== 'string' || text.trim() === '') continue;
    const line: TranscriptSegment = { start, end: Math.max(start, end), text: text.trim() };
    // The speaker is optional and anything unrecognised is dropped rather than
    // passed on: the panel shows a line with no speaker perfectly well (it means
    // nobody could tell which channel said it), and a row written by hand or by
    // some later pipeline must not be able to put an arbitrary string in front of
    // a trainee.
    const { speaker } = raw as Record<string, unknown>;
    if (speaker === 'A' || speaker === 'B') line.speaker = speaker;
    out.push(line);
  }
  out.sort((a, b) => a.start - b.start || a.end - b.end);
  return out;
}

/** The transcript of one recording, or null when there is no such active row. */
export async function loadTranscriptRow(
  db: TranscriptDb,
  recordingId: number,
): Promise<TranscriptRow | null> {
  const { rows } = await db.query<{
    transcript_status: TranscriptRow['status'];
    transcript: string | null;
    transcript_segments: unknown;
    media_type: TranscriptRow['mediaType'];
    media_key: string | null;
  }>(
    `SELECT transcript_status, transcript, transcript_segments, media_type, media_key
       FROM academy.call_recordings
      WHERE id = $1 AND is_active`,
    [recordingId],
  );
  const row = rows[0];
  if (row === undefined) return null;
  const text = row.transcript !== null && row.transcript.trim() !== '' ? row.transcript : null;
  return {
    status: row.transcript_status,
    text,
    // Timings with no text are meaningless and 0010 forbids them, but a reader
    // must not depend on a constraint it cannot see.
    segments: text === null ? [] : readSegments(row.transcript_segments),
    mediaType: row.media_type,
    mediaKey: row.media_key,
  };
}

/**
 * Write one transcript: the text, its timings, what produced it, when, and the
 * status that says it is done.
 *
 * ONE statement, so the text and its timings can never be half-replaced — a
 * re-transcription with a better model overwrites both together or neither.
 * `transcript_segments` is passed as JSON text and cast, which is the only value
 * here that is not a scalar.
 */
export async function storeTranscript(
  db: TranscriptDb,
  recordingId: number,
  result: TranscriptResult,
): Promise<void> {
  await db.query(
    `UPDATE academy.call_recordings
        SET transcript = $2,
            transcript_segments = $3::jsonb,
            transcript_engine = $4,
            transcript_at = now(),
            transcript_status = 'DONE'
      WHERE id = $1`,
    [recordingId, result.text, JSON.stringify(result.segments), result.engine],
  );
}

/**
 * Record that transcribing this recording did not work.
 *
 * Only the status moves. Any text already on the row is left exactly where it is:
 * a failed re-run of a recording that already had a transcript must not take the
 * transcript away, and a trainee reading along should not lose the words because
 * a later job crashed.
 */
export async function markTranscriptFailed(db: TranscriptDb, recordingId: number): Promise<void> {
  await db.query(`UPDATE academy.call_recordings SET transcript_status = 'FAILED' WHERE id = $1`, [
    recordingId,
  ]);
}

/**
 * Record that this recording is not going to be transcribed.
 *
 * 0001's fourth status, and the honest one for a screen recording: videos are out
 * of scope for version one (plan §7 — a transcript of a walkthrough is worth much
 * less than one of a call), and leaving their jobs to complete while the row says
 * PENDING for ever would make the backlog unreadable. It is reversible: set the
 * status back to PENDING and re-queue, which is how the decision gets revisited.
 */
export async function markTranscriptNotRequired(
  db: TranscriptDb,
  recordingId: number,
): Promise<void> {
  await db.query(
    `UPDATE academy.call_recordings
        SET transcript_status = 'NOT_REQUIRED'
      WHERE id = $1 AND transcript_status = 'PENDING'`,
    [recordingId],
  );
}
