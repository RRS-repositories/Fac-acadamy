// Migration runner for the academy schema (CRM pattern: dry run by default,
// a ledger table, one transaction per file).
//
//   npm run migrate -w @fac-academy/server                                   # dry run
//   npm run migrate -w @fac-academy/server -- --commit --expect-db <name>   # apply
//   ... --note "why"                                                         # stored in the ledger
//
// Runs as an owner/admin login: MIGRATE_DB_USER / MIGRATE_DB_PASSWORD override
// DB_USER / DB_PASSWORD. --commit needs --expect-db equal to current_database():
// the wrong-database guard. Exit code 0 = ok, 1 = error. Brad applies
// production migrations.
import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import pg from 'pg';
import { loadDotenvIfPresent } from '../config/dotenv.js';
import { ACADEMY_SEARCH_PATH, DbSettingsSchema, pgConfig, type DbSettings } from './connection.js';

export const MIGRATIONS_DIR = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  'migrations',
);
const FILE_PATTERN = /^(\d{4})_[a-z0-9_]+\.sql$/;
const LEDGER = 'academy.schema_migrations';
const LOCK_KEY = 'academy-migrate';

/** A failure with a message fit to print as-is (no stack trace). */
export class MigrationError extends Error {
  override name = 'MigrationError';
}

export interface CliOptions {
  commit: boolean;
  expectDb: string | undefined;
  note: string | undefined;
  help: boolean;
}

export function parseCliArgs(argv: readonly string[]): CliOptions {
  try {
    const { values } = parseArgs({
      args: [...argv],
      strict: true,
      allowPositionals: false,
      options: {
        commit: { type: 'boolean', default: false },
        'expect-db': { type: 'string' },
        note: { type: 'string' },
        help: { type: 'boolean', short: 'h', default: false },
      },
    });
    return {
      commit: values.commit === true,
      expectDb: values['expect-db'],
      note: values.note,
      help: values.help === true,
    };
  } catch (err) {
    throw new MigrationError(`Bad arguments: ${(err as Error).message}`);
  }
}

/** DB settings from the environment; MIGRATE_DB_USER/PASSWORD win when set. */
export function settingsFromEnv(env: NodeJS.ProcessEnv): DbSettings {
  const merged = {
    ...env,
    DB_USER: env.MIGRATE_DB_USER || env.DB_USER,
    DB_PASSWORD: env.MIGRATE_DB_PASSWORD || env.DB_PASSWORD,
  };
  const parsed = DbSettingsSchema.safeParse(merged);
  if (!parsed.success) {
    // Names only: values (passwords) are never printed.
    const names = [...new Set(parsed.error.issues.map((i) => String(i.path[0])))];
    throw new MigrationError(
      `Missing or invalid database settings: ${names.join(', ')}. ` +
        'Set them in .env or the environment ' +
        '(MIGRATE_DB_USER / MIGRATE_DB_PASSWORD override DB_USER / DB_PASSWORD).',
    );
  }
  return parsed.data;
}

/** sha256 of a migration file; CRLF is normalised so a Windows checkout hashes the same. */
export function sha256(text: string): string {
  return createHash('sha256').update(text.replace(/\r\n/g, '\n'), 'utf8').digest('hex');
}

export interface MigrationFile {
  filename: string;
  sql: string;
  sha256: string;
}

/** Every NNNN_name.sql file in `dir`, sorted by name. Duplicate numbers are an error. */
export async function readMigrationFiles(dir: string = MIGRATIONS_DIR): Promise<MigrationFile[]> {
  const names = (await readdir(dir)).filter((f) => FILE_PATTERN.test(f)).sort();
  const seen = new Map<string, string>();
  for (const name of names) {
    const num = name.slice(0, 4);
    const other = seen.get(num);
    if (other) throw new MigrationError(`Two migrations share number ${num}: ${other}, ${name}`);
    seen.set(num, name);
  }
  return Promise.all(
    names.map(async (filename) => {
      const sql = await readFile(join(dir, filename), 'utf8');
      return { filename, sql, sha256: sha256(sql) };
    }),
  );
}

/** 1-based line and column of a 1-based character position in `sql`. */
export function lineAndColumn(sql: string, position: number): { line: number; column: number } {
  const before = sql.slice(0, Math.max(0, position - 1)).split('\n');
  return { line: before.length, column: (before.at(-1)?.length ?? 0) + 1 };
}

export interface ApplyOptions {
  commit: boolean;
  expectDb?: string | undefined;
  note?: string | undefined;
  dir?: string;
  settings?: DbSettings;
  log?: (line: string) => void;
}

export interface ApplyResult {
  database: string;
  user: string;
  serverVersion: string;
  appliedBefore: number;
  pending: string[];
  applied: string[];
}

interface LedgerRow {
  filename: string;
  sha256: string;
}

async function readLedger(client: pg.Client): Promise<LedgerRow[] | null> {
  const { rows } = await client.query<{ present: boolean }>(
    `SELECT to_regclass('${LEDGER}') IS NOT NULL AS present`,
  );
  if (!rows[0]?.present) return null;
  const res = await client.query<LedgerRow>(
    `SELECT filename, sha256 FROM ${LEDGER} ORDER BY filename`,
  );
  return res.rows;
}

function pendingFiles(files: MigrationFile[], ledger: LedgerRow[], log: (l: string) => void) {
  const byName = new Map(files.map((f) => [f.filename, f]));
  for (const row of ledger) {
    const file = byName.get(row.filename);
    if (!file) {
      log(`WARNING: ${row.filename} is in the ledger but not in the migrations folder.`);
    } else if (file.sha256 !== row.sha256) {
      throw new MigrationError(
        `${row.filename} has changed since it was applied (ledger sha256 ${row.sha256}, ` +
          `file ${file.sha256}). Applied migrations are never edited: fix forward in a new file.`,
      );
    }
  }
  const applied = new Set(ledger.map((r) => r.filename));
  const pending = files.filter((f) => !applied.has(f.filename));
  const lastApplied = [...applied].sort().at(-1);
  const early = pending.find((f) => lastApplied !== undefined && f.filename < lastApplied);
  if (early && lastApplied) {
    throw new MigrationError(
      `${early.filename} is pending but sorts before ${lastApplied}, which is already applied. ` +
        'Renumber it after the last applied migration.',
    );
  }
  return pending;
}

function describePgError(file: MigrationFile, err: unknown): string {
  if (err instanceof pg.DatabaseError) {
    const lines = [`${file.filename} FAILED: ${err.message}`];
    if (err.code) lines.push(`  code: ${err.code}`);
    if (err.position) {
      const { line, column } = lineAndColumn(file.sql, Number(err.position));
      lines.push(`  at line ${line}, column ${column}`);
    }
    if (err.detail) lines.push(`  detail: ${err.detail}`);
    if (err.hint) lines.push(`  hint: ${err.hint}`);
    if (err.where) lines.push(`  where: ${err.where}`);
    return lines.join('\n');
  }
  return `${file.filename} FAILED: ${(err as Error).message}`;
}

/** Dry run (commit=false) or apply every pending migration. Throws MigrationError on failure. */
export async function applyMigrations(opts: ApplyOptions): Promise<ApplyResult> {
  const log = opts.log ?? ((line: string) => console.log(line));
  if (opts.commit && !opts.expectDb) {
    throw new MigrationError(
      '--commit requires --expect-db <database name> (wrong-database guard).',
    );
  }
  const files = await readMigrationFiles(opts.dir);
  const settings = opts.settings ?? settingsFromEnv(process.env);
  const client = new pg.Client(pgConfig(settings, { applicationName: 'academy-migrate' }));
  client.on('notice', (n) => log(`  NOTICE: ${n.message ?? ''}`));
  await client.connect();
  try {
    // No statement timeout for migrations, whatever the role's default is.
    await client.query('SET statement_timeout = 0');
    const info = await client.query<{ db: string; usr: string; ver: string }>(
      "SELECT current_database() AS db, current_user AS usr, current_setting('server_version') AS ver",
    );
    const { db, usr, ver } = info.rows[0]!;
    log(`Database: ${db}   user: ${usr}   server: PostgreSQL ${ver}`);

    if (opts.expectDb !== undefined && opts.expectDb !== db) {
      throw new MigrationError(
        `Wrong database: connected to "${db}" but --expect-db is "${opts.expectDb}". Nothing applied.`,
      );
    }

    if (opts.commit) {
      const lock = await client.query<{ ok: boolean }>(
        'SELECT pg_try_advisory_lock(hashtext($1)) AS ok',
        [LOCK_KEY],
      );
      if (!lock.rows[0]?.ok) throw new MigrationError('Another migration run holds the lock.');
      await client.query('CREATE SCHEMA IF NOT EXISTS academy');
      await client.query(`CREATE TABLE IF NOT EXISTS ${LEDGER} (
        filename   text PRIMARY KEY,
        sha256     text NOT NULL,
        applied_at timestamptz NOT NULL DEFAULT now(),
        applied_by text NOT NULL DEFAULT current_user,
        note       text
      )`);
    }

    // Dry run: a missing ledger means nothing has been applied yet.
    const ledger = (await readLedger(client)) ?? [];
    const pending = pendingFiles(files, ledger, log);
    log(`Applied: ${ledger.length}   pending: ${pending.length}`);
    for (const f of pending) log(`  - ${f.filename}`);

    const result: ApplyResult = {
      database: db,
      user: usr,
      serverVersion: ver,
      appliedBefore: ledger.length,
      pending: pending.map((f) => f.filename),
      applied: [],
    };
    if (!opts.commit) {
      log('Dry run: nothing written. Re-run with --commit --expect-db <name> to apply.');
      return result;
    }

    for (const file of pending) {
      log(`Applying ${file.filename} ...`);
      try {
        await client.query('BEGIN');
        await client.query(`SET LOCAL search_path TO ${ACADEMY_SEARCH_PATH}`);
        await client.query(file.sql);
        await client.query(`INSERT INTO ${LEDGER} (filename, sha256, note) VALUES ($1, $2, $3)`, [
          file.filename,
          file.sha256,
          opts.note ?? null,
        ]);
        await client.query('COMMIT');
      } catch (err) {
        await client.query('ROLLBACK').catch(() => undefined);
        const notRun = pending.slice(pending.indexOf(file) + 1).map((f) => f.filename);
        const tail = notRun.length ? `\nNot applied (stopped): ${notRun.join(', ')}` : '';
        throw new MigrationError(describePgError(file, err) + tail);
      }
      result.applied.push(file.filename);
      log(`  ok`);
    }
    log(`Done: ${result.applied.length} applied.`);
    return result;
  } finally {
    await client.end().catch(() => undefined);
  }
}

async function main(): Promise<void> {
  const args = parseCliArgs(process.argv.slice(2));
  if (args.help) {
    console.log('Usage: migrate [--commit --expect-db <name>] [--note <text>]');
    return;
  }
  loadDotenvIfPresent();
  const settings = settingsFromEnv(process.env);
  await applyMigrations({
    commit: args.commit,
    expectDb: args.expectDb,
    note: args.note,
    settings,
  });
}

function isMain(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  const a = resolve(entry);
  const b = fileURLToPath(import.meta.url);
  return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
}

if (isMain()) {
  main().catch((err: unknown) => {
    // Clear message, no stack dump.
    const e = err as { message?: string; code?: string };
    console.error(`migrate: ${e.message || e.code || String(err)}`);
    process.exit(1);
  });
}
