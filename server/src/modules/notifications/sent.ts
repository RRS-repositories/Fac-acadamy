// academy.notifications_sent: the durable marker that makes the rules
// exactly-once across retries, restarts and races (migration 0006).
//
// The claim is an INSERT, not a SELECT-then-INSERT. Two workers claiming the
// same (kind, trainee, ref) at the same moment do not both win: the second
// one's INSERT waits on the first transaction and then returns no row, because
// of the UNIQUE (kind, trainee_id, ref).
//
// The claim must run inside the SAME transaction as whatever it guards, so
// "marked as sent" and "recorded as sent" commit together or not at all.

import type { PoolClient } from 'pg';
import type { NotificationKind, NotifyMode } from './types.js';

export interface ClaimInput {
  kind: NotificationKind;
  traineeId: number;
  /** The level number, department code, stage id: whatever identifies this one. */
  ref: string;
  mode: NotifyMode;
}

/** True when THIS call wrote the marker, i.e. this is the one that may send. */
export async function claimNotification(client: PoolClient, input: ClaimInput): Promise<boolean> {
  const { rowCount } = await client.query(
    `INSERT INTO academy.notifications_sent (kind, trainee_id, ref, mode)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (kind, trainee_id, ref) DO NOTHING`,
    [input.kind, input.traineeId, input.ref, input.mode],
  );
  return rowCount === 1;
}

/** Has this notification already been composed? Read-only; for tests and tools. */
export async function wasNotified(
  db: { query: PoolClient['query'] },
  input: Pick<ClaimInput, 'kind' | 'traineeId' | 'ref'>,
): Promise<boolean> {
  const { rowCount } = await db.query(
    `SELECT 1 FROM academy.notifications_sent
      WHERE kind = $1 AND trainee_id = $2 AND ref = $3`,
    [input.kind, input.traineeId, input.ref],
  );
  return (rowCount ?? 0) > 0;
}
