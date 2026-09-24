// The wording. One place, so the copy can be read without reading any logic.
//
// The Level 1 line is the build pack's, verbatim:
//     "<name> is ready to start work — <track>"
// (SECTION-08 task 3). The em dash is the one in the spec, not a hyphen.

import { NOTIFICATION_KINDS } from './types.js';
import type { NotificationMessage, Recipient } from './types.js';

export interface LevelFacts {
  traineeId: number;
  fullName: string;
  level: number;
  trackCode: string;
  trackLabel: string;
}

export interface DeptFacts {
  traineeId: number;
  fullName: string;
  deptCode: string;
  deptLabel: string;
  trackCode: string;
}

export interface StageFailFacts {
  traineeId: number;
  fullName: string;
  stageId: number;
  stageCode: string;
  stageTitle: string;
  fails: number;
  trackCode: string;
}

export interface AccountFacts {
  traineeId: number;
  fullName: string;
  enabled: boolean;
  /** Who did it, for the IT note: 'manager:12' or 'system'. */
  actor: string;
  /**
   * What makes THIS change unique: the audit event id, or an ISO timestamp.
   * Disabling, re-enabling and disabling again are three separate notes, so
   * the exactly-once key has to change with each one.
   */
  eventRef: string;
  trackCode: string;
}

export function levelCompleteMessage(facts: LevelFacts, to: Recipient[]): NotificationMessage {
  const readyToWork = facts.level === 1;
  const subject = readyToWork
    ? `${facts.fullName} is ready to start work — ${facts.trackLabel}`
    : `${facts.fullName} has finished Level ${String(facts.level)} — ${facts.trackLabel}`;
  const body = readyToWork
    ? `${facts.fullName} has passed every Level 1 stage on the ${facts.trackLabel} track ` +
      `and is ready to start work.\n\nFAC Academy`
    : `${facts.fullName} has passed every stage of Level ${String(facts.level)} ` +
      `on the ${facts.trackLabel} track.\n\nFAC Academy`;
  return {
    kind: NOTIFICATION_KINDS.levelComplete,
    to,
    subject,
    body,
    refs: {
      traineeId: facts.traineeId,
      ref: `level-${String(facts.level)}`,
      track: facts.trackCode,
    },
  };
}

export function deptCompleteMessage(facts: DeptFacts, to: Recipient[]): NotificationMessage {
  return {
    kind: NOTIFICATION_KINDS.deptComplete,
    to,
    subject: `${facts.fullName} has finished the ${facts.deptLabel} academy`,
    body:
      `${facts.fullName} has passed both modules of the ${facts.deptLabel} department academy.` +
      `\n\nFAC Academy`,
    refs: { traineeId: facts.traineeId, ref: `dept-${facts.deptCode}`, track: facts.trackCode },
  };
}

export function stageFailStreakMessage(
  facts: StageFailFacts,
  to: Recipient[],
): NotificationMessage {
  return {
    kind: NOTIFICATION_KINDS.stageFailStreak,
    to,
    subject: `${facts.fullName} is stuck on ${facts.stageTitle}`,
    body:
      `${facts.fullName} has failed ${facts.stageTitle} (${facts.stageCode}) ` +
      `${String(facts.fails)} times in a row and may need a hand.\n\nFAC Academy`,
    refs: {
      traineeId: facts.traineeId,
      ref: `stage-${String(facts.stageId)}`,
      track: facts.trackCode,
    },
  };
}

export function accountStatusMessage(facts: AccountFacts, to: Recipient[]): NotificationMessage {
  const what = facts.enabled ? 're-enabled' : 'disabled';
  return {
    kind: facts.enabled ? NOTIFICATION_KINDS.accountEnabled : NOTIFICATION_KINDS.accountDisabled,
    to,
    subject: `Academy account ${what}: ${facts.fullName}`,
    body:
      `The academy account for ${facts.fullName} was ${what} by ${facts.actor}.` +
      `${facts.enabled ? '' : ' Their sessions were ended.'}\n\nFAC Academy`,
    refs: {
      traineeId: facts.traineeId,
      // The ref carries the direction AND this change's own reference, so
      // disabling, enabling and disabling again are three notes, not one.
      ref: `${what}-${facts.eventRef}`,
      track: facts.trackCode,
    },
  };
}
