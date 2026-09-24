// Queue names, in one place.
//
// BullMQ 6 throws when a queue name contains ':' (it builds its Redis keys as
// `<prefix>:<name>:<...>`), so the build spec's `academy:signin-events` is
// really prefix `academy` + name `signin-events`. Every queue in this app is
// created with QUEUE_PREFIX and a plain name from QUEUE_NAMES; the assertion
// at the bottom of this file makes a bad name a start-up failure rather than
// a runtime surprise inside a worker.

export const QUEUE_PREFIX = 'academy';

export const QUEUE_NAMES = {
  /** Mattermost DM to a trainee's manager (Level 1 complete, repeated fails). */
  managerNotify: 'manager-notify',
  /** Sign-in and session events fanned out for reporting. */
  signinEvents: 'signin-events',
  /** Speech-to-text for a newly stored recording (S06 producer, S08 consumer). */
  transcription: 'transcription',
  /** AI draft quiz questions from a transcript (S06 producer, S08 consumer). */
  questionGen: 'question-gen',
  /** New-starter provisioning (S08). */
  provisioning: 'provisioning',
  /** SES email sends (S08). */
  emails: 'emails',
  /** Certificate rendering (S09). */
  certificates: 'certificates',
  /**
   * Where a job goes when it has used up every attempt (S08). Nothing
   * consumes this queue on purpose: its jobs sit in `waiting` so they can be
   * read, counted and re-driven by hand. See deadLetter.ts.
   */
  deadLetter: 'dead-letter',
} as const;

export type QueueName = (typeof QUEUE_NAMES)[keyof typeof QUEUE_NAMES];

export const ALL_QUEUE_NAMES: readonly QueueName[] = Object.values(QUEUE_NAMES);

/** The one queue that is a parking bay, not work. */
export const DEAD_LETTER_QUEUE = QUEUE_NAMES.deadLetter;

/**
 * The queues a worker actually processes: everything except the dead-letter
 * parking bay. Starting a Worker on dead-letter would drain the evidence.
 */
export const WORK_QUEUE_NAMES: readonly QueueName[] = ALL_QUEUE_NAMES.filter(
  (name) => name !== DEAD_LETTER_QUEUE,
);

/** Throws unless `name` is a legal BullMQ queue name (no ':', not empty). */
export function assertQueueName(name: string): void {
  if (name.length === 0 || name.includes(':')) {
    throw new Error(
      `Illegal queue name ${JSON.stringify(name)}: BullMQ 6 rejects ':' in a queue name. ` +
        `Use prefix '${QUEUE_PREFIX}' with a plain name.`,
    );
  }
}

for (const name of ALL_QUEUE_NAMES) assertQueueName(name);
