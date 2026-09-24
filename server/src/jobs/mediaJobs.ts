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
// Speech-to-text and AI question drafting are POST-LAUNCH (there is no
// transcription provider and no model chosen, and every AI question would need
// a manager to approve it before it went live). The jobs are still produced
// today, by the manager upload endpoint and by ops/media/ingest-media.ts.
//
// So these handlers are deliberate no-ops: they log what arrived and complete.
// The alternative — no worker on those queues — would leave every upload's
// follow-up sitting in `waiting` for months, which looks like a broken queue
// in every dashboard and hides a real backlog when the pipelines do land.
// ---------------------------------------------------------------------------

/** TODO (post-launch): call the speech-to-text provider and store the transcript. */
export function createTranscriptionHandler(
  logger: QueueLogger = consoleLogger('academy-worker'),
): JobHandler {
  return (job) => {
    const data = job.data as TranscriptionJob;
    logger.info(
      `transcription: recording ${String(data.recordingId)} accepted and skipped ` +
        '(no speech-to-text provider yet; post-launch)',
    );
    return Promise.resolve();
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
