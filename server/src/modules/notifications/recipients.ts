// Who gets told.
//
// UNDECIDED, and flagged as such: the build pack says "the trainee's manager"
// and never says who that is. The academy has no manager-of relation — there
// is no `trainees.manager_id`, the CRM API we are allowed to call is
// `academy-verify` only, and Mattermost (where a DM would have gone to one
// person) was dropped on 23 Sep 2026.
//
// CHOSEN DEFAULT: **every MANAGER account**. A manager account is an academy
// trainee row whose crm_user_id carries a MANAGER role_override — the same
// rule the dashboard uses — and that is active and not disabled. It is the
// only answer the academy's own database can give truthfully today, and it
// fails safe: the message reaches a human rather than nobody.
//
// TO SWAP IN A PER-TRAINEE MANAGER: write one function. Build a resolver whose
// `forTrainee` returns that trainee's own manager and pass it to
// createNotificationRules({ recipients }). `createLineManagerRecipients` below
// is that function, already written, waiting for the column or the CRM field
// that names the manager. Nothing else in the notification path changes.

import type { Pool, PoolClient } from 'pg';
import type { Recipient } from './types.js';

export interface RecipientResolver {
  /** Who hears about this trainee's progress. */
  forTrainee(traineeId: number): Promise<Recipient[]>;
  /** Who hears about account and IT matters. */
  forIt(): Promise<Recipient[]>;
}

type Db = Pool | PoolClient;

interface PersonRow {
  full_name: string;
  email: string;
}

const ACTIVE_MANAGERS = `
  SELECT t.full_name, t.email
    FROM academy.role_overrides r
    JOIN academy.trainees t ON t.crm_user_id = r.crm_user_id
   WHERE r.role = 'MANAGER'
     AND t.status = 'ACTIVE'
     AND NOT t.is_disabled
   ORDER BY t.full_name`;

async function activeManagers(db: Db, audience: Recipient['audience']): Promise<Recipient[]> {
  const { rows } = await db.query<PersonRow>(ACTIVE_MANAGERS);
  return rows.map((row) => ({ name: row.full_name, email: row.email, audience }));
}

/** The default resolver: every MANAGER account, for both audiences. */
export function createManagerRecipients(db: Db): RecipientResolver {
  return {
    forTrainee: () => activeManagers(db, 'MANAGER'),
    // There is no IT mailbox in the academy's configuration and no #it-department
    // channel any more, so the IT-facing notes go to the managers too. When an
    // IT address exists, this is the other one-line change.
    forIt: () => activeManagers(db, 'IT'),
  };
}

/**
 * The one-function swap. `lookup` answers "who manages this trainee?"; the
 * rest of the notification path is untouched. Falls back to every manager
 * when the lookup finds nobody, so a missing link never silently drops a
 * message.
 */
export function createLineManagerRecipients(
  db: Db,
  lookup: (traineeId: number) => Promise<Recipient[]>,
): RecipientResolver {
  const fallback = createManagerRecipients(db);
  return {
    async forTrainee(traineeId) {
      const found = await lookup(traineeId);
      return found.length > 0 ? found : await fallback.forTrainee(traineeId);
    },
    forIt: () => fallback.forIt(),
  };
}

/** A fixed list, for tests and for a "send everything here" configuration. */
export function createFixedRecipients(recipients: Recipient[]): RecipientResolver {
  return {
    forTrainee: () => Promise.resolve(recipients),
    forIt: () => Promise.resolve(recipients),
  };
}
