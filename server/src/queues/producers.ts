// Producers: the only place the rest of the server enqueues work.
//
// Every producer is idempotent through a jobId derived from the thing that
// happened (trainee + level, trainee + department, the attempt row's own id),
// so a retried request or a double submit can never send a manager two
// messages for the same milestone. BullMQ honours jobId the same way the
// in-memory queue does: a second add() with a jobId already present enqueues
// nothing.

import { CERTIFICATE_JOBS, certificateRef } from '../jobs/certificateJobs.js';
import type { CertificateJob } from '../jobs/certificateJobs.js';
import { MANAGER_NOTIFY_JOBS } from '../jobs/managerNotify.js';
import type { DeptCompleteJob, LevelCompleteJob, StageFailJob } from '../jobs/managerNotify.js';
import { QUEUE_NAMES } from './names.js';
import type { JobQueue } from './queue.js';

export interface Producers {
  /** Level finished: tell the trainee's manager. */
  enqueueManagerNotify(job: LevelCompleteJob): Promise<void>;
  /** Department academy finished: same queue, a different job name. */
  enqueueDeptNotify(job: DeptCompleteJob): Promise<void>;
  /**
   * A stage quiz was failed. Every fail is enqueued; the handler counts the
   * streak, so "3 fails on one stage" is decided once, in the worker, against
   * the database — not by the request that happened to be third.
   */
  enqueueStageFailNotify(job: StageFailJob): Promise<void>;
  /** Render a certificate (Section 09 owns the renderer; see certificateJobs.ts). */
  enqueueCertificate(job: CertificateJob): Promise<void>;
}

export function createProducers(queue: JobQueue): Producers {
  return {
    async enqueueManagerNotify(job) {
      await queue.add(QUEUE_NAMES.managerNotify, MANAGER_NOTIFY_JOBS.levelComplete, job, {
        jobId: `level-${job.traineeId}-${job.level}`,
        attempts: 5,
      });
    },
    async enqueueDeptNotify(job) {
      await queue.add(QUEUE_NAMES.managerNotify, MANAGER_NOTIFY_JOBS.deptComplete, job, {
        jobId: `dept-${job.traineeId}-${job.dept}`,
        attempts: 5,
      });
    },
    async enqueueStageFailNotify(job) {
      // quiz_attempts.id is unique, so a retried request is one job.
      await queue.add(QUEUE_NAMES.managerNotify, MANAGER_NOTIFY_JOBS.stageFail, job, {
        jobId: `stage-fail-${job.attemptId}`,
        attempts: 5,
      });
    },
    async enqueueCertificate(job) {
      await queue.add(QUEUE_NAMES.certificates, CERTIFICATE_JOBS.render, job, {
        jobId: `cert-${job.kind}-${job.traineeId}-${certificateRef(job)}`,
        attempts: 5,
      });
    },
  };
}
