import { z } from 'zod';

// Media contract (S06): proof of a full listen, and the manager upload result.
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
});
export type MediaProgressResponse = z.infer<typeof MediaProgressResponseSchema>;

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
