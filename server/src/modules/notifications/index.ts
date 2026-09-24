// Notifications (S08). Mattermost is gone; no email provider is chosen yet.
//
// What exists today: the rules, the wording, the recipients, the durable
// exactly-once marker, and a delivery SEAM that records instead of sending.
// What is missing is one file — a Notifier that talks to a mail provider —
// and a fourth ACADEMY_NOTIFY_MODE. See the TODO in types.ts.

export { createNotifier } from './notifier.js';
export type { NotifierOptions } from './notifier.js';
export {
  createManagerRecipients,
  createLineManagerRecipients,
  createFixedRecipients,
} from './recipients.js';
export type { RecipientResolver } from './recipients.js';
export {
  accountStatusMessage,
  deptCompleteMessage,
  levelCompleteMessage,
  stageFailStreakMessage,
} from './messages.js';
export type { AccountFacts, DeptFacts, LevelFacts, StageFailFacts } from './messages.js';
export { claimNotification, wasNotified } from './sent.js';
export type { ClaimInput } from './sent.js';
export { createNotificationRules, FAIL_STREAK_THRESHOLD } from './rules.js';
export type {
  AccountStatusInput,
  DeptCompleteInput,
  LevelCompleteInput,
  NotificationRules,
  NotificationRulesOptions,
  StageFailInput,
} from './rules.js';
export { NOTIFICATION_KINDS, NOTIFY_MODES } from './types.js';
export type {
  NotificationKind,
  NotificationMessage,
  NotificationRefs,
  Notifier,
  NotifyMode,
  Recipient,
} from './types.js';
