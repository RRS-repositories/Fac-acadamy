// The notification vocabulary: what can be sent, to whom, and in which mode.
//
// Nothing here talks to a network. Delivery is a seam (`Notifier`) because the
// email provider is NOT decided yet: Mattermost was dropped on 23 Sep 2026,
// there is no AWS, and the CRM sends through Microsoft 365/Graph and SMTP.
// Until that decision is made the academy runs in SHADOW mode — it composes
// the message, records it and logs it, and sends nothing.

import type { Pool, PoolClient } from 'pg';

export const NOTIFY_MODES = ['shadow', 'log', 'off'] as const;
export type NotifyMode = (typeof NOTIFY_MODES)[number];

/**
 * What a notification is about. These strings are stored in
 * academy.notifications_sent.kind and are part of the exactly-once key, so
 * they are never renamed once they have been used.
 */
export const NOTIFICATION_KINDS = {
  /** A level was finished. Level 1 is the "ready to start work" one. */
  levelComplete: 'LEVEL_COMPLETE',
  /** Both modules of a department academy were finished. */
  deptComplete: 'DEPT_COMPLETE',
  /** Three fails in a row on one stage. ONE message, not three. */
  stageFailStreak: 'STAGE_FAIL_STREAK',
  /** A manager disabled an account: the IT-facing note. */
  accountDisabled: 'ACCOUNT_DISABLED',
  /** ...and turned it back on. */
  accountEnabled: 'ACCOUNT_ENABLED',
} as const;

export type NotificationKind = (typeof NOTIFICATION_KINDS)[keyof typeof NOTIFICATION_KINDS];

/** Who a message goes to. `audience` is what the resolver was asked for. */
export interface Recipient {
  name: string;
  email: string;
  audience: 'MANAGER' | 'IT';
}

/** The ids a recorded notification points back at. No names, no addresses. */
export interface NotificationRefs {
  traineeId: number;
  /** The ref half of the exactly-once key: a level number, a dept code, a stage id. */
  ref: string;
  track?: string;
}

export interface NotificationMessage {
  kind: NotificationKind;
  to: Recipient[];
  subject: string;
  body: string;
  refs: NotificationRefs;
}

/**
 * The delivery seam.
 *
 * TODO (email provider undecided, 23 Sep 2026): when Brad picks one —
 * Microsoft 365/Graph like the CRM, plain SMTP, or something else — the only
 * new code is a `createGraphNotifier()` / `createSmtpNotifier()` in this
 * folder that implements this interface, plus 'send' as a fourth
 * ACADEMY_NOTIFY_MODE. Nothing above this line changes: the rules, the
 * recipients, the wording and the exactly-once marker are all provider-blind.
 */
export interface Notifier {
  readonly mode: NotifyMode;
  /**
   * Record and (one day) deliver one message.
   *
   * `tx` lets the caller hand in the transaction that claimed the
   * exactly-once marker, so in shadow mode the marker and the audit row
   * commit together: either the notification is recorded and marked, or
   * neither happened.
   */
  send(message: NotificationMessage, tx?: NotifierDb): Promise<void>;
}

/** pg's Pool or PoolClient: whichever the caller is inside. */
export type NotifierDb = Pool | PoolClient;
