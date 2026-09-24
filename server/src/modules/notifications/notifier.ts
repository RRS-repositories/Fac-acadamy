// Delivery. Or rather, the absence of it.
//
// ACADEMY_NOTIFY_MODE decides what `send()` does:
//
//   shadow  (default)  compose → write an audit_events row (NOTIFICATION_SHADOW)
//                      → log one line. Nothing leaves the building.
//   log                log one line only. No audit row. For a noisy local run.
//   off                do nothing at all. For a migration window.
//
// There is no 'send' mode yet ON PURPOSE: no email provider has been chosen
// (no AWS; the CRM uses Microsoft 365/Graph and SMTP). Adding one is a new
// Notifier in this folder plus a fourth mode — see the TODO in types.ts.
//
// What is logged and audited: the kind, the trainee id, the ref, the subject,
// and how many recipients there were. NOT the body and NOT the addresses —
// audit_events is read by managers and exported, and a recipient list is staff
// personal data that the message does not need to prove it was composed.

import { writeAudit } from '../audit/audit.js';
import type { NotificationMessage, Notifier, NotifierDb, NotifyMode } from './types.js';

export interface QueueLoggerLike {
  info(message: string): void;
  warn(message: string): void;
  error(message: string): void;
}

export interface NotifierOptions {
  mode: NotifyMode;
  /** Used when `send()` is called without a transaction of its own. */
  db: NotifierDb;
  logger?: QueueLoggerLike;
}

function summarise(message: NotificationMessage): string {
  return (
    `${message.kind} trainee=${String(message.refs.traineeId)} ref=${message.refs.ref} ` +
    `recipients=${String(message.to.length)} subject=${JSON.stringify(message.subject)}`
  );
}

export function createNotifier(options: NotifierOptions): Notifier {
  const log = options.logger ?? {
    info: (m: string) => console.log(`[academy-notify] ${m}`),
    warn: (m: string) => console.warn(`[academy-notify] ${m}`),
    error: (m: string) => console.error(`[academy-notify] ${m}`),
  };

  return {
    mode: options.mode,

    async send(message, tx) {
      if (options.mode === 'off') return;

      if (message.to.length === 0) {
        // Worth saying out loud: it means the recipient resolver found nobody,
        // which is a configuration problem, not a quiet success.
        log.warn(`${summarise(message)} — NO RECIPIENTS RESOLVED, nothing to send`);
      }

      if (options.mode === 'shadow') {
        await writeAudit(tx ?? options.db, {
          traineeId: message.refs.traineeId,
          eventType: 'NOTIFICATION_SHADOW',
          actor: 'system',
          payload: {
            kind: message.kind,
            ref: message.refs.ref,
            subject: message.subject,
            recipientCount: message.to.length,
            audience: [...new Set(message.to.map((r) => r.audience))],
            ...(message.refs.track !== undefined && { track: message.refs.track }),
            mode: 'shadow',
            delivered: false,
          },
        });
      }

      log.info(
        `${options.mode === 'shadow' ? 'SHADOW (recorded, not sent)' : 'LOG ONLY'}: ` +
          summarise(message),
      );
    },
  };
}
