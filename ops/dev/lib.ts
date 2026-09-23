// Shared plumbing for the LOCAL-ONLY scripts in ops/dev/:
//   * seed-test-accounts.ts — one trainee per track (9) plus one manager,
//   * track-sweep.ts        — the CHECKLIST 04 evidence sweep.
//
// LOCAL / TEST ONLY. Two guards, in this order, and the first one runs before
// any socket is opened:
//   1. the name given with --expect-db must LOOK local: it contains 'dev' or
//      'test', and never 'prod' or 'live'. A name such as 'crm_production' is
//      refused here, so the script never even connects.
//   2. that name must equal DB_NAME in the environment AND current_database().
//
// Nothing in ops/dev/ may run against production. These scripts create and
// delete rows; the ops/admin/ commands are the audited, production-safe ones.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { loadDotenvIfPresent } from '../../server/src/config/dotenv.js';
import { DbSettingsSchema, pgConfig } from '../../server/src/db/connection.js';

export class DevError extends Error {
  override name = 'DevError';
}

/** Anything with a pg-style query method (a Client or a PoolClient). */
export type Queryable = Pick<pg.ClientBase, 'query'>;

// The 9 track codes, in the order of PROJECT-PLAN §1. Same list as
// shared/src/constants.ts and academy.tracks; kept here so the ops scripts stay
// independent of the browser bundle's module graph.
export const DEV_TRACKS = [
  'FULL',
  'CS',
  'SALES',
  'ADMIN',
  'FOS',
  'MGMT',
  'PAY',
  'IT',
  'DEBT',
] as const;

export type DevTrack = (typeof DEV_TRACKS)[number];

export interface DevAccount {
  email: string;
  fullName: string;
  track: DevTrack;
  role: 'STAFF' | 'MANAGER';
  /**
   * NULL for the nine trainees: they do not exist in the CRM. The manager
   * account carries a reserved local-only id (never a real CRM user) purely so
   * a academy.role_overrides row can mark it MANAGER — the role is decided at
   * sign-in from the CRM job role, and role_overrides is keyed by CRM user id.
   */
  crmUserId: string | null;
}

/** Reserved, local-only. Nothing in the CRM has this id. */
export const MANAGER_CRM_USER_ID = '990000100';

// Invented names and @example.com addresses only (CLAUDE.md data hygiene).
export const DEV_ACCOUNTS: readonly DevAccount[] = [
  ...DEV_TRACKS.map((track): DevAccount => ({
    email: `track.${track.toLowerCase()}@example.com`,
    fullName: `Test Trainee (${track})`,
    track,
    role: 'STAFF',
    crmUserId: null,
  })),
  {
    email: 'manager.test@example.com',
    fullName: 'Test Manager (MGMT)',
    track: 'MGMT',
    role: 'MANAGER',
    crmUserId: MANAGER_CRM_USER_ID,
  },
];

/** The nine track accounts, in PROJECT-PLAN §1 order (the sweep's subjects). */
export const DEV_TRACK_ACCOUNTS: readonly DevAccount[] = DEV_ACCOUNTS.filter(
  (a) => a.role === 'STAFF',
);

// ---------------------------------------------------------------------------
// Guards
// ---------------------------------------------------------------------------

const LOCAL_HINTS = ['dev', 'test'];
const FORBIDDEN_HINTS = ['prod', 'live'];

/** True only for a name that clearly belongs to a local or throw-away database. */
export function isLocalDbName(name: string): boolean {
  const lower = name.trim().toLowerCase();
  if (!lower) return false;
  if (FORBIDDEN_HINTS.some((h) => lower.includes(h))) return false;
  return LOCAL_HINTS.some((h) => lower.includes(h));
}

export function parseExpectDb(raw: string | undefined): string {
  const name = raw?.trim() ?? '';
  if (!name) {
    throw new DevError('--expect-db <database name> is required (wrong-database guard).');
  }
  if (!isLocalDbName(name)) {
    throw new DevError(
      `Refusing to run against "${name}": ops/dev scripts are local only. The database name ` +
        "must contain 'dev' or 'test' and must not contain 'prod' or 'live'.",
    );
  }
  return name;
}

export function parseBaseUrl(raw: string | undefined, fallback: string): string {
  const value = raw?.trim() || fallback;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new DevError(`--base-url "${value}" is not a URL.`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new DevError(`--base-url "${value}" must be http or https.`);
  }
  return url.origin + (url.pathname === '/' ? '' : url.pathname.replace(/\/$/, ''));
}

/**
 * Connects with the app's own database settings (DB_USER, normally academy_app)
 * after both guards pass. Throws DevError if anything disagrees.
 */
export async function connectDev(expectDb: string, applicationName: string): Promise<pg.Client> {
  parseExpectDb(expectDb); // guard 1 again: never connect on a non-local name.
  loadDotenvIfPresent();
  const parsed = DbSettingsSchema.safeParse(process.env);
  if (!parsed.success) {
    const names = [...new Set(parsed.error.issues.map((i) => String(i.path[0])))];
    throw new DevError(`Missing or invalid database settings: ${names.join(', ')}.`);
  }
  if (parsed.data.DB_NAME !== expectDb) {
    throw new DevError(
      `DB_NAME is "${parsed.data.DB_NAME}" but --expect-db is "${expectDb}". Refusing.`,
    );
  }
  const client = new pg.Client(
    pgConfig(parsed.data, { applicationName, statementTimeoutMs: 30_000 }),
  );
  await client.connect();
  try {
    const { rows } = await client.query<{ db: string; usr: string }>(
      'SELECT current_database() AS db, current_user AS usr',
    );
    const { db, usr } = rows[0]!;
    if (db !== expectDb) {
      throw new DevError(`Wrong database: connected to "${db}" but --expect-db is "${expectDb}".`);
    }
    if (!isLocalDbName(db)) {
      throw new DevError(`Refusing to work on "${db}": not a local or test database.`);
    }
    console.log(`Database: ${db}   user: ${usr}`);
    return client;
  } catch (err) {
    await client.end().catch(() => undefined);
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Output
// ---------------------------------------------------------------------------

export function table(headers: readonly string[], rows: readonly (string | number)[][]): string {
  const cells = [headers.map(String), ...rows.map((r) => r.map(String))];
  const widths = headers.map((_, c) => Math.max(...cells.map((r) => (r[c] ?? '').length)));
  const line = (r: readonly string[]): string =>
    '| ' + r.map((v, c) => v.padEnd(widths[c] ?? 0)).join(' | ') + ' |';
  const sep = '|' + widths.map((w) => '-'.repeat(w + 2)).join('|') + '|';
  return [line(cells[0]!), sep, ...cells.slice(1).map(line)].join('\n');
}

export interface Check {
  id: string;
  item: string;
  pass: boolean;
  evidence: string;
}

export function summarise(name: string, label: string, checks: readonly Check[]): number {
  console.log(
    `\n${label}\n` +
      table(
        ['#', 'item', 'result', 'evidence'],
        checks.map((c) => [c.id, c.item, c.pass ? 'PASS' : 'FAIL', c.evidence]),
      ),
  );
  const failed = checks.filter((c) => !c.pass);
  console.log(
    failed.length === 0
      ? `\n${name}: ALL PASS (${checks.length} checks)`
      : `\n${name}: ${failed.length} FAIL(s): ${failed.map((c) => c.id).join(' ')}`,
  );
  return failed.length === 0 ? 0 : 1;
}

// ---------------------------------------------------------------------------
// Entry point helper
// ---------------------------------------------------------------------------

function isMain(moduleUrl: string): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  // Windows paths are case-insensitive, so compare case-insensitively there.
  const a = path.resolve(entry);
  const b = fileURLToPath(moduleUrl);
  return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
}

/** Runs main() when this module is the entry point; exit 0 on success, 1 on any error. */
export function runIfMain(moduleUrl: string, name: string, main: () => Promise<number>): void {
  if (!isMain(moduleUrl)) return;
  main().then(
    (code) => process.exit(code),
    (err: unknown) => {
      // Message only: pg errors can echo parameter values, so no detail or stack.
      const e = err as { message?: string; code?: string; name?: string };
      const known = e.name === 'DevError' || e.name === 'TypeError';
      console.error(
        `${name}: ${known ? e.message : `${e.code ?? ''} ${e.message ?? String(err)}`}`,
      );
      process.exit(1);
    },
  );
}
