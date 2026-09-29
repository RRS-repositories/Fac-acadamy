// Media jobs: the two pieces of follow-up work every new recording triggers.
//
//   transcription  -> speech-to-text for the stored media object
//   question-gen   -> AI draft quiz questions from that transcript
//
// Both consumers are wired in S08 (BullMQ); nothing in this file does any
// work. S06 only has to *produce* the jobs with the right payload, which is
// what the manager upload endpoint and ops/media/ingest-media.ts do.
//
// Payloads carry ids, codes and the media key only — never a trainee or
// manager name, an email or a transcript — so a queue dump is not a leak.
// The media key is a technical file name under academy/media/, not client
// data; the consumer needs it to read the object back out of the store.

import { localPathFor } from '../media/store.js';
import { TranscriberError } from '../media/transcriber.js';
import type { Transcriber } from '../media/transcriber.js';
import {
  loadTranscriptRow,
  markTranscriptFailed,
  markTranscriptNotRequired,
  storeTranscript,
} from '../media/transcriptStore.js';
import type { TranscriptDb } from '../media/transcriptStore.js';
import { consoleLogger } from '../queues/logging.js';
import type { QueueLogger } from '../queues/logging.js';
import { QUEUE_NAMES } from '../queues/names.js';
import type { JobQueue } from '../queues/queue.js';
import type { JobHandler } from '../queues/runtime.js';

/** Job names inside the transcription queue. */
export const TRANSCRIPTION_JOBS = {
  /** Transcribe one call recording or video. */
  transcribe: 'transcribe',
} as const;

/** Job names inside the question-gen queue. */
export const QUESTION_GEN_JOBS = {
  /** Draft quiz questions for one recording. They stay DRAFT until approved. */
  draftQuestions: 'draft-questions',
} as const;

export type TranscriptionJobName = (typeof TRANSCRIPTION_JOBS)[keyof typeof TRANSCRIPTION_JOBS];
export type QuestionGenJobName = (typeof QUESTION_GEN_JOBS)[keyof typeof QUESTION_GEN_JOBS];

export interface TranscriptionJob {
  /** academy.call_recordings.id */
  recordingId: number;
  /** Where the bytes live in the media store, e.g. 'academy/media/<file>'. */
  mediaKey: string;
  contentType: string;
  /** Probed duration in whole seconds, or null when it could not be read. */
  durationSecs: number | null;
}

export interface QuestionGenJob {
  /** academy.call_recordings.id */
  recordingId: number;
  /** academy.stages.id the recording belongs to, or null for a library item. */
  stageId: number | null;
  /**
   * Drafts are never live: the consumer writes questions with
   * source='AI_GENERATED', approval_state='DRAFT' and is_active=false.
   */
  approvalState: 'DRAFT';
}

export interface MediaProducers {
  /** Speech-to-text for a newly stored recording. */
  enqueueTranscription(job: TranscriptionJob): Promise<void>;
  /** AI draft questions for that recording (human approval required). */
  enqueueQuestionGen(job: QuestionGenJob): Promise<void>;
}

/**
 * Both producers are idempotent through a jobId derived from the recording,
 * so a retried upload or a re-run of the ingest CLI cannot transcribe the
 * same object twice.
 */
export function createMediaProducers(queue: JobQueue): MediaProducers {
  return {
    async enqueueTranscription(job) {
      await queue.add(QUEUE_NAMES.transcription, TRANSCRIPTION_JOBS.transcribe, job, {
        jobId: `transcribe-${job.recordingId}`,
        attempts: 3,
      });
    },
    async enqueueQuestionGen(job) {
      await queue.add(QUEUE_NAMES.questionGen, QUESTION_GEN_JOBS.draftQuestions, job, {
        jobId: `draft-questions-${job.recordingId}`,
        attempts: 3,
      });
    },
  };
}

// ---------------------------------------------------------------------------
// Consumers.
//
// AI question drafting is still POST-LAUNCH (no model chosen, and every AI
// question would need a manager to approve it before it went live), so that
// handler is still a deliberate no-op: it logs what arrived and completes. The
// alternative — no worker on the queue — would leave every upload's follow-up
// sitting in `waiting` for months, which looks like a broken queue in every
// dashboard and hides a real backlog when the pipeline does land.
//
// Transcription is no longer a stub. See below.
// ---------------------------------------------------------------------------

/** What the transcription handler needs. Every piece of it is optional-by-null. */
export interface TranscriptionHandlerDeps {
  /** Null together with `transcriber` when transcription is not wired at all. */
  db: TranscriptDb | null;
  /**
   * MEDIA_ROOT. The bytes are already on this machine's disk (D15: no S3), and
   * the transcriber is handed the PATH — nothing is uploaded anywhere and nothing
   * is copied to a temporary file first.
   */
  mediaRoot: string;
  /**
   * The configured engine, or null when transcription is switched off or not
   * configured on this machine. Null keeps the old behaviour exactly: the job is
   * logged and completed, so nothing piles up in `waiting` and nothing fails.
   */
  transcriber: Transcriber | null;
  logger?: QueueLogger;
}

/**
 * Transcribe one recording (plan §3.3).
 *
 * The queue's concurrency is 1 (DEFAULT_CONCURRENCY in queues/runtime.ts), so
 * ONE recording is transcribed at a time however many are waiting, and the
 * transcriber starts the interpreter at the lowest priority the OS offers
 * (spawnLowest in media/transcriber.ts). Together those two are the whole reason
 * this is allowed to run on the live box at all: it has 3 cores, 26 applications
 * and a load of about 6.5 before we add anything, so the transcription must
 * always be the thing that yields. Neither of those is a detail to tune away.
 *
 * What it does, in order, and why each case is a COMPLETION rather than a
 * failure — a job that fails is retried three times and then parked in the
 * dead-letter bay, which is the right home for a broken installation and the
 * wrong home for "there was nothing to do":
 *
 *   not configured             completed, with the line this handler logged for
 *                              months, and without a database round trip. An
 *                              environment with no interpreter is not a broken
 *                              job, and this is checked first so a switched-off
 *                              feature costs one comparison.
 *   no such active recording   completed. The row was withdrawn or deleted after
 *                              the job was queued. Nothing to transcribe, and
 *                              nothing anybody could fix by re-driving it.
 *   a "coming soon" slot        completed (D4: a slot with no media is normal).
 *   a video                     completed, and the status becomes NOT_REQUIRED.
 *                              Videos are out of scope for version one (plan §7);
 *                              leaving them PENDING for ever would make the
 *                              backlog unreadable. Reversible: set the status back
 *                              to PENDING and re-queue.
 *   already transcribed         completed. BullMQ is at-least-once, so this job
 *                              may well have run before — and re-running it would
 *                              cost half an hour of CPU to produce the same text.
 *   the transcriber failed      transcript_status becomes FAILED and the error is
 *                              RE-THROWN, so the existing dead-letter behaviour
 *                              handles it: three attempts, then parked with its
 *                              payload for somebody to read and re-drive. No new
 *                              queue machinery, because there is none needed.
 */
export function createTranscriptionHandler(deps: TranscriptionHandlerDeps): JobHandler {
  const logger = deps.logger ?? consoleLogger('academy-worker');

  return async (job) => {
    const data = job.data as TranscriptionJob;
    const id = data.recordingId;
    const at = `recording ${String(id)}`;

    // Switched off, or not configured on this machine: answered before anything
    // is looked up, so an environment that says nothing about transcription
    // costs one comparison per job and behaves exactly as it did for months.
    if (deps.transcriber === null || deps.db === null) {
      logger.info(
        `transcription: ${at} accepted and skipped ` +
          '(transcription is not configured on this machine; see TRANSCRIBE_PYTHON)',
      );
      return;
    }
    const transcriber = deps.transcriber;

    const row = await loadTranscriptRow(deps.db, id);
    if (row === null) {
      logger.info(`transcription: ${at} is not an active recording any more; nothing to do`);
      return;
    }
    if (row.mediaKey === null) {
      logger.info(`transcription: ${at} has no media (a "coming soon" slot); nothing to do`);
      return;
    }
    if (row.mediaType !== 'AUDIO') {
      await markTranscriptNotRequired(deps.db, id);
      logger.info(
        `transcription: ${at} is a ${row.mediaType.toLowerCase()}; transcripts are for calls ` +
          'in version one, so it is marked NOT_REQUIRED',
      );
      return;
    }
    if (row.text !== null) {
      logger.info(
        `transcription: ${at} already has a transcript (${String(row.segments.length)} segments); ` +
          'not doing it again',
      );
      return;
    }
    const startedAt = Date.now();
    try {
      const result = await transcriber.transcribe(localPathFor(deps.mediaRoot, row.mediaKey));
      await storeTranscript(deps.db, id, result);
      // Counts and seconds only: never a word of what was said.
      logger.info(
        `transcription: ${at} done with ${transcriber.name} in ` +
          `${String(Math.round((Date.now() - startedAt) / 1000))}s — ` +
          `${String(result.segments.length)} segments, ${String(result.text.length)} characters`,
      );
    } catch (err) {
      // Mark it first, and never let that write hide the real error: the whole
      // point of FAILED is that a recording stops looking like it is still
      // waiting its turn.
      await markTranscriptFailed(deps.db, id).catch((markErr: Error) => {
        logger.error(`transcription: ${at} could not be marked FAILED: ${markErr.message}`);
      });
      const reason = err instanceof TranscriberError ? err.reason : 'unexpected';
      logger.error(
        `transcription: ${at} failed after ` +
          `${String(Math.round((Date.now() - startedAt) / 1000))}s (${reason}); ` +
          'transcript_status is now FAILED',
      );
      // Re-thrown on purpose. BullMQ retries it, and the third failure parks it
      // in the dead-letter bay with its payload — which is where a broken
      // installation belongs, visible and re-drivable.
      throw err;
    }
  };
}

/** TODO (post-launch): draft questions from the transcript, as DRAFT + inactive. */
export function createQuestionGenHandler(
  logger: QueueLogger = consoleLogger('academy-worker'),
): JobHandler {
  return (job) => {
    const data = job.data as QuestionGenJob;
    logger.info(
      `question-gen: recording ${String(data.recordingId)} accepted and skipped ` +
        '(no question generator yet; post-launch. Drafts would need manager approval)',
    );
    return Promise.resolve();
  };
}
