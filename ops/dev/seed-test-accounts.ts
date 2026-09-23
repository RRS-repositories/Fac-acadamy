// LOCAL / TEST ONLY. Creates the fixed set of developer accounts the Section 04
// API sweeps and tests run against: ONE trainee per track (9) plus one manager,
// all with invented names and @example.com addresses.
//
//   npx tsx ops/dev/seed-test-accounts.ts --expect-db academy_dev [--reset]
//   DB_NAME=academy_test npx tsx ops/dev/seed-test-accounts.ts --expect-db academy_test
//
// These accounts have NO CRM user and NO authenticator, so none of them can
// sign in: they exist so the API sweeps and the server tests can drive the
// gate directly (by trainee id) without a sign-in. The one exception is the
// manager account, which carries a reserved local-only crm_user_id purely so
// an academy.role_overrides row can mark it MANAGER — that table is keyed by
// CRM user id, and the role is otherwise decided at sign-in.
//
// Idempotent: re-running upserts by email and changes nothing else. --reset
// clears the progress of THESE accounts only (never anyone else's).
//
// Two guards keep this away from production: the --expect-db name must look
// local ('dev' or 'test', never 'prod'/'live'), and it must equal DB_NAME and
// current_database(). See ops/dev/lib.ts.
import { parseArgs } from 'node:util';
import {
  DEV_ACCOUNTS,
  DevError,
  MANAGER_CRM_USER_ID,
  type Queryable,
  connectDev,
  parseExpectDb,
  runIfMain,
  table,
} from './lib.js';

export const SEED_TEST_ACCOUNTS_USAGE =
  'Usage: seed-test-accounts --expect-db <database name> [--reset]';

export interface SeedTestAccountsArgs {
  expectDb: string;
  reset: boolean;
}

export function parseSeedTestAccountsArgs(argv: string[]): SeedTestAccountsArgs | 'help' {
  const { values } = parseArgs({
    args: argv,
    strict: true,
    allowPositionals: false,
    options: {
      'expect-db': { type: 'string' },
      reset: { type: 'boolean', default: false },
      help: { type: 'boolean', short: 'h', default: false },
    },
  });
  if (values.help) return 'help';
  return {
    expectDb: parseExpectDb(values['expect-db']),
    reset: values.reset === true,
  };
}

// Every table that holds a trainee's progress. attempt_answers must go first:
// it references quiz_attempts.
export const PROGRESS_TABLES = [
  'attempt_answers',
  'quiz_attempts',
  'lesson_progress',
  'stage_completions',
  'level_completions',
  'dept_completions',
  'listen_progress',
] as const;

export type ProgressTable = (typeof PROGRESS_TABLES)[number];

export interface SeededAccount {
  email: string;
  fullName: string;
  track: string;
  role: 'STAFF' | 'MANAGER';
  traineeId: string;
  /** true when this run inserted the row, false when it already existed. */
  created: boolean;
}

export interface SeedTestAccountsResult {
  accounts: SeededAccount[];
  /** Rows deleted per table by --reset; empty when --reset was not given. */
  cleared: Record<ProgressTable, number> | null;
}

/**
 * Clears the progress of the given trainees and NOBODY else. Every statement is
 * scoped to the id list, which is why the ids are passed in rather than looked
 * up from a pattern.
 */
export async function clearProgress(
  db: Queryable,
  traineeIds: readonly string[],
): Promise<Record<ProgressTable, number>> {
  const cleared = Object.fromEntries(PROGRESS_TABLES.map((t) => [t, 0])) as Record<
    ProgressTable,
    number
  >;
  if (traineeIds.length === 0) return cleared;
  const ids = [traineeIds];
  for (const t of PROGRESS_TABLES) {
    const sql =
      t === 'attempt_answers'
        ? `DELETE FROM academy.attempt_answers
            WHERE attempt_id IN (SELECT id FROM academy.quiz_attempts
                                  WHERE trainee_id = ANY($1::bigint[]))`
        : `DELETE FROM academy.${t} WHERE trainee_id = ANY($1::bigint[])`;
    const res = await db.query(sql, ids);
    cleared[t] = res.rowCount ?? 0;
  }
  return cleared;
}

/** Runs inside the caller's transaction. */
export async function seedTestAccounts(
  db: Queryable,
  opts: { reset: boolean },
): Promise<SeedTestAccountsResult> {
  const accounts: SeededAccount[] = [];
  for (const a of DEV_ACCOUNTS) {
    // xmax = 0 on the returned row means this statement inserted it.
    const { rows } = await db.query<{ id: string; created: boolean }>(
      `INSERT INTO academy.trainees (full_name, email, track, status, crm_user_id)
            VALUES ($1, $2, $3, 'ACTIVE', $4)
       ON CONFLICT (email) DO UPDATE
              SET full_name   = EXCLUDED.full_name,
                  track       = EXCLUDED.track,
                  status      = 'ACTIVE',
                  is_disabled = FALSE,
                  disabled_by = NULL,
                  disabled_at = NULL,
                  crm_user_id = EXCLUDED.crm_user_id
        RETURNING id::text AS id, (xmax = 0) AS created`,
      [a.fullName, a.email, a.track, a.crmUserId],
    );
    const row = rows[0];
    if (!row) throw new DevError(`Could not create the test account ${a.email}.`);
    accounts.push({
      email: a.email,
      fullName: a.fullName,
      track: a.track,
      role: a.role,
      traineeId: row.id,
      created: row.created,
    });
  }

  // The manager account's MANAGER role (see the header note).
  await db.query(
    `INSERT INTO academy.role_overrides (crm_user_id, role, reason, granted_by)
          VALUES ($1, 'MANAGER', 'local test account (ops/dev/seed-test-accounts.ts)',
                  'ops:seed-test-accounts')
     ON CONFLICT (crm_user_id) DO UPDATE
            SET role       = EXCLUDED.role,
                reason     = EXCLUDED.reason,
                granted_by = EXCLUDED.granted_by,
                updated_at = now()`,
    [MANAGER_CRM_USER_ID],
  );

  const cleared = opts.reset
    ? await clearProgress(
        db,
        accounts.map((a) => a.traineeId),
      )
    : null;

  return { accounts, cleared };
}

async function main(): Promise<number> {
  const args = parseSeedTestAccountsArgs(process.argv.slice(2));
  if (args === 'help') {
    console.log(SEED_TEST_ACCOUNTS_USAGE);
    return 0;
  }
  const client = await connectDev(args.expectDb, 'academy-dev-accounts');
  try {
    await client.query('BEGIN');
    let result: SeedTestAccountsResult;
    try {
      result = await seedTestAccounts(client, { reset: args.reset });
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw err;
    }

    console.log(
      '\nDeveloper accounts (no CRM user, no authenticator: they cannot sign in)\n' +
        table(
          ['email', 'track', 'role', 'trainee id', 'row'],
          result.accounts.map((a) => [
            a.email,
            a.track,
            a.role,
            a.traineeId,
            a.created ? 'created' : 'already existed',
          ]),
        ),
    );
    const created = result.accounts.filter((a) => a.created).length;
    console.log(
      `\n${result.accounts.length} accounts (${created} created, ` +
        `${result.accounts.length - created} already existed).`,
    );

    if (result.cleared) {
      const rows = Object.entries(result.cleared).map(([t, n]) => [t, n]);
      const total = Object.values(result.cleared).reduce((n, v) => n + v, 0);
      console.log(
        '\n--reset: progress cleared for these accounts only\n' +
          table(['table', 'rows deleted'], rows),
      );
      console.log(`\n${total} progress row(s) deleted.`);
    }
    return 0;
  } finally {
    await client.end().catch(() => undefined);
  }
}

runIfMain(import.meta.url, 'seed-test-accounts', main);
