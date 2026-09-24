// Sets or clears an academy.role_overrides row (D14: only the CRM role
// 'Management' maps to MANAGER; an override wins in either direction).
// --role none deletes the override, so the default mapping applies again.
// Writes an audit_events row (ROLE_OVERRIDE_SET, actor 'ops:<operator>') in the
// same transaction. The new role takes effect at the person's next sign-in.
//
//   npx tsx ops/admin/set-role-override.ts --crm-user-id <id> --role STAFF|MANAGER|none \
//       --by <operator name> --reason "<text>" --expect-db <database name> [--confirm-production] [--dry-run]
//   (or from ops/: npm run admin:set-role -- --crm-user-id ... )
import { parseArgs } from 'node:util';
import {
  AdminError,
  type Queryable,
  actorFor,
  connectAdmin,
  inTransaction,
  parseExpectDb,
  parseOperator,
  parseReason,
  runIfMain,
  writeAudit,
} from './lib.js';

export const SET_ROLE_USAGE =
  'Usage: set-role-override --crm-user-id <id> --role STAFF|MANAGER|none --by <operator name> ' +
  '--reason "<text>" --expect-db <database name> [--confirm-production] [--dry-run]';

export type OverrideRole = 'STAFF' | 'MANAGER' | null;

export interface SetRoleArgs {
  crmUserId: string;
  role: OverrideRole;
  operator: string;
  reason: string;
  expectDb: string;
  dryRun: boolean;
}

export function parseCrmUserId(raw: string | undefined): string {
  const id = raw?.trim() ?? '';
  if (!id) throw new AdminError('--crm-user-id <id> is required.');
  // Positive BIGINT: digits only, no leading zero, at most 2^63 - 1.
  if (!/^[1-9][0-9]{0,18}$/.test(id) || BigInt(id) > 9223372036854775807n) {
    throw new AdminError(`--crm-user-id "${id}" is not a positive whole number.`);
  }
  return id;
}

export function parseOverrideRole(raw: string | undefined): OverrideRole {
  const role = raw?.trim().toUpperCase() ?? '';
  if (role === 'STAFF' || role === 'MANAGER') return role;
  if (role === 'NONE') return null;
  throw new AdminError('--role must be STAFF, MANAGER or none.');
}

export function parseSetRoleArgs(argv: string[]): SetRoleArgs | 'help' {
  const { values } = parseArgs({
    args: argv,
    strict: true,
    allowPositionals: false,
    options: {
      'crm-user-id': { type: 'string' },
      role: { type: 'string' },
      by: { type: 'string' },
      reason: { type: 'string' },
      'expect-db': { type: 'string' },
      'confirm-production': { type: 'boolean', default: false },

      'dry-run': { type: 'boolean', default: false },
      help: { type: 'boolean', short: 'h', default: false },
    },
  });
  if (values.help) return 'help';
  return {
    crmUserId: parseCrmUserId(values['crm-user-id']),
    role: parseOverrideRole(values.role),
    operator: parseOperator(values.by),
    reason: parseReason(values.reason, true)!,
    expectDb: parseExpectDb(values['expect-db'], values['confirm-production'] === true),
    dryRun: values['dry-run'] === true,
  };
}

export interface SetRoleResult {
  crmUserId: string;
  traineeId: string | null;
  from: OverrideRole;
  to: OverrideRole;
  /** false when --role none and there was no override (nothing changed, no audit row). */
  changed: boolean;
  auditId: string | null;
}

/** Runs inside the caller's transaction. */
export async function setRoleOverride(
  db: Queryable,
  opts: { crmUserId: string; role: OverrideRole; operator: string; reason: string },
): Promise<SetRoleResult> {
  const actor = actorFor(opts.operator);
  const prev = await db.query<{ role: 'STAFF' | 'MANAGER' }>(
    'SELECT role FROM academy.role_overrides WHERE crm_user_id = $1 FOR UPDATE',
    [opts.crmUserId],
  );
  const from = prev.rows[0]?.role ?? null;
  // The trainee may not exist yet (an override can be set before first sign-in).
  const t = await db.query<{ id: string }>(
    'SELECT id::text AS id FROM academy.trainees WHERE crm_user_id = $1',
    [opts.crmUserId],
  );
  const traineeId = t.rows[0]?.id ?? null;

  if (opts.role === null) {
    if (from === null) {
      return {
        crmUserId: opts.crmUserId,
        traineeId,
        from,
        to: null,
        changed: false,
        auditId: null,
      };
    }
    await db.query('DELETE FROM academy.role_overrides WHERE crm_user_id = $1', [opts.crmUserId]);
  } else {
    await db.query(
      `INSERT INTO academy.role_overrides (crm_user_id, role, reason, granted_by)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (crm_user_id) DO UPDATE
         SET role = EXCLUDED.role, reason = EXCLUDED.reason,
             granted_by = EXCLUDED.granted_by, updated_at = now()`,
      [opts.crmUserId, opts.role, opts.reason, actor],
    );
  }
  const auditId = await writeAudit(db, {
    traineeId,
    eventType: 'ROLE_OVERRIDE_SET',
    actor,
    payload: { crm_user_id: opts.crmUserId, from, to: opts.role, reason: opts.reason },
  });
  return { crmUserId: opts.crmUserId, traineeId, from, to: opts.role, changed: true, auditId };
}

async function main(): Promise<number> {
  const args = parseSetRoleArgs(process.argv.slice(2));
  if (args === 'help') {
    console.log(SET_ROLE_USAGE);
    return 0;
  }
  const client = await connectAdmin(args.expectDb, args.dryRun);
  try {
    const res = await inTransaction(client, args.dryRun, () => setRoleOverride(client, args));
    const prefix = args.dryRun ? '[dry run, rolled back] ' : '';
    const who =
      `CRM user ${res.crmUserId}` +
      (res.traineeId ? ` (trainee ${res.traineeId})` : ' (no trainee yet)');
    if (!res.changed) {
      console.log(`${prefix}${who} has no role override: nothing to remove.`);
      return 0;
    }
    const show = (r: OverrideRole) => r ?? '(none: default mapping)';
    console.log(
      `${prefix}${who}: role override ${show(res.from)} -> ${show(res.to)}. ` +
        `Audit event ${res.auditId} (ROLE_OVERRIDE_SET). Takes effect at their next sign-in.`,
    );
    return 0;
  } finally {
    await client.end().catch(() => undefined);
  }
}

runIfMain(import.meta.url, 'set-role-override', main);
