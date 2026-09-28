import { Router } from 'express';
import type { Request, Response } from 'express';
import { RateLimiterMemory, RateLimiterRes } from 'rate-limiter-flexible';
import { RecordingSummaryResponseSchema } from '@fac-academy/shared';
import type { MediaErrorCode, RecordingSummaryResponse } from '@fac-academy/shared';
import { authOf, requireAuth } from '../middleware/auth.js';
import { actor, writeAudit } from '../modules/audit/audit.js';
import { gate } from '../modules/training/gate.js';
import { loadGatedRecording } from '../modules/training/recordings.js';
import type { Db, TrainingDeps } from '../modules/training/repo.js';
import { SummaryModelError } from './summaryModel.js';
import type { SummaryModel } from './summaryModel.js';

// GET  /api/media/:recordingId/summary — what state the summary is in.
// POST /api/media/:recordingId/summary — the saved summary, or make and save it.
//
// The one saved summary of what was said on a recording (migration 0009). The
// first person to press "Summarise" pays for the model call; it is stored on the
// recording and everybody after them is served the stored text, instantly. One
// model call per recording, ever — not one per trainee.
//
// It sits behind exactly the same doors as the bytes of the recording itself:
//
//   1. the ACADEMY_V2 flag (app.ts mounts the flag gate on /api first),
//   2. ACADEMY_CALL_SUMMARY and a configured model. Without them the route still
//      answers — with state 'disabled' — because a 404 here would be a lie and
//      the client would have no way to tell "off" from "no such recording",
//   3. requireAuth: no session, no summary,
//   4. the one gate(), on the recording's own stage, exactly as
//      media/routes.ts does it. A trainee who cannot play the recording must not
//      be able to read what was said on it — a summary of a locked stage's call
//      is the locked stage's content in fewer words.
//
// There is no manager bypass and no second permission path, on purpose.

/**
 * A press is one model call and a wait; a press on a recording that already has
 * a summary is one indexed read. Ten a minute per trainee is far more than
 * anyone can use and still refuses a script. Per trainee rather than per
 * (trainee, recording), because the cost being protected is the model's, and a
 * script would walk the library.
 *
 * In memory, like the beacon limiter: it is a politeness limit in front of the
 * real protection, which is the claim below — no amount of pressing produces a
 * second model call for the same recording.
 */
export const SUMMARY_LIMIT = { points: 10, duration: 60 };

/** The training dependencies plus the model, which may be absent. */
export interface MediaSummaryDeps extends TrainingDeps {
  /** null when ACADEMY_CALL_SUMMARY is off, or no model is configured. */
  model: SummaryModel | null;
}

const RECORDING_ID = /^[0-9]{1,15}$/;

function fail(res: Response, status: number, error: MediaErrorCode): void {
  res.status(status).json({ error });
}

/** What the database holds about one recording's summary. */
interface SummaryRow {
  summary: string | null;
  model: string | null;
  at: Date | null;
  /**
   * Whether there is transcript text to work from. Transcription is separate,
   * later work — the queue's handler is still a stub — so today this is false
   * for every recording, and the honest answer to a press is "not yet".
   *
   * It asks about the TEXT rather than transcript_status: the status is the
   * pipeline's own marker and a row can be given text without it (that is how
   * this feature was tested before a pipeline existed). Text present and not
   * blank is the only thing that decides whether there is anything to summarise.
   */
  hasTranscript: boolean;
}

/** The summary state, without pulling the transcript itself out of the row. */
async function loadSummaryRow(db: Db, recordingId: number): Promise<SummaryRow | null> {
  const { rows } = await db.query<{
    summary: string | null;
    summary_model: string | null;
    summary_at: Date | null;
    has_transcript: boolean;
  }>(
    `SELECT summary,
            summary_model,
            summary_at,
            (transcript IS NOT NULL AND btrim(transcript) <> '') AS has_transcript
       FROM academy.call_recordings
      WHERE id = $1`,
    [recordingId],
  );
  const row = rows[0];
  if (row === undefined) return null;
  return {
    summary: row.summary,
    model: row.summary_model,
    at: row.summary_at,
    hasTranscript: row.has_transcript,
  };
}

/** The transcript text, read only when a summary is actually about to be made. */
async function loadTranscript(db: Db, recordingId: number): Promise<string | null> {
  const { rows } = await db.query<{ transcript: string | null }>(
    'SELECT transcript FROM academy.call_recordings WHERE id = $1',
    [recordingId],
  );
  const text = rows[0]?.transcript ?? null;
  if (text === null || text.trim() === '') return null;
  return text;
}

/** The response for a row, parsed through the shared contract like every other. */
function payloadFor(recordingId: number, row: SummaryRow): RecordingSummaryResponse {
  if (row.summary !== null) {
    return RecordingSummaryResponseSchema.parse({
      recordingId,
      state: 'done',
      summary: row.summary,
      model: row.model,
      generatedAt: row.at === null ? null : row.at.toISOString(),
    });
  }
  return RecordingSummaryResponseSchema.parse({
    recordingId,
    state: row.hasTranscript ? 'ready' : 'no_transcript',
    summary: null,
    model: null,
    generatedAt: null,
  });
}

function plainState(
  recordingId: number,
  state: 'disabled' | 'working' | 'no_transcript',
): RecordingSummaryResponse {
  return RecordingSummaryResponseSchema.parse({
    recordingId,
    state,
    summary: null,
    model: null,
    generatedAt: null,
  });
}

export function mediaSummaryRouter(deps: MediaSummaryDeps): Router {
  const router = Router();
  const limiter = new RateLimiterMemory({ keyPrefix: 'academy-summary', ...SUMMARY_LIMIT });

  /**
   * Everything both verbs do before they differ: the id, the flag, the session's
   * trainee, the recording and the gate. Resolves to null when it has already
   * answered the request.
   */
  async function admit(
    req: Request,
    res: Response,
  ): Promise<{
    traineeId: number;
    recordingId: number;
    stageCode: string;
    model: SummaryModel;
  } | null> {
    const { traineeId } = authOf(req);
    const raw = String(req.params.recordingId ?? '');
    if (!RECORDING_ID.test(raw)) {
      fail(res, 400, 'invalid_request');
      return null;
    }
    const recordingId = Number(raw);

    // Switched off: answered before anything is looked up, so a disabled feature
    // costs one comparison and discloses nothing whatsoever about the recording.
    const model = deps.model;
    if (model === null) {
      res.set('Cache-Control', 'no-store');
      res.status(200).json(plainState(recordingId, 'disabled'));
      return null;
    }

    // A "coming soon" slot has no media and so has nothing that was said on it;
    // it answers exactly like a recording that does not exist (D4).
    const recording = await loadGatedRecording(deps.db, recordingId);
    if (recording === null || recording.mediaKey === null) {
      fail(res, 404, 'not_found');
      return null;
    }

    // THE gate, on the recording's stage — the same call the stream endpoint and
    // the beacon make, with the same answers.
    const allowed = await gate(deps.db, traineeId, recording.stageCode, {
      stage1AuthRequired: deps.stage1AuthRequired,
    });
    if (!allowed.allowed) {
      // A stage on another track is never acknowledged, locked or not.
      if (allowed.reason === 'not_visible' || allowed.reason === 'not_found') {
        fail(res, 404, 'not_found');
        return null;
      }
      res.status(403).json({ error: 'locked', requires: allowed.requires ?? null });
      return null;
    }

    return { traineeId, recordingId, stageCode: recording.stageCode, model };
  }

  // Read-only. Never calls a model, whatever state the recording is in: this is
  // what the button reads to decide whether to offer itself at all.
  router.get('/:recordingId/summary', requireAuth(deps), async (req, res) => {
    const admitted = await admit(req, res);
    if (admitted === null) return;

    const row = await loadSummaryRow(deps.db, admitted.recordingId);
    if (row === null) {
      fail(res, 404, 'not_found');
      return;
    }
    res.set('Cache-Control', 'no-store');
    res.status(200).json(payloadFor(admitted.recordingId, row));
  });

  router.post('/:recordingId/summary', requireAuth(deps), async (req, res) => {
    const admitted = await admit(req, res);
    if (admitted === null) return;
    const { traineeId, recordingId, stageCode, model } = admitted;

    try {
      await limiter.consume(String(traineeId));
    } catch (rejection) {
      if (!(rejection instanceof RateLimiterRes)) throw rejection;
      res.set('Retry-After', String(Math.ceil(rejection.msBeforeNext / 1000)));
      fail(res, 429, 'rate_limited');
      return;
    }

    // The cheap answer first: almost every press after the first one ends here.
    const existing = await loadSummaryRow(deps.db, recordingId);
    if (existing === null) {
      fail(res, 404, 'not_found');
      return;
    }
    if (existing.summary !== null || !existing.hasTranscript) {
      res.set('Cache-Control', 'no-store');
      res.status(200).json(payloadFor(recordingId, existing));
      return;
    }

    // -----------------------------------------------------------------------
    // The claim. Two trainees pressing at the same moment must produce ONE
    // model call, and 0009 adds no column to claim with (the summary is a
    // property of the recording; a status column would be a second place for
    // "is it there yet" to disagree). So the claim is a session-level advisory
    // lock on the recording, the same mechanism the quiz submit and the
    // listening beacon use for the same reason — except session-level rather
    // than transaction-level, because the model call must not be made with a
    // transaction held open behind it.
    //
    // Whoever gets the lock makes the call. Whoever does not gets 'working' and
    // may press again in a moment; it does NOT queue up behind them, because a
    // second waiter would just hold a connection for the same answer. The lock
    // lives on this one connection, so it is released on the way out however
    // this handler ends — and if the process dies mid-call the connection goes
    // with it and so does the lock. Nothing can be left claimed forever.
    // -----------------------------------------------------------------------
    const lockKey = `academy.summary:${String(recordingId)}`;
    const client = await deps.db.connect();
    let held = false;
    try {
      const claim = await client.query<{ got: boolean }>(
        'SELECT pg_try_advisory_lock(hashtextextended($1, 0)) AS got',
        [lockKey],
      );
      held = claim.rows[0]?.got === true;

      if (!held) {
        // Somebody else is asking the model right now. They may also have just
        // finished, so answer with what is there rather than assuming.
        const again = await loadSummaryRow(client, recordingId);
        res.set('Cache-Control', 'no-store');
        if (again !== null && again.summary !== null) {
          res.status(200).json(payloadFor(recordingId, again));
        } else {
          res.status(200).json(plainState(recordingId, 'working'));
        }
        return;
      }

      // Re-read under the lock: a press that started before ours may have
      // finished and saved between our cheap read above and this line.
      const fresh = await loadSummaryRow(client, recordingId);
      if (fresh !== null && fresh.summary !== null) {
        res.set('Cache-Control', 'no-store');
        res.status(200).json(payloadFor(recordingId, fresh));
        return;
      }

      const transcript = await loadTranscript(client, recordingId);
      if (transcript === null) {
        res.set('Cache-Control', 'no-store');
        res.status(200).json(plainState(recordingId, 'no_transcript'));
        return;
      }

      let text: string;
      try {
        text = await model.summarise({ recordingId, transcript });
      } catch (err) {
        if (!(err instanceof SummaryModelError)) throw err;
        // Nothing is saved, so the button can honestly be pressed again. The log
        // line carries the reason and the model, never a word of the transcript.
        console.error(
          `[academy-api] recording ${String(recordingId)}: could not summarise` +
            ` with ${model.name} (${err.reason})`,
        );
        fail(res, 502, 'summary_failed');
        return;
      }

      // Written once. `summary IS NULL` in the WHERE is the belt to the lock's
      // braces: if anything ever did save one while we were waiting, theirs
      // stands and we serve it rather than overwriting it.
      const saved = await client.query<{ summary_at: Date }>(
        `UPDATE academy.call_recordings
            SET summary = $2, summary_model = $3, summary_at = now()
          WHERE id = $1 AND summary IS NULL
        RETURNING summary_at`,
        [recordingId, text, model.name],
      );

      if (saved.rowCount === 0) {
        const theirs = await loadSummaryRow(client, recordingId);
        res.set('Cache-Control', 'no-store');
        res
          .status(200)
          .json(
            theirs === null ? plainState(recordingId, 'working') : payloadFor(recordingId, theirs),
          );
        return;
      }

      const at = saved.rows[0]!.summary_at;

      // One row, on the press that produced it — never on a press that was
      // served the stored text. The payload says which model and how long the
      // answer was; never the transcript, and never the summary.
      try {
        await writeAudit(client, {
          traineeId,
          eventType: 'RECORDING_SUMMARISED',
          actor: actor.trainee(traineeId),
          payload: {
            recordingId,
            stage: stageCode,
            model: model.name,
            summaryChars: text.length,
            transcriptChars: transcript.length,
          },
        });
      } catch (err) {
        // The summary is saved and is the thing the trainee asked for. A failed
        // audit row must not throw that away.
        console.error('[academy-api] could not write the RECORDING_SUMMARISED audit row:', err);
      }

      res.set('Cache-Control', 'no-store');
      res.status(200).json(
        payloadFor(recordingId, {
          summary: text,
          model: model.name,
          at,
          hasTranscript: true,
        }),
      );
    } finally {
      if (held) {
        await client
          .query('SELECT pg_advisory_unlock(hashtextextended($1, 0))', [lockKey])
          .catch(() => undefined);
      }
      client.release();
    }
  });

  return router;
}
