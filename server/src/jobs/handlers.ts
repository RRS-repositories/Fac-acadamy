// The handler table: which function consumes which queue.
//
// Every work queue gets an entry. A queue with no entry gets no Worker, and
// its jobs would sit in `waiting` for ever — which is why the two post-launch
// media pipelines have deliberate no-op handlers rather than no handler.

import { QUEUE_NAMES } from '../queues/names.js';
import type { JobHandlers } from '../queues/runtime.js';
import type { QueueLogger } from '../queues/logging.js';
import type { NotificationRules } from '../modules/notifications/index.js';
import type { CertificateJob, CertificateRenderer } from './certificateJobs.js';
import { createManagerNotifyHandler } from './managerNotify.js';
import { createQuestionGenHandler, createTranscriptionHandler } from './mediaJobs.js';

export interface HandlerOptions {
  rules: NotificationRules;
  logger: QueueLogger;
  /**
   * Section 09 supplies this. Until it does, a certificates job fails and is
   * parked in the dead-letter bay, where it is visible and can be re-driven
   * once the renderer exists — which is better than completing it and quietly
   * losing somebody's certificate.
   */
  certificates?: CertificateRenderer;
}

export function createHandlers(options: HandlerOptions): JobHandlers {
  const { rules, logger } = options;
  const renderCertificate = options.certificates;

  return {
    [QUEUE_NAMES.managerNotify]: createManagerNotifyHandler(rules),
    [QUEUE_NAMES.transcription]: createTranscriptionHandler(logger),
    [QUEUE_NAMES.questionGen]: createQuestionGenHandler(logger),

    [QUEUE_NAMES.certificates]: async (job) => {
      if (renderCertificate === undefined) {
        throw new Error(
          'certificates: no renderer registered (Section 09 supplies it). ' +
            'The job is parked in the dead-letter bay; re-drive it once the renderer is wired.',
        );
      }
      await renderCertificate(job.data as CertificateJob);
    },

    // signin-events, provisioning and emails have no producer yet: no handler
    // is registered, the worker says so at start-up, and nothing is enqueued
    // to sit unprocessed. They are wired when their producers land.
  };
}
