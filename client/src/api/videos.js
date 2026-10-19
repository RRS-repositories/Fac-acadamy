import { useQuery } from '@tanstack/react-query';
import { VideoLibraryResponseSchema } from '@fac-academy/shared';
import { ApiError } from './client.js';

/*
 * The video library data layer (user decision, 19 Oct) — the only place the
 * browser asks for the training videos that belong to no stage.
 *
 * A video is in the library exactly when `call_recordings.stage_id IS NULL`
 * (see LibraryVideoSchema in shared/contracts/media.ts for the design rules).
 * That has two consequences this module is built around:
 *
 *   * there is nothing to unlock, so there is no `locked` state to read and no
 *     stage code to pass. One query for the whole shelf;
 *   * there is nothing to record. Watching a library video pays no stage's
 *     listening requirement, so this module has no POST, no beacon and no
 *     cache to invalidate. It is read-only, which is why it is a separate file
 *     from media.js rather than three more exports in it.
 *
 * Nothing here holds a title, a description or a URL to a file: every string
 * the trainee reads arrives at runtime from the server.
 */

/** One object so the dashboard never invents a key. */
export const videoKeys = {
  all: ['videos'],
  library: () => ['videos', 'library'],
};

/**
 * Where the list comes from, and where one video's bytes come from.
 *
 * These two spellings belong beside the other path helpers in
 * shared/contracts/media.ts, and they should move there once the server side
 * has landed — they are here only because that file is being written in
 * parallel and does not export them yet. Whoever moves them must keep the
 * strings identical to the server's own routes: a client that asks the wrong
 * URL fails as a 404, which this module reads as "there is no library".
 */
export const VIDEO_LIBRARY_PATH = '/api/videos';

export function libraryVideoStreamPath(videoId) {
  return `/api/videos/${encodeURIComponent(String(videoId))}/stream`;
}

async function readJson(res) {
  try {
    return await res.json();
  } catch {
    return null;
  }
}

/**
 * GET /api/videos. Throws ApiError; the hook below swallows it on purpose.
 *
 * Exported so a test can drive the fetch without a cache, the same way
 * fetchTrack and fetchMyCertificates are.
 */
export async function fetchVideoLibrary() {
  let res;
  try {
    res = await fetch(VIDEO_LIBRARY_PATH, {
      method: 'GET',
      credentials: 'same-origin',
      headers: { Accept: 'application/json' },
    });
  } catch {
    throw new ApiError(0, 'network', 'The video library could not reach the server');
  }
  if (!res.ok) {
    const body = await readJson(res);
    const code = typeof body?.error === 'string' ? body.error : 'unknown';
    throw new ApiError(res.status, code, `The video library was refused (${String(res.status)})`);
  }

  const parsed = VideoLibraryResponseSchema.safeParse(await readJson(res));
  if (!parsed.success) throw new ApiError(200, 'bad_response', 'Unexpected response from server');
  return parsed.data;
}

/**
 * The trainee's video library. A failure resolves to null rather than
 * throwing, and the section renders nothing at all for null.
 *
 * That is the same decision as the summary and the transcript, for the same
 * reason: the library is a reference shelf beside somebody's training, and it
 * must never be the thing that keeps their stages off the screen. It also
 * covers a server that has no such endpoint yet and answers 404, which is what
 * every deployment looks like until the route ships.
 *
 * Kept fresh on a window focus, unlike the summary and the transcript: the
 * shelf is a short list that an ops ingest adds to, so somebody who leaves the
 * dashboard open all day should see a new video appear without a reload.
 */
export function useVideoLibrary() {
  return useQuery({
    queryKey: videoKeys.library(),
    queryFn: async () => {
      try {
        return await fetchVideoLibrary();
      } catch {
        return null;
      }
    },
    retry: false,
  });
}
