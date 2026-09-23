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
  // S04 training events.
  'LESSON_READ',
  'QUIZ_SUBMIT',
  'STAGE_PASS',
  'LEVEL_PASS',
  'DEPT_PASS',
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
const FORBIDDEN_KEYS = /pass(word)?|secret|code|token|otp|sid|cookie/i;

function scrub(payload: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(payload)) {
    if (value === undefined) continue;
    out[key] = FORBIDDEN_KEYS.test(key) ? '[redacted]' : value;
  }
  return out;
}

export async function writeAudit(db: Pool | PoolClient, entry: AuditEntry): Promise<void> {
  await db.query(
    `INSERT INTO academy.audit_events (trainee_id, event_type, actor, payload)
     VALUES ($1, $2, $3, $4::jsonb)`,
    [entry.traineeId, entry.eventType, entry.actor, JSON.stringify(scrub(entry.payload ?? {}))],
  );
}
