// Takes a backup of BOTH halves of the academy and writes a manifest.
//
//   npx tsx ops/backup/backup.ts --out <folder outside the repo> [--expect-db academy_dev]
//
// Decision D15: there is no S3. The call recordings, the walkthrough video and
// the certificate PDFs are files under MEDIA_ROOT on the on-prem server, so a
// backup that only dumps the database loses them. This script therefore writes:
//
//   <out>/academy-backup-<stamp>/database/academy.dump   pg_dump -Fc -n academy
//   <out>/academy-backup-<stamp>/media/<key>             a copy of MEDIA_ROOT
//   <out>/academy-backup-<stamp>/manifest.json           what is in the other two
//
// The two halves are taken from ONE point in time: the script opens a
// REPEATABLE READ transaction, exports its snapshot, and hands that snapshot
// to pg_dump, so the row counts and the content fingerprint in the manifest
// describe exactly the bytes in the dump. The media copy follows; the runbook
// explains why the window between them is run when nobody is uploading.
//
// Guards:
//   * it refuses to write anywhere inside the repo (a dump and 36 MB of real
//     client recordings must never reach git);
//   * --expect-db, when given, must equal current_database();
//   * the password reaches pg_dump through PGPASSWORD in the child process
//     only. It is never on a command line and never printed.
//
// This one is safe to run against production — it only reads.

import { copyFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { parseArgs } from 'node:util';
import pg from 'pg';
import { loadDotenvIfPresent } from '../../server/src/config/dotenv.js';
import { contentFingerprint } from './fingerprint.js';
import {
  ACADEMY_SCHEMA,
  BACKUP_DIR_PREFIX,
  BackupError,
  DUMP_RELATIVE,
  MANIFEST_NAME,
  MEDIA_RELATIVE,
  assertOutsideRepo,
  assertPgOk,
  backupStamp,
  backupTarget,
  fileBytes,
  formatBytes,
  listFiles,
  pgArgs,
  quoteIdent,
  runIfMain,
  runPgTool,
  sha256OfFile,
  table,
} from './lib.js';
import type { PgTarget } from './lib.js';
import { writeManifest } from './manifest.js';
import type { Manifest, MediaFileEntry, TableCount } from './manifest.js';

export const BACKUP_USAGE =
  'Usage: backup --out <folder outside the repo> [--expect-db <database name>] ' +
  '[--media-root <folder>] [--label "<short note>"]';

export interface BackupArgs {
  outRoot: string;
  expectDb: string | undefined;
  mediaRoot: string;
  label: string | undefined;
}

export function parseBackupArgs(argv: string[], env: NodeJS.ProcessEnv): BackupArgs | 'help' {
  const { values } = parseArgs({
    args: argv,
    strict: true,
    allowPositionals: false,
    options: {
      out: { type: 'string' },
      'expect-db': { type: 'string' },
      'media-root': { type: 'string' },
      label: { type: 'string' },
      help: { type: 'boolean', short: 'h', default: false },
    },
  });
  if (values.help === true) return 'help';

  const out = values.out?.trim() ?? '';
  if (out === '') {
    throw new BackupError('--out <folder outside the repo> is required.');
  }
  const mediaRoot = values['media-root']?.trim() || env['MEDIA_ROOT']?.trim() || '';
  if (mediaRoot === '') {
    throw new BackupError(
      'MEDIA_ROOT is not set and --media-root was not given. The media folder is half the ' +
        'backup (decision D15): without it a restore has no recordings and no certificates.',
    );
  }
  const label = values.label?.trim();
  return {
    outRoot: assertOutsideRepo(out),
    expectDb: values['expect-db']?.trim() || undefined,
    mediaRoot: path.resolve(mediaRoot),
    ...(label !== undefined && label !== '' ? { label } : { label: undefined }),
  };
}

// ---------------------------------------------------------------------------
// Database half
// ---------------------------------------------------------------------------

/** Every ordinary table in the `academy` schema, in name order. */
export async function listAcademyTables(client: pg.ClientBase): Promise<string[]> {
  const { rows } = await client.query<{ relname: string }>(
    `SELECT c.relname
       FROM pg_class c
       JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = $1 AND c.relkind = 'r'
      ORDER BY c.relname`,
    [ACADEMY_SCHEMA],
  );
  return rows.map((r) => r.relname);
}

/** Row counts, read inside the caller's snapshot so they match the dump. */
export async function countRows(
  client: pg.ClientBase,
  tables: readonly string[],
): Promise<TableCount[]> {
  const out: TableCount[] = [];
  for (const name of tables) {
    const { rows } = await client.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM ${quoteIdent(ACADEMY_SCHEMA)}.${quoteIdent(name)}`,
    );
    out.push({ table: name, rows: Number(rows[0]?.n ?? '0') });
  }
  return out;
}

interface MigrationRow {
  filename: string;
  applied_at: string;
}

async function readSchemaVersion(
  client: pg.ClientBase,
): Promise<{ last: MigrationRow | null; count: number }> {
  const { rows } = await client.query<MigrationRow>(
    `SELECT filename, applied_at::text AS applied_at
       FROM ${quoteIdent(ACADEMY_SCHEMA)}.schema_migrations
      ORDER BY filename`,
  );
  return { last: rows.at(-1) ?? null, count: rows.length };
}

// ---------------------------------------------------------------------------
// Media half
// ---------------------------------------------------------------------------

/**
 * Copies MEDIA_ROOT into the backup, checksumming the source and then the copy.
 * A copy whose hash does not match the source is a failed backup, not a warning.
 */
export async function copyMedia(mediaRoot: string, destination: string): Promise<MediaFileEntry[]> {
  const keys = await listFiles(mediaRoot);
  const entries: MediaFileEntry[] = [];
  for (const key of keys) {
    const from = path.join(mediaRoot, ...key.split('/'));
    const to = path.join(destination, ...key.split('/'));
    await mkdir(path.dirname(to), { recursive: true });
    const sourceHash = await sha256OfFile(from);
    await copyFile(from, to);
    const copyHash = await sha256OfFile(to);
    if (copyHash !== sourceHash) {
      throw new BackupError(`The copy of ${key} does not match the original. Backup aborted.`);
    }
    entries.push({ key, bytes: await fileBytes(to), sha256: copyHash });
  }
  return entries;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function clientConfig(target: PgTarget): pg.ClientConfig {
  return {
    host: target.host,
    port: target.port,
    database: target.database,
    user: target.user,
    password: target.password,
    ssl: target.ssl ? { rejectUnauthorized: false } : false,
    application_name: 'academy-backup',
    // No statement timeout: counting every row of a full database is a normal
    // part of taking a backup, and the transaction is READ ONLY.
    options: '-c search_path=academy,public -c statement_timeout=0',
    connectionTimeoutMillis: 15_000,
  };
}

async function main(): Promise<number> {
  loadDotenvIfPresent();
  const parsed = parseBackupArgs(process.argv.slice(2), process.env);
  if (parsed === 'help') {
    console.log(BACKUP_USAGE);
    return 0;
  }
  const args = parsed;
  const startedAt = new Date();
  const dir = path.join(args.outRoot, BACKUP_DIR_PREFIX + backupStamp(startedAt));
  const dumpPath = path.join(dir, ...DUMP_RELATIVE.split('/'));
  const mediaDir = path.join(dir, MEDIA_RELATIVE);

  const target = backupTarget(process.env);
  const client = new pg.Client(clientConfig(target));
  await client.connect();

  let manifest: Manifest;
  try {
    const info = await client.query<{ db: string; usr: string; ver: string }>(
      "SELECT current_database() AS db, current_user AS usr, current_setting('server_version') AS ver",
    );
    const { db, usr, ver } = info.rows[0]!;
    console.log(`Database: ${db}   user: ${usr}   PostgreSQL ${ver}`);
    if (args.expectDb !== undefined && db !== args.expectDb) {
      throw new BackupError(
        `Wrong database: connected to "${db}" but --expect-db is "${args.expectDb}".`,
      );
    }

    await mkdir(path.dirname(dumpPath), { recursive: true });
    await mkdir(mediaDir, { recursive: true });

    // One point in time for both the counts and the dump.
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    let snapshot: string;
    try {
      const snap = await client.query<{ id: string }>('SELECT pg_export_snapshot() AS id');
      snapshot = snap.rows[0]!.id;

      const tables = await listAcademyTables(client);
      if (tables.length === 0) {
        throw new BackupError(
          `Schema "${ACADEMY_SCHEMA}" has no tables in database "${db}". Nothing to back up.`,
        );
      }
      const counts = await countRows(client, tables);
      const version = await readSchemaVersion(client);
      const fingerprint = await contentFingerprint(client);

      console.log(`Snapshot: exported; dumping schema "${ACADEMY_SCHEMA}" with pg_dump...`);
      assertPgOk(
        'pg_dump',
        await runPgTool(
          'pg_dump',
          [
            '--format=custom',
            `--schema=${ACADEMY_SCHEMA}`,
            `--snapshot=${snapshot}`,
            '--file',
            dumpPath,
            ...pgArgs(target),
          ],
          { password: target.password },
        ),
      );
      await client.query('COMMIT');

      const dumpBytes = await fileBytes(dumpPath);
      const dumpSha256 = await sha256OfFile(dumpPath);

      console.log(`Media:    copying ${args.mediaRoot} ...`);
      const files = await copyMedia(args.mediaRoot, mediaDir);
      const totalBytes = files.reduce((n, f) => n + f.bytes, 0);

      manifest = {
        manifestVersion: 1,
        tool: 'ops/backup/backup.ts',
        ...(args.label !== undefined ? { label: args.label } : {}),
        startedAt: startedAt.toISOString(),
        finishedAt: new Date().toISOString(),
        database: {
          name: db,
          host: target.host,
          port: target.port,
          user: usr,
          schema: ACADEMY_SCHEMA,
          serverVersion: ver,
          schemaVersion: version.last?.filename ?? null,
          schemaVersionAppliedAt: version.last?.applied_at ?? null,
          migrationCount: version.count,
          dumpFile: DUMP_RELATIVE,
          dumpBytes,
          dumpSha256,
          tables: counts,
          contentFingerprint: fingerprint.overall,
          contentTables: fingerprint.perTable,
        },
        media: {
          root: args.mediaRoot,
          dir: MEDIA_RELATIVE,
          fileCount: files.length,
          totalBytes,
          files,
        },
      };
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw err;
    }
  } finally {
    await client.end().catch(() => undefined);
  }

  await writeManifest(path.join(dir, MANIFEST_NAME), manifest);

  // ---- what it wrote --------------------------------------------------------
  const nonEmpty = manifest.database.tables.filter((t) => t.rows > 0);
  console.log(
    '\nWhat this backup holds\n' +
      table(
        ['part', 'what', 'size'],
        [
          [
            'database',
            `${manifest.database.name} / schema ${ACADEMY_SCHEMA}`,
            formatBytes(manifest.database.dumpBytes),
          ],
          [
            'tables',
            `${String(manifest.database.tables.length)} (${String(nonEmpty.length)} with rows, ` +
              `${String(manifest.database.tables.reduce((n, t) => n + t.rows, 0))} rows in total)`,
            '',
          ],
          [
            'schema version',
            manifest.database.schemaVersion ?? '(none)',
            `${String(manifest.database.migrationCount)} migrations`,
          ],
          ['content fingerprint', manifest.database.contentFingerprint.slice(0, 16), ''],
          [
            'media',
            `${String(manifest.media.fileCount)} file(s) from ${manifest.media.root}`,
            formatBytes(manifest.media.totalBytes),
          ],
        ],
      ),
  );
  console.log(
    '\nRows per table (non-empty)\n' +
      table(
        ['table', 'rows'],
        nonEmpty.map((t) => [t.table, t.rows]),
      ),
  );
  console.log(`\nFolder:   ${dir}`);
  console.log(`Dump:     ${path.join(dir, ...DUMP_RELATIVE.split('/'))}`);
  console.log(`Media:    ${mediaDir}`);
  console.log(`Manifest: ${path.join(dir, MANIFEST_NAME)}`);
  console.log(
    `\nbackup: OK — ${formatBytes(manifest.database.dumpBytes + manifest.media.totalBytes)} written. ` +
      'Verify it with ops/backup/restore-drill.ts.',
  );
  return 0;
}

runIfMain(import.meta.url, 'backup', main);
