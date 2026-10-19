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

// ---------------------------------------------------------------------------
// The video library (user decision, 19 Oct)
// ---------------------------------------------------------------------------
//
// A recording whose `stage_id` is NULL belongs to no stage, and a stage is the
// only thing gate() knows how to lock. So these rows are a shelf rather than a
// course: listed under the trainee's department training, watchable whenever
// they like, and worth nothing towards any stage's listening requirement.
//
// The two lookups below are DELIBERATELY SEPARATE FROM loadGatedRecording
// above, which inner-joins academy.stages and therefore already answers null —
// and so 404 — for a stage-less row. That function guards every piece of stage
// content in the product; widening it to serve the shelf as well would make one
// query answer two questions with opposite answers, and the day somebody got
// the condition slightly wrong a locked stage's call would be on the shelf.
// Two queries that can each only ever return one kind of row is the point.
//
// Every one of the four conditions here is load-bearing, in both lookups:
//
//   is_active              a withdrawn row is gone from the shelf as well.
//   stage_id IS NULL       this is what "in the library" MEANS. It is also what
//                          keeps a stage's recording — locked or not — out of
//                          these results, however well somebody guesses its id.
//   media_type = 'VIDEO'   the library is a video shelf. A stage-less AUDIO row
//                          is a call recording waiting to be filed, not
//                          training material anybody asked to be shown.
//   media_key IS NOT NULL  an empty "coming soon" slot (D4) is a plan, not a
//                          video. There is nothing to play, so it is not listed.

/** One row of the list: exactly the contract's LibraryVideo, nothing more. */
export interface LibraryVideoRow {
  id: number;
  title: string;
  description: string | null;
  /** academy.call_recordings.duration_secs — null when it was never probed. */
  durationSecs: number | null;
}

/** A library video with the facts the streaming route needs about its file. */
export interface LibraryRecording extends LibraryVideoRow {
  /**
   * The store key. Non-null by the query's own WHERE clause, unlike
   * GatedRecording.mediaKey, so the route has no empty case to handle. It is
   * never put in a response or a log.
   */
  mediaKey: string;
  /** The type recorded at upload from the file's own bytes. See 0005. */
  contentType: string | null;
}

/**
 * Every video on the shelf, in the order it should be shown.
 *
 * `position` first, because that is the column a human sets when they decide
 * which video a new starter should see first; `id` second, because the order
 * must be TOTAL. The unique index on (stage_id, position) covers only rows with
 * a stage, so nothing stops two library rows sharing a position or having none
 * at all, and without the tiebreak Postgres would be free to return those two
 * in either order — the shelf would reshuffle itself between page loads.
 *
 * NULLS LAST is spelled out rather than left to the default: a row nobody has
 * ordered belongs at the end of the shelf, not at the top of it.
 */
export async function listLibraryVideos(db: Db): Promise<LibraryVideoRow[]> {
  const { rows } = await db.query<{
    id: string;
    title: string;
    description: string | null;
    duration_secs: number | null;
  }>(
    `SELECT r.id,
            r.title,
            r.description,
            r.duration_secs
       FROM academy.call_recordings r
      WHERE r.is_active
        AND r.stage_id IS NULL
        AND r.media_type = 'VIDEO'
        AND r.media_key IS NOT NULL
      ORDER BY r.position ASC NULLS LAST, r.id ASC`,
  );
  return rows.map((row) => ({
    id: Number(row.id),
    title: row.title,
    description: row.description,
    durationSecs: row.duration_secs,
  }));
}

/**
 * One library video by id, or null.
 *
 * Null means "not on the shelf", and it covers no such row, a withdrawn row, an
 * empty slot, a stage-less audio recording AND — the case that matters — a
 * recording that belongs to a stage. Somebody who knows the id of a locked
 * stage's call gets null here just as they get null from loadGatedRecording's
 * join, so the shelf is not a second door into stage content.
 */
export async function loadLibraryRecording(
  db: Db,
  recordingId: number,
): Promise<LibraryRecording | null> {
  const { rows } = await db.query<{
    id: string;
    title: string;
    description: string | null;
    duration_secs: number | null;
    media_key: string;
    content_type: string | null;
  }>(
    `SELECT r.id,
            r.title,
            r.description,
            r.duration_secs,
            r.media_key,
            r.content_type
       FROM academy.call_recordings r
      WHERE r.id = $1
        AND r.is_active
        AND r.stage_id IS NULL
        AND r.media_type = 'VIDEO'
        AND r.media_key IS NOT NULL`,
    [recordingId],
  );
  const row = rows[0];
  if (row === undefined) return null;
  return {
    id: Number(row.id),
    title: row.title,
    description: row.description,
    durationSecs: row.duration_secs,
    mediaKey: row.media_key,
    contentType: row.content_type,
  };
}
