// IT's authenticator reset (D14: IT resets authenticators with an audited ops
// command, not an in-app role). Deletes the trainee's academy.trainee_mfa row,
// so their next sign-in shows the QR set-up again, and writes an audit_events
// row (MFA_RESET, actor 'ops:<operator>') in the same transaction.
//
//   npx tsx ops/admin/reset-mfa.ts --email <email> --by <operator name> \
//       --expect-db <database name> [--reason "<text>"] [--confirm-production] [--dry-run]
//   (or from ops/: npm run admin:reset-mfa -- --email ... )
//
// Prints the trainee id and email only. The encrypted secret is never read.
import { parseArgs } from 'node:util';
import {
  type Queryable,
  actorFor,
  connectAdmin,
  findTraineeByEmail,
  inTransaction,
  parseEmail,
  parseExpectDb,
  parseOperator,
  parseReason,
  runIfMain,
  writeAudit,
} from './lib.js';

export const RESET_MFA_USAGE =
  'Usage: reset-mfa --email <email> --by <operator name> --expect-db <database name> ' +
  '[--reason "<text>"] [--confirm-production] [--dry-run]';

export interface ResetMfaArgs {
  email: string;
  operator: string;
  reason: string | undefined;
  expectDb: string;
  dryRun: boolean;
}

export function parseResetMfaArgs(argv: string[]): ResetMfaArgs | 'help' {
  const { values } = parseArgs({
    args: argv,
    strict: true,
    allowPositionals: false,
    options: {
      email: { type: 'string' },
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
    email: parseEmail(values.email),
    operator: parseOperator(values.by),
    reason: parseReason(values.reason, false),
    expectDb: parseExpectDb(values['expect-db'], values['confirm-production'] === true),
    dryRun: values['dry-run'] === true,
  };
}

export interface ResetMfaResult {
  traineeId: string;
  email: string;
  /** false when the trainee had no authenticator on file (nothing changed, no audit row). */
  reset: boolean;
  wasEnrolled: boolean;
  auditId: string | null;
}

/** Runs inside the caller's transaction. */
export async function resetMfa(
  db: Queryable,
  opts: { email: string; operator: string; reason?: string | undefined },
): Promise<ResetMfaResult> {
  const trainee = await findTraineeByEmail(db, opts.email);
  const del = await db.query<{ enrolled: boolean }>(
    `DELETE FROM academy.trainee_mfa WHERE trainee_id = $1
     RETURNING enrolled_at IS NOT NULL AS enrolled`,
    [trainee.id],
  );
  const row = del.rows[0];
  if (!row) {
    return {
      traineeId: trainee.id,
      email: trainee.email,
      reset: false,
      wasEnrolled: false,
      auditId: null,
    };
  }
  const auditId = await writeAudit(db, {
    traineeId: trainee.id,
    eventType: 'MFA_RESET',
    actor: actorFor(opts.operator),
    payload: { was_enrolled: row.enrolled, ...(opts.reason ? { reason: opts.reason } : {}) },
  });
  return {
    traineeId: trainee.id,
    email: trainee.email,
    reset: true,
    wasEnrolled: row.enrolled,
    auditId,
  };
}

async function main(): Promise<number> {
  const args = parseResetMfaArgs(process.argv.slice(2));
  if (args === 'help') {
    console.log(RESET_MFA_USAGE);
    return 0;
  }
  const client = await connectAdmin(args.expectDb, args.dryRun);
  try {
    const res = await inTransaction(client, args.dryRun, () => resetMfa(client, args));
    const prefix = args.dryRun ? '[dry run, rolled back] ' : '';
    if (!res.reset) {
      console.log(
        `${prefix}Trainee ${res.traineeId} (${res.email}) has no authenticator on file: nothing to reset.`,
      );
      return 0;
    }
    console.log(
      `${prefix}Authenticator reset for trainee ${res.traineeId} (${res.email})` +
        `${res.wasEnrolled ? '' : ' (set-up was not finished)'}. ` +
        `Audit event ${res.auditId} (MFA_RESET). Their next sign-in shows the QR set-up again.`,
    );
    return 0;
  } finally {
    await client.end().catch(() => undefined);
  }
}

runIfMain(import.meta.url, 'reset-mfa', main);
