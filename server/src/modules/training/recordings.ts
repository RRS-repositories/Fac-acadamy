import type { Db } from './repo.js';

// Stage-side lookups for one call recording (S06). The media routes need to
// know which STAGE a recording belongs to before they can ask gate() about it,
// and gate() speaks in stage codes. That join lives here, next to the rest of
// the training SQL, rather than in the media module: the media module streams
// bytes and counts seconds, it does not decide who may see what.

export interface GatedRecording {
  id: number;
  /** The stage whose lock governs this recording. */
  stageCode: string;
  stageId: number;
  title: string;
  /** academy.call_recordings.duration_secs — null when it has not been probed. */
  durationSecs: number | null;
  mediaType: 'AUDIO' | 'VIDEO';
  /** The store key. Null for a "coming soon" slot (D4), which has no media. */
  mediaKey: string | null;
  /**
   * academy.call_recordings.content_type (migration 0005): the type recorded
   * when the file was uploaded, read from the file's own bytes. The stream
   * endpoint serves this rather than guessing from the file name. Null for a
   * slot with no media, and for a row seeded before the upload ran.
   */
  contentType: string | null;
}

/**
 * One active recording with the stage that gates it, or null.
 *
 * Null covers three cases the caller must treat the same way — no such row, an
 * inactive row, and an unassigned library item with no stage — because none of
 * them may be streamed or listened to, and telling them apart would leak what
 * the library holds.
 */
export async function loadGatedRecording(
  db: Db,
  recordingId: number,
): Promise<GatedRecording | null> {
  const { rows } = await db.query<{
    id: string;
    stage_id: string;
    stage_code: string;
    title: string;
    duration_secs: number | null;
    media_type: string;
    media_key: string | null;
    content_type: string | null;
  }>(
    `SELECT r.id,
            r.stage_id,
            s.code AS stage_code,
            r.title,
            r.duration_secs,
            r.media_type,
            r.media_key,
            r.content_type
       FROM academy.call_recordings r
       JOIN academy.stages s ON s.id = r.stage_id AND s.is_active
      WHERE r.id = $1 AND r.is_active`,
    [recordingId],
  );
  const row = rows[0];
  if (row === undefined) return null;
  return {
    id: Number(row.id),
    stageId: Number(row.stage_id),
    stageCode: row.stage_code,
    title: row.title,
    durationSecs: row.duration_secs,
    mediaType: row.media_type === 'VIDEO' ? 'VIDEO' : 'AUDIO',
    mediaKey: row.media_key,
    contentType: row.content_type,
  };
}
