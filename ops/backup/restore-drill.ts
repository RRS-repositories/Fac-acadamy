// The restore drill the go-live gate demands (SECTION 10, gate item 2:
// "Backups: nightly Postgres snapshot + restore drill performed once").
//
//   npx tsx ops/backup/restore-drill.ts --from <folder holding the backups>
//
// It takes the newest backup ops/backup/backup.ts wrote, restores BOTH halves
// into throw-away copies — a throw-away database and a throw-away media
// folder — and then PROVES the restore instead of assuming it:
//
//   * the dump file still matches the sha256 the manifest recorded;
//   * pg_restore finished without errors;
//   * every media file is back, byte for byte, with a matching sha256, and
//     there is nothing extra;
//   * the restored schema has exactly the tables the manifest lists, with the
//     same row count in every one of them;
//   * the content fingerprint (the same canonical hash ops/seed/verify-seed.ts
//     prints) matches the one taken at backup time;
//   * the schema version — the last row of academy.schema_migrations — matches;
//   * every media key the restored database points at exists in the restored
//     media folder (decision D15: the database alone does not hold the media);
//   * every certificate PDF still opens, i.e. starts with %PDF-.
//
// It prints a PASS/FAIL table and exits non-zero on any failure, then drops the
// throw-away database and folder unless --keep.
//
// Guards, before anything is opened:
//   * the target database name must be clearly throw-away, and must be neither
//     the database the backup came from nor the one the app uses;
//   * the throw-away media folder must be outside the repo and must not be the
//     real MEDIA_ROOT;
//   * no password is ever printed or put on a command line.

import { existsSync } from 'node:fs';
import { mkdir, open, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { parseArgs } from 'node:util';
import pg from 'pg';
import { loadDotenvIfPresent } from '../../server/src/config/dotenv.js';
import { copyMedia, countRows, listAcademyTables } from './backup.js';
import { contentFingerprint } from './fingerprint.js';
import {
  ACADEMY_SCHEMA,
  BACKUP_DIR_PREFIX,
  BackupError,
  MANIFEST_NAME,
  assertOutsideRepo,
  assertThrowAwayTarget,
  backupStamp,
  backupTarget,
  fileBytes,
  formatBytes,
  isInside,
  listFiles,
  pgArgs,
  quoteIdent,
  runIfMain,
  runPgTool,
  sha256OfFile,
  summarise,
  table,
} from './lib.js';
import type { Check, PgTarget } from './lib.js';
import {
  PDF_MAGIC,
  compareMedia,
  compareRowCounts,
  compareTableList,
  looksLikePdf,
  readManifest,
} from './manifest.js';
import type { MediaFileEntry } from './manifest.js';

export const RESTORE_DRILL_USAGE =
  'Usage: restore-drill --from <folder holding the backups> [--target-db academy_restore_drill] ' +
  '[--media-dir <folder outside the repo>] [--into-existing --drop-schema] [--keep]';

export const DEFAULT_TARGET_DB = 'academy_restore_drill';

export interface RestoreDrillArgs {
  from: string;
  targetDb: string;
  mediaDir: string;
  intoExisting: boolean;
  keep: boolean;
}

export function parseRestoreDrillArgs(
  argv: string[],
  env: NodeJS.ProcessEnv,
  now = new Date(),
): RestoreDrillArgs | 'help' {
  const { values } = parseArgs({
    args: argv,
    strict: true,
    allowPositionals: false,
    options: {
      from: { type: 'string' },
      'target-db': { type: 'string' },
      'media-dir': { type: 'string' },
      'into-existing': { type: 'boolean', default: false },
      'drop-schema': { type: 'boolean', default: false },
      keep: { type: 'boolean', default: false },
      help: { type: 'boolean', short: 'h', default: false },
    },
  });
  if (values.help === true) return 'help';

  const from = values.from?.trim() ?? '';
  if (from === '') throw new BackupError('--from <folder holding the backups> is required.');

  const intoExisting = values['into-existing'] === true;
  if (intoExisting && values['drop-schema'] !== true) {
    throw new BackupError(
      '--into-existing restores into a database that already exists, which means dropping and ' +
        `recreating its "${ACADEMY_SCHEMA}" schema. Confirm that with --drop-schema.`,
    );
  }

  const targetDb = assertThrowAwayTarget(values['target-db']?.trim() || DEFAULT_TARGET_DB, {
    appDb: env['DB_NAME']?.trim(),
    intoExisting,
  });

  const mediaDir = assertOutsideRepo(
    values['media-dir']?.trim() || path.join(tmpdir(), `academy-restore-drill-${backupStamp(now)}`),
    'restored media',
  );
  const realMediaRoot = env['MEDIA_ROOT']?.trim();
  if (realMediaRoot !== undefined && realMediaRoot !== '') {
    if (isInside(mediaDir, realMediaRoot) || isInside(realMediaRoot, mediaDir)) {
      throw new BackupError(
        'Refusing to restore the media into (or around) the real MEDIA_ROOT. A drill restores ' +
          'to a throw-away folder; the live folder is never written to.',
      );
    }
  }

  return { from: path.resolve(from), targetDb, mediaDir, intoExisting, keep: values.keep === true };
}

// ---------------------------------------------------------------------------
// Finding the newest backup
// ---------------------------------------------------------------------------

/** `from` may be a backup folder itself, or the folder the backups are written into. */
export async function findLatestBackup(from: string): Promise<string> {
  if (existsSync(path.join(from, MANIFEST_NAME))) return from;
  let entries;
  try {
    entries = await readdir(from, { withFileTypes: true });
  } catch {
    throw new BackupError(`--from does not point at a folder: ${from}`);
  }
  const candidates = entries
    .filter((e) => e.isDirectory() && e.name.startsWith(BACKUP_DIR_PREFIX))
    .map((e) => e.name)
    .filter((name) => existsSync(path.join(from, name, MANIFEST_NAME)))
    .sort();
  const latest = candidates.at(-1);
  if (latest === undefined) {
    throw new BackupError(
      `No backup found under ${from}. Expected either a ${MANIFEST_NAME} there, or one or more ` +
        `"${BACKUP_DIR_PREFIX}*" folders that each hold one.`,
    );
  }
  return path.join(from, latest);
}

// ---------------------------------------------------------------------------
// Postgres helpers
// ---------------------------------------------------------------------------

function clientConfig(target: PgTarget, applicationName: string): pg.ClientConfig {
  return {
    host: target.host,
    port: target.port,
    database: target.database,
    user: target.user,
    password: target.password,
    ssl: target.ssl ? { rejectUnauthorized: false } : false,
    application_name: applicationName,
    options: '-c search_path=academy,public -c statement_timeout=0',
    connectionTimeoutMillis: 15_000,
  };
}

async function connect(target: PgTarget, applicationName: string): Promise<pg.Client> {
  const client = new pg.Client(clientConfig(target, applicationName));
  await client.connect();
  return client;
}

async function withClient<T>(target: PgTarget, fn: (client: pg.Client) => Promise<T>): Promise<T> {
  const client = await connect(target, 'academy-restore-drill');
  try {
    return await fn(client);
  } finally {
    await client.end().catch(() => undefined);
  }
}

/** The maintenance database, where CREATE/DROP DATABASE has to be issued. */
function maintenanceTarget(env: NodeJS.ProcessEnv): PgTarget {
  return backupTarget(env, env['BACKUP_MAINTENANCE_DB']?.trim() || 'postgres');
}

async function assertCanCreateDatabases(client: pg.Client): Promise<void> {
  const { rows } = await client.query<{ ok: boolean; usr: string }>(
    `SELECT (rolsuper OR rolcreatedb) AS ok, rolname AS usr
       FROM pg_roles WHERE rolname = current_user`,
  );
  const row = rows[0];
  if (row === undefined || !row.ok) {
    throw new BackupError(
      `The restore login (${row?.usr ?? 'current_user'}) may not create databases, so the drill ` +
        'cannot make its throw-away copy. Either point BACKUP_DB_USER/BACKUP_DB_PASSWORD at a ' +
        'login that can, or have an administrator run "ALTER ROLE <login> CREATEDB;" once, or ' +
        'pre-create the throw-away database and re-run with --into-existing --drop-schema.',
    );
  }
}

// ---------------------------------------------------------------------------
// Reading the restored copies
// ---------------------------------------------------------------------------

interface ReferencedKey {
  source: string;
  key: string;
}

/** Every media key the restored database points at, from both tables that hold one. */
async function referencedMediaKeys(client: pg.ClientBase): Promise<ReferencedKey[]> {
  const { rows } = await client.query<ReferencedKey>(
    `SELECT 'call_recordings' AS source, media_key AS key
       FROM ${quoteIdent(ACADEMY_SCHEMA)}.call_recordings WHERE media_key IS NOT NULL
      UNION ALL
     SELECT 'certificates' AS source, media_key AS key
       FROM ${quoteIdent(ACADEMY_SCHEMA)}.certificates WHERE media_key IS NOT NULL
      ORDER BY 1, 2`,
  );
  return rows;
}

async function certificateKeys(client: pg.ClientBase): Promise<string[]> {
  const { rows } = await client.query<{ key: string }>(
    `SELECT media_key AS key FROM ${quoteIdent(ACADEMY_SCHEMA)}.certificates
      WHERE media_key IS NOT NULL ORDER BY 1`,
  );
  return rows.map((r) => r.key);
}

/** Reads the first bytes of a file, for the %PDF- check. */
export async function readHead(file: string, bytes = 8): Promise<Buffer> {
  const handle = await open(file, 'r');
  try {
    const buffer = Buffer.alloc(bytes);
    const { bytesRead } = await handle.read(buffer, 0, bytes, 0);
    return buffer.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
}

/** Hashes everything under `root`, independently of how it got there. */
export async function describeMedia(root: string): Promise<MediaFileEntry[]> {
  const keys = await listFiles(root);
  const out: MediaFileEntry[] = [];
  for (const key of keys) {
    const file = path.join(root, ...key.split('/'));
    out.push({ key, bytes: await fileBytes(file), sha256: await sha256OfFile(file) });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<number> {
  loadDotenvIfPresent();
  const parsed = parseRestoreDrillArgs(process.argv.slice(2), process.env);
  if (parsed === 'help') {
    console.log(RESTORE_DRILL_USAGE);
    return 0;
  }
  const args = parsed;

  const backupDir = await findLatestBackup(args.from);
  const manifest = await readManifest(path.join(backupDir, MANIFEST_NAME));
  const dumpPath = path.join(backupDir, ...manifest.database.dumpFile.split('/'));
  const backupMediaDir = path.join(backupDir, manifest.media.dir);

  // The target must also differ from the database the backup came from.
  assertThrowAwayTarget(args.targetDb, {
    sourceDb: manifest.database.name,
    appDb: process.env['DB_NAME']?.trim(),
    intoExisting: args.intoExisting,
  });

  console.log(`Backup:   ${backupDir}`);
  console.log(`Taken:    ${manifest.finishedAt}  from database "${manifest.database.name}"`);
  console.log(`Restore:  database "${args.targetDb}"  media "${args.mediaDir}"`);
  console.log(
    'Mode:     ' +
      (args.intoExisting
        ? 'into an existing throw-away database (its academy schema is dropped first)'
        : 'create a throw-away database, then drop it') +
      (args.keep ? '  [--keep: nothing is dropped]' : '') +
      '\n',
  );

  const checks: Check[] = [];
  const add = (id: string, item: string, pass: boolean, evidence: string): void => {
    checks.push({ id, item, pass, evidence });
  };

  // ---- b1. the backup itself is intact ------------------------------------
  if (!existsSync(dumpPath)) throw new BackupError(`The backup has no dump file at ${dumpPath}.`);
  const dumpBytes = await fileBytes(dumpPath);
  const dumpSha = await sha256OfFile(dumpPath);
  add(
    'b1',
    'Dump file is the one the manifest recorded (size and sha256)',
    dumpBytes === manifest.database.dumpBytes && dumpSha === manifest.database.dumpSha256,
    `${formatBytes(dumpBytes)}, sha256 ${dumpSha.slice(0, 16)} ` +
      `(manifest ${manifest.database.dumpSha256.slice(0, 16)})`,
  );

  const target = backupTarget(process.env, args.targetDb);
  let created = false;

  try {
    // ---- the throw-away database --------------------------------------------
    await withClient(maintenanceTarget(process.env), async (admin) => {
      const { rows } = await admin.query<{ n: string }>(
        'SELECT count(*)::text AS n FROM pg_database WHERE datname = $1',
        [args.targetDb],
      );
      const exists = rows[0]?.n !== '0';
      if (args.intoExisting) {
        if (!exists) {
          throw new BackupError(
            `--into-existing was given but database "${args.targetDb}" does not exist.`,
          );
        }
        return;
      }
      await assertCanCreateDatabases(admin);
      await admin.query(`DROP DATABASE IF EXISTS ${quoteIdent(args.targetDb)} WITH (FORCE)`);
      await admin.query(`CREATE DATABASE ${quoteIdent(args.targetDb)}`);
      console.log(`Created throw-away database "${args.targetDb}".`);
    });
    created = true;

    await withClient(target, async (client) => {
      if (args.intoExisting) {
        await client.query(`DROP SCHEMA IF EXISTS ${quoteIdent(ACADEMY_SCHEMA)} CASCADE`);
        console.log(`Dropped the "${ACADEMY_SCHEMA}" schema in "${args.targetDb}".`);
      }
      // The dump covers the `academy` schema only, so citext (which lives in
      // public) has to exist before the restore. A drill that skipped this
      // step would hide a real one.
      await client.query('CREATE EXTENSION IF NOT EXISTS citext');

      // ---- b2. pg_restore ----------------------------------------------------
      console.log('Restoring the database with pg_restore ...');
      const result = await runPgTool(
        'pg_restore',
        ['--no-owner', '--no-privileges', ...pgArgs(target), dumpPath],
        { password: target.password },
      );
      const noise = result.stderr
        .split('\n')
        .map((l) => l.trim())
        .filter((l) => l !== '');
      const restoreOk = result.code === 0;
      add(
        'b2',
        'pg_restore completed without errors',
        restoreOk,
        restoreOk
          ? `exit 0, ${String(noise.length)} diagnostic line(s)`
          : `exit ${String(result.code)}: ${noise.slice(0, 4).join(' | ')}`,
      );
      if (!restoreOk) console.error(result.stderr.trim());

      // ---- b3. the media half ------------------------------------------------
      console.log(`Restoring the media into ${args.mediaDir} ...`);
      await mkdir(args.mediaDir, { recursive: true });
      if ((await listFiles(args.mediaDir)).length > 0) {
        throw new BackupError(
          `The throw-away media folder ${args.mediaDir} is not empty. Choose an empty folder.`,
        );
      }
      await copyMedia(backupMediaDir, args.mediaDir);
      const actual = await describeMedia(args.mediaDir);
      const media = compareMedia(manifest.media.files, actual);
      add(
        'b3',
        'Every media file is back with a matching sha256, and nothing extra',
        media.missing.length === 0 && media.corrupt.length === 0 && media.extra.length === 0,
        `${String(media.matched)}/${String(manifest.media.files.length)} files, ` +
          `${formatBytes(actual.reduce((n, f) => n + f.bytes, 0))}; missing ` +
          `${String(media.missing.length)}, checksum mismatch ${String(media.corrupt.length)}, ` +
          `unexpected ${String(media.extra.length)}` +
          (media.missing.length > 0 ? `; missing: ${media.missing.join(' ')}` : '') +
          (media.corrupt.length > 0 ? `; mismatch: ${media.corrupt.join(' ')}` : ''),
      );
      console.log(
        '\nMedia restored\n' +
          table(
            ['key', 'bytes', 'sha256 (16)', 'matches backup'],
            actual.map((f) => [
              f.key,
              f.bytes,
              f.sha256.slice(0, 16),
              manifest.media.files.some((m) => m.key === f.key && m.sha256 === f.sha256)
                ? 'yes'
                : 'NO',
            ]),
          ),
      );

      if (!restoreOk) return;

      // ---- v1/v2. tables and row counts --------------------------------------
      const counts = await countRows(client, await listAcademyTables(client));
      const listDiffs = compareTableList(manifest.database.tables, counts);
      add(
        'v1',
        'Restored schema has exactly the tables the backup held',
        listDiffs.length === 0,
        listDiffs.length === 0
          ? `${String(counts.length)} tables, same names`
          : listDiffs.map((d) => `${d.what}: ${d.actual}`).join(' '),
      );
      const countDiffs = compareRowCounts(manifest.database.tables, counts);
      add(
        'v2',
        'Row count matches the source for every academy table',
        countDiffs.length === 0,
        countDiffs.length === 0
          ? `${String(counts.length)} tables, ${String(counts.reduce((n, t) => n + t.rows, 0))} ` +
              'rows, zero differences'
          : countDiffs.map((d) => `${d.what} ${d.expected}->${d.actual}`).join(' '),
      );
      const interesting = counts.filter(
        (t) =>
          t.rows > 0 || (manifest.database.tables.find((m) => m.table === t.table)?.rows ?? 0) > 0,
      );
      console.log(
        '\nRows per table (non-empty)\n' +
          table(
            ['table', 'restored', 'in backup'],
            interesting.map((t) => [
              t.table,
              t.rows,
              manifest.database.tables.find((m) => m.table === t.table)?.rows ?? '(absent)',
            ]),
          ),
      );

      // ---- v3. content fingerprint --------------------------------------------
      const fp = await contentFingerprint(client);
      const fpDiffs = Object.entries(manifest.database.contentTables)
        .filter(([name, hash]) => fp.perTable[name] !== hash)
        .map(([name]) => name);
      add(
        'v3',
        'Content fingerprint matches the source (the hash verify-seed prints)',
        fp.overall === manifest.database.contentFingerprint,
        fp.overall === manifest.database.contentFingerprint
          ? `${fp.overall.slice(0, 16)} on both sides, ${String(Object.keys(fp.perTable).length)} content tables`
          : `restored ${fp.overall.slice(0, 16)} vs backup ` +
              `${manifest.database.contentFingerprint.slice(0, 16)}; differing: ${fpDiffs.join(' ')}`,
      );

      // ---- v4. schema version ---------------------------------------------------
      const { rows: migrations } = await client.query<{ filename: string }>(
        `SELECT filename FROM ${quoteIdent(ACADEMY_SCHEMA)}.schema_migrations ORDER BY filename`,
      );
      const last = migrations.at(-1)?.filename ?? null;
      add(
        'v4',
        'Schema version (last row of academy.schema_migrations) matches',
        last === manifest.database.schemaVersion &&
          migrations.length === manifest.database.migrationCount,
        `${last ?? '(none)'} / ${String(migrations.length)} migrations (backup: ` +
          `${manifest.database.schemaVersion ?? '(none)'} / ${String(manifest.database.migrationCount)})`,
      );

      // ---- v5. the two halves agree ---------------------------------------------
      const referenced = await referencedMediaKeys(client);
      const restoredKeys = new Set(actual.map((f) => f.key));
      const dangling = referenced.filter((r) => !restoredKeys.has(r.key));
      add(
        'v5',
        'Every media key the restored database points at exists in the restored media (D15)',
        dangling.length === 0,
        `${String(referenced.length - dangling.length)}/${String(referenced.length)} keys resolve` +
          (dangling.length > 0 ? `; missing: ${dangling.map((d) => d.key).join(' ')}` : ''),
      );

      // ---- v6. certificates still open -------------------------------------------
      const certs = await certificateKeys(client);
      if (certs.length === 0) {
        add(
          'v6',
          `Every certificate PDF still opens (starts with ${PDF_MAGIC})`,
          true,
          'N/A: this backup holds no certificates (0 rows in academy.certificates)',
        );
      } else {
        const bad: string[] = [];
        for (const key of certs) {
          const file = path.join(args.mediaDir, ...key.split('/'));
          if (!existsSync(file) || !looksLikePdf(await readHead(file))) bad.push(key);
        }
        add(
          'v6',
          `Every certificate PDF still opens (starts with ${PDF_MAGIC})`,
          bad.length === 0,
          `${String(certs.length - bad.length)}/${String(certs.length)} open` +
            (bad.length > 0 ? `; broken: ${bad.join(' ')}` : ''),
        );
      }
    });
  } finally {
    if (args.keep) {
      console.log(
        `\n--keep: leaving database "${args.targetDb}" and folder ${args.mediaDir} in place.`,
      );
    } else if (created) {
      try {
        if (args.intoExisting) {
          await withClient(target, async (client) => {
            await client.query(`DROP SCHEMA IF EXISTS ${quoteIdent(ACADEMY_SCHEMA)} CASCADE`);
          });
        } else {
          await withClient(maintenanceTarget(process.env), async (admin) => {
            // A plain DROP first: WITH (FORCE) terminates other sessions, which
            // needs rights an ordinary owner login does not have. By this point
            // our own connections are closed, so the plain drop normally works;
            // FORCE is the fallback for a stray session.
            try {
              await admin.query(`DROP DATABASE IF EXISTS ${quoteIdent(args.targetDb)}`);
            } catch {
              await admin.query(
                `DROP DATABASE IF EXISTS ${quoteIdent(args.targetDb)} WITH (FORCE)`,
              );
            }
          });
        }
        await rm(args.mediaDir, { recursive: true, force: true });
        console.log(
          `\nCleaned up: "${args.targetDb}" ` +
            (args.intoExisting ? `(schema "${ACADEMY_SCHEMA}" dropped)` : 'dropped') +
            ` and ${args.mediaDir} removed.`,
        );
      } catch (err) {
        console.warn(
          `restore-drill: could not finish cleaning up: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
  }

  return summarise(
    'restore-drill',
    'SECTION 10 go-live gate item 2 — restore drill (database AND media)',
    checks,
  );
}

runIfMain(import.meta.url, 'restore-drill', main);
