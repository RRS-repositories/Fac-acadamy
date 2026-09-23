import { useCallback, useRef } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import {
  MEDIA_MAX_INTERVALS,
  MediaProgressResponseSchema,
  mediaProgressPath,
  mediaStreamPath,
} from '@fac-academy/shared';
import { ApiError } from './client.js';
import { trainingKeys } from './training.js';

/*
 * The media data layer (S06). Two things only: where the bytes come from, and
 * where the player reports what it played.
 *
 * The browser NEVER decides whether a recording has been listened to. It sends
 * the stretches it played and the server answers with `listened`. That answer
 * is the only thing the badge is allowed to show, which is why this module
 * returns the parsed response rather than a boolean the caller computed.
 */

export { mediaStreamPath, mediaProgressPath };

/** Most intervals one request may carry — the shared contract's own limit. */
export const MAX_INTERVALS = MEDIA_MAX_INTERVALS;

async function readJson(res) {
  try {
    return await res.json();
  } catch {
    return null;
  }
}

function failureFrom(status, body) {
  const code = typeof body?.error === 'string' ? body.error : 'unknown';
  return new ApiError(status, code, `Listening progress rejected (${status} ${code})`);
}

/**
 * POST /api/media/:id/progress with the intervals played so far.
 * Resolves to { listened, coveredSecs, durationSecs, requiredSecs }.
 */
export async function postListenProgress(recordingId, intervals) {
  let res;
  try {
    res = await fetch(mediaProgressPath(recordingId), {
      method: 'POST',
      credentials: 'same-origin',
      headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
      body: JSON.stringify({ intervals }),
    });
  } catch {
    throw new ApiError(0, 'network', 'Listening progress could not reach the server');
  }
  if (!res.ok) throw failureFrom(res.status, await readJson(res));

  const parsed = MediaProgressResponseSchema.safeParse(await readJson(res));
  if (!parsed.success) throw new ApiError(200, 'bad_response', 'Unexpected response from server');
  return parsed.data;
}

/**
 * The reporter a player uses: `report(intervals)` posts them and, the first
 * time the server says the recording is finished, refreshes the stage and the
 * track so the pills, the rail and the dashboard agree with it.
 *
 * It is a plain function rather than a react-query mutation because it is
 * called from a timer and from media events, several times a minute, and none
 * of those calls wants a re-render of their own.
 */
export function useListenReporter(recordingId, stageCode) {
  const queryClient = useQueryClient();
  const wasListened = useRef(false);

  return useCallback(
    async (intervals) => {
      const result = await postListenProgress(recordingId, intervals.slice(-MAX_INTERVALS));
      if (result.listened && !wasListened.current) {
        wasListened.current = true;
        if (stageCode) {
          queryClient.invalidateQueries({ queryKey: trainingKeys.stage(stageCode) });
        }
        queryClient.invalidateQueries({ queryKey: trainingKeys.track() });
      }
      return result;
    },
    [queryClient, recordingId, stageCode],
  );
}
