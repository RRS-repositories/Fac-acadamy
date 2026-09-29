import { Router } from 'express';
import type { Request, Response } from 'express';
import { RecordingTranscriptResponseSchema } from '@fac-academy/shared';
import type { MediaErrorCode, RecordingTranscriptResponse } from '@fac-academy/shared';
import { authOf, requireAuth } from '../middleware/auth.js';
import { gate } from '../modules/training/gate.js';
import { loadGatedRecording } from '../modules/training/recordings.js';
import type { TrainingDeps } from '../modules/training/repo.js';
import { loadTranscriptRow } from './transcriptStore.js';
import type { TranscriptRow } from './transcriptStore.js';

// GET /api/media/:recordingId/transcript — the transcript of one recording, as
// timed lines, for the panel under the player (migration 0010).
//
// A transcript is THE CONTENT OF A REAL CLIENT CALL, written down. That makes it
// exactly as sensitive as the audio, and it sits behind exactly the same doors as
// the bytes do:
//
//   1. the ACADEMY_V2 flag (app.ts mounts the flag gate on /api first),
//   2. requireAuth — no session, no transcript,
//   3. the one gate(), on the recording's own stage, the same call the stream
//      endpoint, the beacon and the summary make. A trainee who cannot play the
//      recording must not be able to read it: a transcript of a locked stage's
//      call is the locked stage's content, verbatim.
//
// And two rules of its own:
//
//   * `Cache-Control: private, no-store`, like the stream. No shared cache and no
//     disk copy may keep a transcript.
//   * READ ONLY. There is no verb here that writes a transcript. They are written
//     by the worker's transcription handler and by ops/media/transcribe.ts, both
//     of which run away from any request, and neither of which a browser can
//     reach. A trainee cannot cause a transcription and cannot correct one.
//
// There is no feature flag and no 'disabled' state, unlike the summary: a
// transcript that exists is shown to somebody who may hear it anyway. The flag
// (ACADEMY_TRANSCRIBE) decides whether any are MADE, which is the worker's
// question and not the reader's.

function fail(res: Response, status: number, error: MediaErrorCode): void {
  res.status(status).json({ error });
}

const RECORDING_ID = /^[0-9]{1,15}$/;

/** The response for one row, through the shared contract like every other. */
export function transcriptPayloadFor(
  recordingId: number,
  row: TranscriptRow,
): RecordingTranscriptResponse {
  return RecordingTranscriptResponseSchema.parse({
    recordingId,
    status: row.status,
    text: row.text,
    // Never timings without words: the client would draw clickable empty lines.
    segments: row.text === null ? [] : row.segments,
  });
}

export function mediaTranscriptRouter(deps: TrainingDeps): Router {
  const router = Router();

  router.get('/:recordingId/transcript', requireAuth(deps), async (req: Request, res: Response) => {
    const { traineeId } = authOf(req);
    const raw = String(req.params.recordingId ?? '');
    if (!RECORDING_ID.test(raw)) {
      fail(res, 400, 'invalid_request');
      return;
    }
    const recordingId = Number(raw);

    // A "coming soon" slot has no media and so nothing was ever said on it; it
    // answers exactly like a recording that does not exist (D4).
    const recording = await loadGatedRecording(deps.db, recordingId);
    if (recording === null || recording.mediaKey === null) {
      fail(res, 404, 'not_found');
      return;
    }

    const allowed = await gate(deps.db, traineeId, recording.stageCode, {
      stage1AuthRequired: deps.stage1AuthRequired,
    });
    if (!allowed.allowed) {
      // A stage on another track is never acknowledged, locked or not.
      if (allowed.reason === 'not_visible' || allowed.reason === 'not_found') {
        fail(res, 404, 'not_found');
        return;
      }
      res.status(403).json({ error: 'locked', requires: allowed.requires ?? null });
      return;
    }

    const row = await loadTranscriptRow(deps.db, recordingId);
    if (row === null) {
      fail(res, 404, 'not_found');
      return;
    }

    res.set('Cache-Control', 'private, no-store');
    res.status(200).json(transcriptPayloadFor(recordingId, row));
  });

  return router;
}
