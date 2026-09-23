// Producers: the only place the rest of the server enqueues work.
//
// Every producer is idempotent through a jobId derived from the thing that
// happened (trainee + level, trainee + department), so a retried request or a
// double submit can never send a manager two DMs for the same milestone.

import { MANAGER_NOTIFY_JOBS } from '../jobs/managerNotify.js';
import type { DeptCompleteJob, LevelCompleteJob } from '../jobs/managerNotify.js';
import { QUEUE_NAMES } from './names.js';
import type { JobQueue } from './queue.js';

export interface Producers {
  /** Level finished: DM the trainee's manager (S08 consumer). */
  enqueueManagerNotify(job: LevelCompleteJob): Promise<void>;
  /** Department academy finished: same queue, a different job name. */
  enqueueDeptNotify(job: DeptCompleteJob): Promise<void>;
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
  };
}
