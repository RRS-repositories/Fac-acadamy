import { z } from 'zod';

// Media contract (S06): proof of a full listen, the manager upload result, and
// the one saved summary of what was said on a recording.
//
// There is no S3 (user decision, 23 Sep): media lives on local disk behind
// `GET /api/media/:recordingId/stream`, which is gate-checked like every other
// piece of content. This file ships to the browser, so it holds SHAPES only —
// never a media key that was not already handed out, never a file path.
//
// The client reports what it has PLAYED as a list of [from, to] second
// intervals. It is a claim, not a fact: the server merges those intervals into
// `academy.listen_progress.coverage`, charges them against the wall-clock time
// that has actually passed, and decides `listened` itself. The badge the
// trainee sees comes back in the response — the browser never decides it.

/**
 * How often the player flushes its intervals while media is playing. The
 * server's rate limit and its first-beacon allowance are both sized from this,
 * so the two ends must agree: keep them in this one place.
 */
export const MEDIA_BEACON_INTERVAL_MS = 5_000;

/** Most intervals one beacon may carry. A honest beacon carries one or two. */
export const MEDIA_MAX_INTERVALS = 200;

/**
 * One played stretch, in seconds from the start of the media: `[from, to]`.
 * Reversed pairs are rejected here; the server still clamps and re-checks
 * everything, because a contract is not a guard.
 */
export const MediaIntervalSchema = z
  .tuple([z.number().finite(), z.number().finite()])
  .refine(([from, to]) => from <= to, { message: 'interval must be [from, to] with from <= to' });
export type MediaInterval = z.infer<typeof MediaIntervalSchema>;

/** POST /api/media/:recordingId/progress */
export const MediaProgressRequestSchema = z.object({
  intervals: z.array(MediaIntervalSchema).min(1).max(MEDIA_MAX_INTERVALS),
});
export type MediaProgressRequest = z.infer<typeof MediaProgressRequestSchema>;

/**
 * The server's answer, and the only thing the badge is allowed to reflect.
 * `durationSecs` is null when the recording's length is not known yet, and
 * `listened` can never be true in that case: a full listen cannot be proved
 * against an unknown length.
 */
export const MediaProgressResponseSchema = z.object({
  listened: z.boolean(),
  coveredSecs: z.number(),
  durationSecs: z.number().int().nullable(),
  requiredSecs: z.number(),
  /**
   * The furthest media position, in seconds, that THIS request's intervals were
   * credited up to — null when none of them were.
   *
   * The server admits intervals in ascending order and shortens the one that
   * exhausts its wall-clock budget, so anything the client sent above this
   * point has not been counted yet. The client keeps that remainder and sends
   * it again with the next beacon. Without it the client would restart from
   * what it sent, the uncounted tail would never be re-offered, and every
   * shortfall would become a permanent hole in the coverage — which is exactly
   * the defect found on 25 Sep 2026.
   */
  acceptedTo: z.number().nullable(),
});
export type MediaProgressResponse = z.infer<typeof MediaProgressResponseSchema>;

// ---------------------------------------------------------------------------
// The one saved summary of a recording (migration 0009)
// ---------------------------------------------------------------------------

/**
 * What the server knows about a recording's summary right now.
 *
 *   disabled       the feature is switched off, or no model is configured. The
 *                  client shows nothing at all; there is no button.
 *   no_transcript  the recording has not been transcribed, so there is nothing
 *                  to summarise. Transcription is separate, later work: today
 *                  this is the state of every recording. The button is shown
 *                  but does nothing, and it says why — it must never pretend.
 *   ready          there is a transcript and no summary: pressing will make one.
 *   working        somebody else pressed it a moment ago and the model is
 *                  answering them. The second press does NOT start a second
 *                  model call; it says "one is being written" and can be tried
 *                  again. One model call per recording, ever, is the point.
 *   done           there is a saved summary, and `summary` holds it.
 */
export const RECORDING_SUMMARY_STATES = [
  'disabled',
  'no_transcript',
  'ready',
  'working',
  'done',
] as const;
export type RecordingSummaryState = (typeof RECORDING_SUMMARY_STATES)[number];

/**
 * GET  /api/media/:recordingId/summary — what state it is in. Never calls a model.
 * POST /api/media/:recordingId/summary — the saved summary if there is one, and
 *      otherwise: generate it, save it, return it.
 *
 * Both answer with this same shape, so the client has one reader. The summary is
 * a property of the RECORDING, not of the trainee: the first person to press the
 * button pays for the model call and everybody after them is served the stored
 * text.
 *
 * `summary` is a summary of WHAT WAS SAID ON THE CALL, made from the transcript.
 * It is not lesson content and it is not a mark: nothing here judges how the
 * agent performed, on purpose (that is a manager's job, and putting a model's
 * opinion of a colleague in front of trainees would be unfair).
 */
export const RecordingSummaryResponseSchema = z.object({
  recordingId: z.number().int(),
  state: z.enum(RECORDING_SUMMARY_STATES),
  /** The saved text. Non-null only when `state` is 'done'. */
  summary: z.string().nullable(),
  /** Which model wrote it, as recorded with the summary. Null until then. */
  model: z.string().nullable(),
  /** ISO timestamp of when it was written. Null until then. */
  generatedAt: z.string().nullable(),
});
export type RecordingSummaryResponse = z.infer<typeof RecordingSummaryResponseSchema>;

/** The summary URL for a recording. One spelling, used by the client and tests. */
export function recordingSummaryPath(recordingId: number | string): string {
  return `/api/media/${encodeURIComponent(String(recordingId))}/summary`;
}

// ---------------------------------------------------------------------------
// The transcript, as timed lines (migration 0010)
// ---------------------------------------------------------------------------

/**
 * One timed line of a transcript: what was said, and between which two seconds.
 *
 * `start` and `end` are seconds from the start of the media — the same unit and
 * the same origin as the player's own `currentTime` and as the intervals above,
 * so nothing has to convert anything to line them up.
 *
 * Fractions, not whole seconds: faster-whisper answers to the hundredth, and
 * rounding would make two short lines share a start and the highlight jump.
 *
 * `text` is the words. It is CONTENT — what was said on a real client call — so
 * it is served only through the gated endpoint below, to a trainee who could
 * play the recording anyway, and it is never bundled, cached by a shared cache
 * or logged.
 */
/**
 * Which of the two channels said a line: 'A' is the left channel and 'B' the
 * right. Nothing more is claimed than that.
 *
 * The call recordings are true dual-channel — one person per channel, which is how
 * the telephony system records them — so "who is talking" is a question about
 * which channel is louder, and it is answered without any model at all
 * (ops/media/transcribe.py). Measured across every recording we hold: the two
 * channels are uncorrelated, never identical, and comparable over only 1-4% of the
 * speaking seconds.
 *
 * DELIBERATELY NOT 'AGENT' AND 'CLIENT'. Which side the agent sits on is a
 * property of the phone system rather than of the audio, and it is not the same on
 * every recording we hold. Calling the louder half "the agent" would be a guess
 * printed as a fact, and a transcript that attributes the compliance script to the
 * client is worse than one that says "Speaker 1".
 */
export const TRANSCRIPT_SPEAKERS = ['A', 'B'] as const;
export type TranscriptSpeaker = (typeof TRANSCRIPT_SPEAKERS)[number];

export const TranscriptSegmentSchema = z.object({
  start: z.number().finite().min(0),
  end: z.number().finite().min(0),
  text: z.string(),
  /**
   * OPTIONAL, and its absence is meaningful: it means nobody could tell. Either
   * the two channels were comparable over the line (crosstalk, both at once) or
   * the line straddles a change of speaker. A transcript made before this existed,
   * one typed in by a person, and one of a file that turned out to be mono all
   * have no speaker on any line — which is why every reader must cope with it
   * missing rather than treating it as a fault.
   */
  speaker: z.enum(TRANSCRIPT_SPEAKERS).optional(),
});
export type TranscriptSegment = z.infer<typeof TranscriptSegmentSchema>;

/**
 * GET /api/media/:recordingId/transcript
 *
 * Three honest states, and no fourth:
 *
 *   `text` null                  there is no transcript. The panel says so in
 *                                plain words and shows no empty box. Today this
 *                                is every recording until the pipeline has run.
 *   `text` set, `segments` []    there are words but no timings — a transcript
 *                                typed or pasted in by a person. The panel shows
 *                                it and says it cannot follow along, rather than
 *                                inventing times in order to highlight something.
 *   `text` set, `segments` set    the panel follows the audio.
 *
 * `status` is the pipeline's own marker (0001's transcript_status), passed
 * through so the panel can tell "not done yet" from "tried and failed" — those
 * are different things to say to somebody waiting for one.
 *
 * There is no 'disabled' state and no feature flag. A transcript that exists is
 * shown; the flag guards whether any are MADE, which is a question for the
 * worker and not for the reader.
 */
export const TRANSCRIPT_STATUSES = ['PENDING', 'DONE', 'FAILED', 'NOT_REQUIRED'] as const;
export type TranscriptStatus = (typeof TRANSCRIPT_STATUSES)[number];

export const RecordingTranscriptResponseSchema = z.object({
  recordingId: z.number().int(),
  status: z.enum(TRANSCRIPT_STATUSES),
  /** The whole transcript as plain text. Null when there is none. */
  text: z.string().nullable(),
  /** The timed lines, in ascending order of `start`. Empty when there are none. */
  segments: z.array(TranscriptSegmentSchema),
});
export type RecordingTranscriptResponse = z.infer<typeof RecordingTranscriptResponseSchema>;

/** The transcript URL for a recording. One spelling, used by the client and tests. */
export function recordingTranscriptPath(recordingId: number | string): string {
  return `/api/media/${encodeURIComponent(String(recordingId))}/transcript`;
}

/** POST /api/manager/recordings (manager only) — what the upload created. */
export const ManagerUploadResponseSchema = z.object({
  recordingId: z.number().int(),
  /** The store's key for the object. Never a filesystem path. */
  mediaKey: z.string(),
  byteSize: z.number().int(),
  durationSecs: z.number().int().nullable(),
  contentType: z.string(),
});
export type ManagerUploadResponse = z.infer<typeof ManagerUploadResponseSchema>;

/** Every media failure is `{ error: MediaErrorCode }`, status as noted. */
export const MEDIA_ERROR_CODES = [
  'locked', // 403 the recording's stage is not unlocked for this trainee
  'not_found', // 404 no such recording, or it has no media (a "coming soon" slot)
  'invalid_request', // 400 malformed body, parameter or range
  'too_large', // 413 upload over the size limit
  'unsupported_type', // 415 upload is not an accepted audio or video type
  'rate_limited', // 429 too many beacons or uploads
  // 502 the summary model could not be reached, failed, or took too long.
  // NOTHING was saved, so the button can honestly be pressed again.
  'summary_failed',
] as const;
export type MediaErrorCode = (typeof MEDIA_ERROR_CODES)[number];
export const MediaErrorSchema = z.object({ error: z.enum(MEDIA_ERROR_CODES) });
export type MediaError = z.infer<typeof MediaErrorSchema>;

/** The stream URL for a recording. One spelling, used by the player and tests. */
export function mediaStreamPath(recordingId: number | string): string {
  return `/api/media/${encodeURIComponent(String(recordingId))}/stream`;
}

/** The progress URL for a recording. */
export function mediaProgressPath(recordingId: number | string): string {
  return `/api/media/${encodeURIComponent(String(recordingId))}/progress`;
}
