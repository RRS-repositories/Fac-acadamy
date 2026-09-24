// Authorises (or takes back) a trainee's progression past stage 1 — the gate
// the STAGE1_AUTH_REQUIRED flag turns on.
//
// WHY THIS COMMAND EXISTS
// -----------------------
// gate() reads academy.progression_authorisations.authorised, and until this
// command was written NOTHING in the whole system ever wrote that table. The
// flag was therefore a trap: switch it on and every trainee stops dead after
// their first stage, with no screen, no endpoint and no supported way to let
// them through — only hand-written SQL against the CRM's own database. This is
// the supported way, and it is audited like every other IT action.
//
// The flag has no UI on purpose (it is off by default). This command is the UI.
//
//   npx tsx ops/admin/authorise-stage1.ts --email <email> --by <operator name> \
//       --expect-db <database name> [--reason "<text>"] [--revoke] [--confirm-production] [--dry-run]
//   (or from ops/: npm run admin:authorise-stage1 -- --email ... )
//
// Writes an audit_events row (STAGE1_AUTHORISED, actor 'ops:<operator>', with
// from/to in the payload) in the same transaction as the change. Takes effect
// on the trainee's next request — there is nothing to restart and no session to
// refresh, because gate() reads the row every time.
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

export const AUTHORISE_STAGE1_USAGE =
  'Usage: authorise-stage1 --email <email> --by <operator name> --expect-db <database name> ' +
  '[--reason "<text>"] [--revoke] [--confirm-production] [--dry-run]';

export interface AuthoriseStage1Args {
  email: string;
  operator: string;
  reason: string | undefined;
  expectDb: string;
  /** true = take the authorisation back. */
  revoke: boolean;
  dryRun: boolean;
}

export function parseAuthoriseStage1Args(argv: string[]): AuthoriseStage1Args | 'help' {
  const { values } = parseArgs({
    args: argv,
    strict: true,
    allowPositionals: false,
    options: {
      email: { type: 'string' },
      by: { type: 'string' },
      reason: { type: 'string' },
      'expect-db': { type: 'string' },
      revoke: { type: 'boolean', default: false },
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
    revoke: values.revoke === true,
    dryRun: values['dry-run'] === true,
  };
}

export interface AuthoriseStage1Result {
  traineeId: string;
  email: string;
  /** What the row said before (false when there was no row at all). */
  from: boolean;
  to: boolean;
  /** false when it was already in that state: nothing changed, no audit row. */
  changed: boolean;
  auditId: string | null;
}

/** Runs inside the caller's transaction. */
export async function authoriseStage1(
  db: Queryable,
  opts: { email: string; operator: string; reason?: string | undefined; revoke?: boolean },
): Promise<AuthoriseStage1Result> {
  const to = opts.revoke !== true;
  const trainee = await findTraineeByEmail(db, opts.email);

  // Lock the row if there is one, so two operators cannot race.
  const cur = await db.query<{ authorised: boolean }>(
    'SELECT authorised FROM academy.progression_authorisations WHERE trainee_id = $1 FOR UPDATE',
    [trainee.id],
  );
  // No row is the same as "not authorised": gate() treats a missing row as false.
  const from = cur.rows[0]?.authorised ?? false;

  if (from === to) {
    return { traineeId: trainee.id, email: trainee.email, from, to, changed: false, auditId: null };
  }

  // authorised_by is a CRM user id in the schema, and an ops operator has no
  // CRM user id, so it stays null; WHO did it is the audit row's actor.
  await db.query(
    `INSERT INTO academy.progression_authorisations (trainee_id, authorised, authorised_at)
     VALUES ($1, $2, CASE WHEN $2 THEN now() ELSE NULL END)
     ON CONFLICT (trainee_id) DO UPDATE
       SET authorised = EXCLUDED.authorised,
           authorised_at = EXCLUDED.authorised_at,
           authorised_by = NULL`,
    [trainee.id, to],
  );

  const auditId = await writeAudit(db, {
    traineeId: trainee.id,
    eventType: 'STAGE1_AUTHORISED',
    actor: actorFor(opts.operator),
    payload: { from, to, ...(opts.reason !== undefined && { reason: opts.reason }) },
  });

  return { traineeId: trainee.id, email: trainee.email, from, to, changed: true, auditId };
}

async function main(): Promise<number> {
  const args = parseAuthoriseStage1Args(process.argv.slice(2));
  if (args === 'help') {
    console.log(AUTHORISE_STAGE1_USAGE);
    return 0;
  }
  const client = await connectAdmin(args.expectDb, args.dryRun);
  try {
    const res = await inTransaction(client, args.dryRun, () => authoriseStage1(client, args));
    const prefix = args.dryRun ? '[dry run, rolled back] ' : '';
    const who = `Trainee ${res.traineeId} (${res.email})`;
    if (!res.changed) {
      console.log(
        `${prefix}${who} is already ${res.to ? 'authorised' : 'not authorised'} past stage 1: nothing to do.`,
      );
    } else {
      console.log(
        `${prefix}${who}: stage-1 progression ${res.from ? 'authorised' : 'not authorised'} -> ` +
          `${res.to ? 'authorised' : 'not authorised'}. Audit event ${res.auditId} ` +
          '(STAGE1_AUTHORISED). It applies on their next request.',
      );
    }
    // The command is still worth running with the flag off (it pre-authorises
    // people), but say so, because otherwise nothing at all appears to happen.
    if (process.env.STAGE1_AUTH_REQUIRED !== 'true') {
      console.log(
        'NOTE: STAGE1_AUTH_REQUIRED is not "true" in this environment, so the gate is not ' +
          'enforced at the moment and this makes no visible difference yet.',
      );
    }
    return 0;
  } finally {
    await client.end().catch(() => undefined);
  }
}

runIfMain(import.meta.url, 'authorise-stage1', main);
