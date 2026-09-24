// Shared plumbing for the two backup CLIs in ops/backup/:
//   * backup.ts        — takes a backup of BOTH halves (database + media),
//   * restore-drill.ts — restores the latest one into throw-away copies and
//                        proves, rather than assumes, that it came back whole.
//
// Decision D15 is why there are two halves: there is no S3. The recordings,
// the walkthrough video and the certificate PDFs are ordinary files in the
// folder named by MEDIA_ROOT on the on-prem server, so a backup that only
// dumps the database loses every one of them.
//
// Rules that hold everywhere in here:
//   * nothing is ever written inside the repo — a dump or a copy of the media
//     folder would be committed on the next `git add .` (CLAUDE.md);
//   * a password is never put on a command line and never printed. Postgres
//     tools get it through PGPASSWORD in the CHILD process environment only,
//     which does not appear in `ps` on any platform we run on;
//   * no server name, path or credential is hard-coded. Everything comes from
//     the environment, so the same script runs on a laptop and on the server.

import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isProductionDbName } from '../lib/production-db.js';

export class BackupError extends Error {
  override name = 'BackupError';
}

export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

/** The one schema the academy owns. Everything else in the database is the CRM's. */
export const ACADEMY_SCHEMA = 'academy';

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

// Windows paths are case-insensitive: E:\RRC and e:\rrc are the same folder.
function normCase(p: string): string {
  return process.platform === 'win32' ? p.toLowerCase() : p;
}

export function isInside(child: string, parent: string): boolean {
  const rel = path.relative(normCase(path.resolve(parent)), normCase(path.resolve(child)));
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

/**
 * A backup holds a full copy of the training content and every recording. It
 * must never land inside the repo, even for a moment.
 */
export function assertOutsideRepo(dir: string, what = 'backup', repoRoot = REPO_ROOT): string {
  const abs = path.resolve(dir);
  if (isInside(abs, repoRoot)) {
    throw new BackupError(
      `Refusing to write the ${what} inside the repo (${abs}). A database dump and the media ` +
        'files must stay outside git: choose a folder on the backup volume instead.',
    );
  }
  return abs;
}

/** Every file under `root`, as relative POSIX keys, sorted. Follows no symlinks. */
export async function listFiles(root: string, prefix = ''): Promise<string[]> {
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch (err) {
    if ((err as { code?: string }).code === 'ENOENT') return [];
    throw err;
  }
  const out: string[] = [];
  for (const entry of entries) {
    const key = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
    if (entry.isDirectory()) out.push(...(await listFiles(path.join(root, entry.name), key)));
    else if (entry.isFile()) out.push(key);
  }
  return out.sort();
}

export async function sha256OfFile(file: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk as Buffer);
  return hash.digest('hex');
}

export async function fileBytes(file: string): Promise<number> {
  return (await stat(file)).size;
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${String(bytes)} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(1)} ${units[unit] ?? 'B'}`;
}

/** A timestamp that sorts, and that is legal in a file name on every platform. */
export function backupStamp(at: Date): string {
  const iso = at.toISOString();
  return `${iso.slice(0, 10).replace(/-/g, '')}-${iso.slice(11, 19).replace(/:/g, '')}`;
}

export const BACKUP_DIR_PREFIX = 'academy-backup-';
export const MANIFEST_NAME = 'manifest.json';
export const DUMP_RELATIVE = 'database/academy.dump';
export const MEDIA_RELATIVE = 'media';

// ---------------------------------------------------------------------------
// Database name guards
// ---------------------------------------------------------------------------

/** A name that says, on its face, "nothing of value lives here". */
const THROWAWAY_HINTS = ['drill', 'restore', 'scratch', 'throwaway', 'sandbox'];

/** Postgres identifiers we are willing to interpolate into DDL, and nothing else. */
const DB_NAME_PATTERN = /^[a-z][a-z0-9_]{0,62}$/;

/**
 * True when a database name is production. The rule lives in
 * ops/lib/production-db.ts, which knows the CRM's own database by name:
 * 'client_credentials' contains neither 'prod' nor 'live', so a substring
 * search alone would have let the restore drill drop a schema inside it.
 */
export function looksLikeProduction(name: string): boolean {
  return isProductionDbName(name);
}

export interface ThrowAwayOptions {
  /**
   * The drill is restoring into a database that ALREADY exists and will only
   * drop and recreate the `academy` schema inside it (the fallback for a login
   * that may not create databases). A `test` database is then acceptable too:
   * by this repo's convention those are rebuilt by the suites that use them.
   * It still has to be asked for with two explicit flags.
   */
  intoExisting?: boolean;
}

/**
 * True only for a name that is obviously disposable. The restore drill creates
 * and drops this database, so the bar is deliberately high: a name that merely
 * looks local ('dev') is NOT enough — `academy_dev` holds work.
 */
export function isThrowAwayDbName(name: string, opts: ThrowAwayOptions = {}): boolean {
  const lower = name.trim().toLowerCase();
  if (!DB_NAME_PATTERN.test(lower)) return false;
  if (looksLikeProduction(lower)) return false;
  if (THROWAWAY_HINTS.some((hint) => lower.includes(hint))) return true;
  return opts.intoExisting === true && lower.includes('test');
}

/**
 * The restore target, checked before any connection is opened. It must be
 * throw-away by name, and it must not be the database the backup came from or
 * the one the application is pointed at.
 */
export function assertThrowAwayTarget(
  target: string,
  context: { sourceDb?: string | undefined; appDb?: string | undefined; intoExisting?: boolean },
): string {
  const name = target.trim();
  if (name === '') {
    throw new BackupError('--target-db <database name> is required.');
  }
  if (!DB_NAME_PATTERN.test(name.toLowerCase())) {
    throw new BackupError(
      `Refusing "${name}": a restore target must be a plain lower-case Postgres name ` +
        '(letters, digits and underscores, starting with a letter).',
    );
  }
  if (!isThrowAwayDbName(name, { intoExisting: context.intoExisting === true })) {
    throw new BackupError(
      `Refusing "${name}": the restore drill only ever writes to a database whose name says it ` +
        `is disposable (one of: ${THROWAWAY_HINTS.join(', ')}), for example ` +
        '"academy_restore_drill". It creates and then DROPS this database.',
    );
  }
  const same = (a: string | undefined): boolean =>
    a !== undefined && a.trim().toLowerCase() === name.toLowerCase();
  if (same(context.sourceDb)) {
    throw new BackupError(
      `Refusing "${name}": that is the database the backup was taken from. A drill restores ` +
        'somewhere else, or it is not a drill.',
    );
  }
  if (same(context.appDb)) {
    throw new BackupError(`Refusing "${name}": that is the database the application uses.`);
  }
  return name;
}

/** Safe to interpolate into DDL only because assertThrowAwayTarget ran first. */
export function quoteIdent(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

// ---------------------------------------------------------------------------
// Postgres command-line tools
// ---------------------------------------------------------------------------

export type PgTool = 'pg_dump' | 'pg_restore' | 'psql';

/**
 * Where pg_dump and friends live. Nothing is hard-coded: the folder comes from
 * PG_BIN, an individual tool can be pointed at with ACADEMY_PG_DUMP /
 * ACADEMY_PG_RESTORE / ACADEMY_PSQL, and with neither set the tool is taken
 * from PATH. Production paths never enter the repo that way.
 */
export function pgToolPath(tool: PgTool, env: NodeJS.ProcessEnv = process.env): string {
  const explicit = env[`ACADEMY_${tool.toUpperCase()}`]?.trim();
  if (explicit !== undefined && explicit !== '') return explicit;
  const bin = env['PG_BIN']?.trim();
  if (bin !== undefined && bin !== '') {
    return path.join(bin, process.platform === 'win32' ? `${tool}.exe` : tool);
  }
  return tool;
}

export interface PgRunResult {
  code: number;
  stdout: string;
  stderr: string;
}

/**
 * Runs a Postgres command-line tool.
 *
 * The password goes into the CHILD's environment as PGPASSWORD and nowhere
 * else: not into argv (where `ps` would show it), not into a file, not into
 * this process's own environment. `args` is logged by the callers, so nothing
 * secret may ever be put in it.
 */
export async function runPgTool(
  tool: PgTool,
  args: readonly string[],
  opts: { password?: string | undefined; env?: NodeJS.ProcessEnv } = {},
): Promise<PgRunResult> {
  const base = opts.env ?? process.env;
  const childEnv: NodeJS.ProcessEnv = { ...base };
  if (opts.password !== undefined && opts.password !== '') childEnv['PGPASSWORD'] = opts.password;
  // Never let a .pgpass or a service file in the operator's profile decide
  // which server we talk to.
  childEnv['PGPASSFILE'] = childEnv['PGPASSFILE'] ?? '';
  const exe = pgToolPath(tool, base);

  return new Promise<PgRunResult>((resolve, reject) => {
    const child = spawn(exe, [...args], { env: childEnv, windowsHide: true });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d: Buffer) => {
      stdout += d.toString('utf8');
    });
    child.stderr.on('data', (d: Buffer) => {
      stderr += d.toString('utf8');
    });
    child.on('error', (err: NodeJS.ErrnoException) => {
      reject(
        err.code === 'ENOENT'
          ? new BackupError(
              `Could not run ${tool} ("${exe}"). Put the PostgreSQL bin folder on PATH, or set ` +
                'PG_BIN to it.',
            )
          : new BackupError(`Could not run ${tool}: ${err.message}`),
      );
    });
    child.on('close', (code) => {
      resolve({ code: code ?? -1, stdout, stderr });
    });
  });
}

/** Throws with the tool's own diagnostics when it failed. */
export function assertPgOk(tool: PgTool, result: PgRunResult): PgRunResult {
  if (result.code !== 0) {
    const detail = result.stderr.trim() || result.stdout.trim() || '(no output)';
    throw new BackupError(`${tool} failed (exit ${String(result.code)}):\n${detail}`);
  }
  return result;
}

// ---------------------------------------------------------------------------
// Which login the backup and the restore use
// ---------------------------------------------------------------------------

export interface PgTarget {
  host: string;
  port: number;
  database: string;
  user: string;
  password: string;
  ssl: boolean;
}

function required(env: NodeJS.ProcessEnv, ...names: string[]): string {
  for (const name of names) {
    const value = env[name]?.trim();
    if (value !== undefined && value !== '') return value;
  }
  throw new BackupError(`Missing environment variable: ${names.join(' or ')}.`);
}

/**
 * The login used to READ the database for a backup, and to restore one.
 *
 * It falls back in this order, so nothing has to be configured on a laptop and
 * everything can be overridden on the server:
 *   BACKUP_DB_USER  → MIGRATE_DB_USER  → DB_USER
 * A backup wants to read every object in the schema, which is why the
 * migration (owner) login is preferred over the restricted application one.
 */
export function backupTarget(env: NodeJS.ProcessEnv = process.env, database?: string): PgTarget {
  return {
    host: required(env, 'BACKUP_DB_HOST', 'DB_HOST'),
    port: Number(env['BACKUP_DB_PORT']?.trim() || env['DB_PORT']?.trim() || '5432'),
    database: database ?? required(env, 'BACKUP_DB_NAME', 'DB_NAME'),
    user: required(env, 'BACKUP_DB_USER', 'MIGRATE_DB_USER', 'DB_USER'),
    password: required(env, 'BACKUP_DB_PASSWORD', 'MIGRATE_DB_PASSWORD', 'DB_PASSWORD'),
    ssl: (env['BACKUP_DB_SSL']?.trim() ?? env['DB_SSL']?.trim() ?? 'false') === 'true',
  };
}

/** Connection arguments for a Postgres tool. Never includes the password. */
export function pgArgs(target: PgTarget): string[] {
  return [
    '--host',
    target.host,
    '--port',
    String(target.port),
    '--username',
    target.user,
    '--no-password',
    '--dbname',
    target.database,
  ];
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

/** Prints the checklist table and returns the process exit code. */
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
      ? `\n${name}: ALL PASS (${String(checks.length)} checks)`
      : `\n${name}: ${String(failed.length)} FAIL(s): ${failed.map((c) => c.id).join(' ')}`,
  );
  return failed.length === 0 ? 0 : 1;
}

// ---------------------------------------------------------------------------
// Entry point helper (same shape as ops/admin and ops/dev)
// ---------------------------------------------------------------------------

function isMain(moduleUrl: string): boolean {
  const entry = process.argv[1];
  if (entry === undefined) return false;
  const a = path.resolve(entry);
  const b = fileURLToPath(moduleUrl);
  return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
}

export function runIfMain(moduleUrl: string, name: string, main: () => Promise<number>): void {
  if (!isMain(moduleUrl)) return;
  main().then(
    (code) => {
      process.exit(code);
    },
    (err: unknown) => {
      // Message only: pg errors can echo parameter values, so no detail, no stack.
      const e = err as { message?: string; code?: string; name?: string };
      const known = e.name === 'BackupError' || e.name === 'TypeError';
      console.error(
        `${name}: ${known ? e.message : `${e.code ?? ''} ${e.message ?? String(err)}`}`,
      );
      process.exit(1);
    },
  );
}
