import { useCallback, useRef } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  MEDIA_MAX_INTERVALS,
  MediaProgressResponseSchema,
  RecordingSummaryResponseSchema,
  RecordingTranscriptResponseSchema,
  mediaProgressPath,
  mediaStreamPath,
  recordingSummaryPath,
  recordingTranscriptPath,
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

export { mediaStreamPath, mediaProgressPath, recordingSummaryPath, recordingTranscriptPath };

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
 * Resolves to { listened, coveredSecs, durationSecs, requiredSecs, acceptedTo }.
 * `acceptedTo` is how far up the intervals just sent the server counted, so the
 * caller knows what it still owes; see NoSeekPlayer's `owedAbove`.
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

/* -------------------------------------------------------------------------- *
 * The one saved summary of what was said on a recording
 * -------------------------------------------------------------------------- *
 *
 * The summary belongs to the RECORDING, not to the trainee: the first person to
 * press the button waits for the model, and everybody after them is handed the
 * stored text straight away. So there is nothing per-person to cache here, and
 * the mutation's answer is simply written into the query's cache — no refetch,
 * because the response IS the new state.
 *
 * Every state the button can be in comes from the server (`state` in the shared
 * contract). The browser decides nothing: it does not know whether a transcript
 * exists, whether the feature is switched on, or whether somebody else is having
 * the same recording summarised at this moment.
 */

/** One query key per recording, so the mutation writes where the query reads. */
export const summaryKeys = {
  summary: (recordingId) => ['media', 'summary', recordingId],
};

function summaryFailureFrom(status, body) {
  const code = typeof body?.error === 'string' ? body.error : 'unknown';
  return new ApiError(status, code, `The summary request was refused (${status} ${code})`);
}

async function summaryRequest(method, recordingId) {
  let res;
  try {
    res = await fetch(recordingSummaryPath(recordingId), {
      method,
      credentials: 'same-origin',
      headers: { Accept: 'application/json' },
    });
  } catch {
    throw new ApiError(0, 'network', 'The summary request could not reach the server');
  }
  if (!res.ok) throw summaryFailureFrom(res.status, await readJson(res));

  const parsed = RecordingSummaryResponseSchema.safeParse(await readJson(res));
  if (!parsed.success) throw new ApiError(200, 'bad_response', 'Unexpected response from server');
  return parsed.data;
}

/** GET the current state. Never causes a model call, whatever state it is in. */
export function fetchRecordingSummary(recordingId) {
  return summaryRequest('GET', recordingId);
}

/**
 * POST: the saved summary if there is one, and otherwise make it, save it and
 * return it. Pressed twice by two people at once, only one model call happens;
 * the other is told `working` and can press again.
 */
export function requestRecordingSummary(recordingId) {
  return summaryRequest('POST', recordingId);
}

/**
 * What state this recording's summary is in. A failure resolves to null rather
 * than throwing: a summary is a convenience beside the player, and it must never
 * be the reason a trainee cannot get on with a recording. The component renders
 * nothing at all when this is null.
 */
export function useRecordingSummary(recordingId) {
  return useQuery({
    queryKey: summaryKeys.summary(recordingId),
    queryFn: async () => {
      try {
        return await fetchRecordingSummary(recordingId);
      } catch {
        return null;
      }
    },
    retry: false,
    // The summary never changes once it exists, and while it does not exist only
    // a press changes anything. Refetching on every window focus would ask the
    // server the same question all day.
    refetchOnWindowFocus: false,
    staleTime: Infinity,
  });
}

/** The button's press. On success the answer becomes the cached state. */
export function useSummariseRecording(recordingId) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => requestRecordingSummary(recordingId),
    onSuccess: (data) => {
      queryClient.setQueryData(summaryKeys.summary(recordingId), data);
    },
  });
}

/* -------------------------------------------------------------------------- *
 * The transcript, as timed lines
 * -------------------------------------------------------------------------- *
 *
 * What was said on the recording, with a start and end second per line, so the
 * panel under the player can highlight the line being spoken and let somebody
 * click back to one they have already heard.
 *
 * Read-only. There is no verb here that makes a transcript: they are written by
 * the worker and by the ops backlog script, away from any request, and a trainee
 * can neither cause one nor correct one.
 *
 * Like the summary, a transcript belongs to the RECORDING and not to the person
 * reading it, so there is nothing per-person to cache and nothing to refetch: it
 * is fetched once and kept.
 */

/** One query key per recording. */
export const transcriptKeys = {
  transcript: (recordingId) => ['media', 'transcript', recordingId],
};

/** GET the transcript. Throws ApiError; the hook below swallows it. */
export async function fetchRecordingTranscript(recordingId) {
  let res;
  try {
    res = await fetch(recordingTranscriptPath(recordingId), {
      credentials: 'same-origin',
      headers: { Accept: 'application/json' },
    });
  } catch {
    throw new ApiError(0, 'network', 'The transcript request could not reach the server');
  }
  if (!res.ok) {
    const body = await readJson(res);
    const code = typeof body?.error === 'string' ? body.error : 'unknown';
    throw new ApiError(res.status, code, `The transcript request was refused (${res.status})`);
  }

  const parsed = RecordingTranscriptResponseSchema.safeParse(await readJson(res));
  if (!parsed.success) throw new ApiError(200, 'bad_response', 'Unexpected response from server');
  return parsed.data;
}

/**
 * This recording's transcript. A failure resolves to null rather than throwing:
 * the transcript is something to read beside the player, and it must never be the
 * reason a trainee cannot get on with the recording. The panel renders nothing at
 * all when this is null — which also covers an older server that has no such
 * endpoint and answers 404.
 */
export function useRecordingTranscript(recordingId) {
  return useQuery({
    queryKey: transcriptKeys.transcript(recordingId),
    queryFn: async () => {
      try {
        return await fetchRecordingTranscript(recordingId);
      } catch {
        return null;
      }
    },
    retry: false,
    // A transcript is written once, by a job that finished long before this page
    // was opened. Asking again on every window focus would re-download the whole
    // text of every recording on the stage for no new information.
    refetchOnWindowFocus: false,
    staleTime: Infinity,
  });
}
