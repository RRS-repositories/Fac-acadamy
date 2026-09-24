import type { Pool, PoolClient } from 'pg';

// academy.audit_events is append-only. Every auth and account event is
// written here. Payloads carry context (reason, ip, user agent, what changed)
// and never a password, an authenticator code, a TOTP secret or a session id.

export const AUDIT_EVENTS = [
  'LOGIN_SUCCESS',
  'LOGIN_FAIL',
  'MFA_ENROLLED',
  'MFA_FAIL',
  'LOGIN_BLOCKED_DISABLED',
  'LOCKOUT',
  'LOGOUT',
  'ACCOUNT_DISABLED',
  'ACCOUNT_ENABLED',
  'TRACK_ASSIGNED',
  // Taking a track away is its own event, not a TRACK_ASSIGNED with a null in
  // it (modules/manager/accounts.ts explains why).
  'TRACK_CLEARED',
  // Written by the ops scripts, not by the API: ops/admin/reset-mfa.ts and
  // ops/admin/set-role-override.ts. They are the two highest-privilege actions
  // anybody can take — clearing somebody's authenticator, and handing somebody
  // MANAGER — so they belong in this list, not outside it. Anything that
  // filters the audit trail by AUDIT_EVENTS used to drop them silently, which
  // is the worst way for a privileged action to be invisible.
  'MFA_RESET',
  'ROLE_OVERRIDE_SET',
  // ops/admin/authorise-stage1.ts, for the same reason.
  'STAGE1_AUTHORISED',
  // S04 training events.
  'LESSON_READ',
  // S06 media. MEDIA_STREAM is written for the FIRST stream of a recording in
  // a session (at most one an hour), never for each Range request: a player
  // asks for a long video in dozens of pieces.
  'MEDIA_STREAM',
  // S06: written once, on the beacon that first proves a full listen.
  'LISTEN_COMPLETE',
  // S06: a manager added a recording or a screen recording to a stage.
  'MEDIA_UPLOADED',
  'QUIZ_SUBMIT',
  'STAGE_PASS',
  'LEVEL_PASS',
  'DEPT_PASS',
  // S09 certificates: one row when a certificate is created (never on a
  // re-render), and one for every PDF download, by the holder or a manager.
  'CERT_ISSUED',
  'CERT_DOWNLOAD',
  // S07 management dashboard: one summary row per view, one row per action.
  'MANAGER_VIEW',
  'MANAGER_PREVIEW',
  'EXPORT_CSV',
  // S08 notifications. SHADOW MODE: the message was composed and recorded but
  // deliberately NOT sent — no email provider has been chosen (Mattermost was
  // dropped, there is no AWS). The payload carries the kind, the ref, the
  // subject and how many recipients were resolved; never an address.
  'NOTIFICATION_SHADOW',
] as const;
export type AuditEventType = (typeof AUDIT_EVENTS)[number];

/** 'trainee:<id>' | 'manager:<id>' | 'system' | 'ops:<name>' */
export type AuditActor = `trainee:${number}` | `manager:${number}` | 'system' | `ops:${string}`;

export const actor = {
  trainee: (id: number): AuditActor => `trainee:${id}`,
  manager: (id: number): AuditActor => `manager:${id}`,
  system: 'system' as AuditActor,
  ops: (name: string): AuditActor => `ops:${name}`,
};

export interface AuditEntry {
  traineeId: number | null;
  eventType: AuditEventType;
  actor: AuditActor;
  payload?: Record<string, unknown>;
}

// Defence in depth: keys that must never be stored, whatever a caller passes.
//
// `q`, `query` and `search` are here because the manager roster and the CSV
// export audit their filters, and the filter `q` is free text a manager typed —
// in practice a colleague's name. That is somebody's personal data landing in
// an append-only, manager-readable, CSV-exportable table for good. Which
// filters were in use is still visible; what was typed into the box is not.
const FORBIDDEN_KEYS = /pass(word)?|secret|code|token|otp|sid|cookie|^q$|query|search/i;

// A payload is a small object; nesting past this is a caller bug, not data.
const MAX_DEPTH = 6;

/**
 * Redact forbidden keys AT EVERY DEPTH. A top-level-only pass was a false
 * comfort: `{ filters: { q: 'a name' } }` sailed straight through it, and so
 * would `{ crm: { token } }`.
 */
function scrubValue(value: unknown, depth: number): unknown {
  if (value === null || typeof value !== 'object') return value;
  if (depth >= MAX_DEPTH) return '[too deep]';
  if (Array.isArray(value)) return value.map((item) => scrubValue(item, depth + 1));
  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    if (item === undefined) continue;
    out[key] = FORBIDDEN_KEYS.test(key) ? '[redacted]' : scrubValue(item, depth + 1);
  }
  return out;
}

function scrub(payload: Record<string, unknown>): Record<string, unknown> {
  return scrubValue(payload, 0) as Record<string, unknown>;
}

export async function writeAudit(db: Pool | PoolClient, entry: AuditEntry): Promise<void> {
  await db.query(
    `INSERT INTO academy.audit_events (trainee_id, event_type, actor, payload)
     VALUES ($1, $2, $3, $4::jsonb)`,
    [entry.traineeId, entry.eventType, entry.actor, JSON.stringify(scrub(entry.payload ?? {}))],
  );
}
