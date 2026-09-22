// Shared plumbing for the IT admin commands in ops/admin/ (reset-mfa, set-track,
// set-role-override). Each command:
//   * loads the local .env (never overriding real environment variables),
//   * connects with the app's database settings (application_name academy-admin),
//   * refuses to run unless --expect-db equals current_database(),
//   * does its change and its audit_events row in ONE transaction
//     (--dry-run does the same work, then rolls back),
//   * prints ids and emails only, never secrets, and exits 0 (done) or 1 (refused/failed).
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { loadDotenvIfPresent } from '../../server/src/config/dotenv.js';
import { DbSettingsSchema, pgConfig } from '../../server/src/db/connection.js';

export class AdminError extends Error {
  override name = 'AdminError';
}

/** Anything with a pg-style query method (a Client or a PoolClient). */
export type Queryable = Pick<pg.ClientBase, 'query'>;

// Operator names become the audit actor 'ops:<name>'. Letters first, then a small
// safe set, so the actor stays readable and cannot smuggle in odd characters.
const OPERATOR_RE = /^[A-Za-z][A-Za-z0-9 ._'-]{0,63}$/;

export function parseOperator(raw: string | undefined): string {
  const name = raw?.trim() ?? '';
  if (!name) throw new AdminError('--by <operator name> is required (it goes in the audit log).');
  if (!OPERATOR_RE.test(name)) {
    throw new AdminError(
      "--by must start with a letter and use only letters, digits, spaces and . _ ' - (max 64).",
    );
  }
  return name;
}

export function actorFor(operator: string): string {
  return `ops:${operator}`;
}

// A plain shape check. The database (CITEXT, UNIQUE) is the real authority.
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function parseEmail(raw: string | undefined): string {
  const email = raw?.trim() ?? '';
  if (!email) throw new AdminError('--email <email> is required.');
  if (email.length > 254 || !EMAIL_RE.test(email)) {
    throw new AdminError(`--email "${email}" is not an email address.`);
  }
  return email;
}

export function parseExpectDb(raw: string | undefined): string {
  const db = raw?.trim() ?? '';
  if (!db) throw new AdminError('--expect-db <database name> is required (wrong-database guard).');
  return db;
}

export function parseReason(raw: string | undefined, required: boolean): string | undefined {
  const reason = raw?.trim() ?? '';
  if (!reason) {
    if (required) throw new AdminError('--reason "<text>" is required.');
    return undefined;
  }
  if (reason.length > 500) throw new AdminError('--reason is too long (max 500 characters).');
  return reason;
}

export interface TraineeRef {
  id: string; // BIGINT comes back from pg as a string
  email: string;
}

export async function findTraineeByEmail(db: Queryable, email: string): Promise<TraineeRef> {
  const { rows } = await db.query<TraineeRef>(
    'SELECT id::text AS id, email::text AS email FROM academy.trainees WHERE email = $1',
    [email],
  );
  const row = rows[0];
  if (!row) throw new AdminError(`No trainee with email ${email}.`);
  return row;
}

export async function writeAudit(
  db: Queryable,
  event: {
    traineeId: string | null;
    eventType: string;
    actor: string;
    payload: Record<string, unknown>;
  },
): Promise<string> {
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO academy.audit_events (trainee_id, event_type, payload, actor)
     VALUES ($1, $2, $3::jsonb, $4) RETURNING id::text AS id`,
    [event.traineeId, event.eventType, JSON.stringify(event.payload), event.actor],
  );
  return rows[0]!.id;
}

/** Runs fn in one transaction; commits, or rolls back on dry run or error. */
export async function inTransaction<T>(
  client: Queryable,
  dryRun: boolean,
  fn: () => Promise<T>,
): Promise<T> {
  await client.query('BEGIN');
  try {
    const result = await fn();
    await client.query(dryRun ? 'ROLLBACK' : 'COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  }
}

/** Connects with the app's DB settings and checks the wrong-database guard. */
export async function connectAdmin(expectDb: string, dryRun: boolean): Promise<pg.Client> {
  loadDotenvIfPresent();
  const parsed = DbSettingsSchema.safeParse(process.env);
  if (!parsed.success) {
    const names = [...new Set(parsed.error.issues.map((i) => String(i.path[0])))];
    throw new AdminError(`Missing or invalid database settings: ${names.join(', ')}.`);
  }
  const client = new pg.Client(
    pgConfig(parsed.data, { applicationName: 'academy-admin', statementTimeoutMs: 30_000 }),
  );
  await client.connect();
  try {
    const info = await client.query<{ db: string; usr: string }>(
      'SELECT current_database() AS db, current_user AS usr',
    );
    const { db, usr } = info.rows[0]!;
    console.log(`Database: ${db}   user: ${usr}   mode: ${dryRun ? 'dry run' : 'commit'}`);
    if (db !== expectDb) {
      throw new AdminError(
        `Wrong database: connected to "${db}" but --expect-db is "${expectDb}".`,
      );
    }
    return client;
  } catch (err) {
    await client.end().catch(() => undefined);
    throw err;
  }
}

function isMain(moduleUrl: string): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  const a = path.resolve(entry);
  const b = fileURLToPath(moduleUrl);
  return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
}

/** Runs main() when the module is the entry point; exit 0 on success, 1 on any error. */
export function runIfMain(moduleUrl: string, name: string, main: () => Promise<number>): void {
  if (!isMain(moduleUrl)) return;
  main().then(
    (code) => process.exit(code),
    (err: unknown) => {
      // Message only: pg errors can echo parameter values, so no detail or stack.
      const e = err as { message?: string; code?: string; name?: string };
      const known = e.name === 'AdminError' || e.name === 'TypeError';
      console.error(
        `${name}: ${known ? e.message : `${e.code ?? ''} ${e.message ?? String(err)}`}`,
      );
      process.exit(1);
    },
  );
}
