// Unit tests for the backup tools (ops/backup/). No database, no pg_dump and
// no real recording: every fixture here is invented — a few tiny text files
// standing in for media, and a hand-written manifest.
//
// What they pin down:
//   * the guards (nothing inside the repo, nothing but a clearly throw-away
//     restore target, never a production-looking database name);
//   * the manifest round-trip and the comparisons the drill's verdict is
//     built from.
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { copyMedia, parseBackupArgs } from '../backup/backup.js';
import {
  BackupError,
  REPO_ROOT,
  assertOutsideRepo,
  assertThrowAwayTarget,
  backupStamp,
  formatBytes,
  isInside,
  isThrowAwayDbName,
  listFiles,
  looksLikeProduction,
  pgArgs,
  pgToolPath,
  quoteIdent,
  sha256OfFile,
} from '../backup/lib.js';
import {
  compareMedia,
  compareRowCounts,
  compareTableList,
  looksLikePdf,
  readManifest,
  writeManifest,
} from '../backup/manifest.js';
import type { Manifest } from '../backup/manifest.js';
import { describeMedia, findLatestBackup, parseRestoreDrillArgs } from '../backup/restore-drill.js';

const temps: string[] = [];
async function tempDir(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), 'academy-backup-test-'));
  temps.push(dir);
  return dir;
}

afterAll(async () => {
  for (const dir of temps) await rm(dir, { recursive: true, force: true });
});

function sha256(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

/** A believable manifest for two invented files and one invented table. */
function fixtureManifest(overrides: Partial<Manifest> = {}): Manifest {
  return {
    manifestVersion: 1,
    tool: 'ops/backup/backup.ts',
    startedAt: '2026-09-23T00:00:00.000Z',
    finishedAt: '2026-09-23T00:00:05.000Z',
    database: {
      name: 'academy_dev',
      host: 'db.invalid',
      port: 5432,
      user: 'academy_owner',
      schema: 'academy',
      serverVersion: '18.3',
      schemaVersion: '0007_certificates.sql',
      schemaVersionAppliedAt: '2026-09-23T00:00:00.000Z',
      migrationCount: 8,
      dumpFile: 'database/academy.dump',
      dumpBytes: 3,
      dumpSha256: sha256('abc'),
      tables: [
        { table: 'stages', rows: 28 },
        { table: 'lessons', rows: 66 },
      ],
      contentFingerprint: sha256('content'),
      contentTables: { stages: sha256('stages'), lessons: sha256('lessons') },
    },
    media: {
      root: '/srv/academy-media',
      dir: 'media',
      fileCount: 1,
      totalBytes: 5,
      files: [{ key: 'academy/media/one.mp3', bytes: 5, sha256: sha256('hello') }],
    },
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Guard: nothing is ever written inside the repo
// ---------------------------------------------------------------------------

describe('the outside-the-repo guard', () => {
  it('refuses a path inside the repo', () => {
    expect(() => assertOutsideRepo(path.join(REPO_ROOT, 'backups'))).toThrow(BackupError);
    expect(() => assertOutsideRepo(path.join(REPO_ROOT, 'ops', 'backup', 'out'))).toThrow(
      /inside the repo/,
    );
    expect(() => assertOutsideRepo(REPO_ROOT)).toThrow(/inside the repo/);
  });

  it('accepts a path outside the repo and returns it absolute', () => {
    const outside = path.join(tmpdir(), 'academy-backups');
    expect(assertOutsideRepo(outside)).toBe(path.resolve(outside));
  });

  it('isInside is case-insensitive where the filesystem is', () => {
    expect(isInside(path.join(REPO_ROOT, 'ops'), REPO_ROOT)).toBe(true);
    expect(isInside(REPO_ROOT, path.join(REPO_ROOT, 'ops'))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Guard: only a clearly throw-away restore target
// ---------------------------------------------------------------------------

describe('the throw-away restore target guard', () => {
  it('accepts a name that says it is disposable', () => {
    expect(isThrowAwayDbName('academy_restore_drill')).toBe(true);
    expect(isThrowAwayDbName('drill_copy')).toBe(true);
    expect(isThrowAwayDbName('academy_scratch')).toBe(true);
  });

  it('refuses a working database, however local it looks', () => {
    expect(isThrowAwayDbName('academy_dev')).toBe(false);
    expect(isThrowAwayDbName('academy_test')).toBe(false);
    expect(isThrowAwayDbName('crm')).toBe(false);
    expect(isThrowAwayDbName('')).toBe(false);
  });

  it('refuses a production-looking name even when it also says drill', () => {
    expect(looksLikeProduction('academy_prod')).toBe(true);
    expect(looksLikeProduction('crm_live')).toBe(true);
    expect(isThrowAwayDbName('prod_restore_drill')).toBe(false);
    expect(isThrowAwayDbName('live_drill')).toBe(false);
    expect(() => assertThrowAwayTarget('academy_prod_drill', {})).toThrow(BackupError);
  });

  it('refuses anything that is not a plain Postgres identifier', () => {
    expect(() => assertThrowAwayTarget('drill; DROP DATABASE academy_dev', {})).toThrow(
      /plain lower-case Postgres name/,
    );
    expect(() => assertThrowAwayTarget('Drill"Copy', {})).toThrow(BackupError);
  });

  it('refuses the database the backup came from, and the one the app uses', () => {
    expect(() =>
      assertThrowAwayTarget('academy_restore_drill', { sourceDb: 'academy_restore_drill' }),
    ).toThrow(/taken from/);
    expect(() =>
      assertThrowAwayTarget('academy_restore_drill', { appDb: 'ACADEMY_RESTORE_DRILL' }),
    ).toThrow(/the application uses/);
  });

  it('accepts a *_test database only when restoring into an existing one', () => {
    expect(isThrowAwayDbName('academy_migrations_test')).toBe(false);
    expect(isThrowAwayDbName('academy_migrations_test', { intoExisting: true })).toBe(true);
    expect(assertThrowAwayTarget('academy_migrations_test', { intoExisting: true })).toBe(
      'academy_migrations_test',
    );
  });

  it('quotes identifiers safely', () => {
    expect(quoteIdent('academy')).toBe('"academy"');
    expect(quoteIdent('a"b')).toBe('"a""b"');
  });
});

// ---------------------------------------------------------------------------
// Arguments
// ---------------------------------------------------------------------------

describe('backup arguments', () => {
  const env = { MEDIA_ROOT: path.join(tmpdir(), 'media') } as NodeJS.ProcessEnv;

  it('requires --out', () => {
    expect(() => parseBackupArgs([], env)).toThrow(/--out/);
  });

  it('refuses an --out inside the repo', () => {
    expect(() => parseBackupArgs(['--out', path.join(REPO_ROOT, 'backups')], env)).toThrow(
      /inside the repo/,
    );
  });

  it('refuses to run with no media folder: the media is half the backup', () => {
    expect(() => parseBackupArgs(['--out', tmpdir()], {} as NodeJS.ProcessEnv)).toThrow(
      /MEDIA_ROOT/,
    );
  });

  it('takes the media folder from --media-root or MEDIA_ROOT', () => {
    const fromFlag = parseBackupArgs(['--out', tmpdir(), '--media-root', '/srv/media'], {});
    expect(fromFlag).not.toBe('help');
    if (fromFlag !== 'help') expect(fromFlag.mediaRoot).toBe(path.resolve('/srv/media'));
    const fromEnv = parseBackupArgs(['--out', tmpdir()], env);
    if (fromEnv !== 'help') expect(fromEnv.mediaRoot).toBe(path.resolve(env['MEDIA_ROOT'] ?? ''));
  });
});

describe('restore-drill arguments', () => {
  const env = { DB_NAME: 'academy_dev', MEDIA_ROOT: path.join(tmpdir(), 'live-media') };

  it('requires --from', () => {
    expect(() => parseRestoreDrillArgs([], env)).toThrow(/--from/);
  });

  it('defaults to a throw-away database and a throw-away media folder', () => {
    const args = parseRestoreDrillArgs(['--from', tmpdir()], env);
    expect(args).not.toBe('help');
    if (args === 'help') return;
    expect(args.targetDb).toBe('academy_restore_drill');
    expect(args.mediaDir.startsWith(path.resolve(tmpdir()))).toBe(true);
    expect(args.keep).toBe(false);
  });

  it('refuses a restore target that is not throw-away', () => {
    expect(() =>
      parseRestoreDrillArgs(['--from', tmpdir(), '--target-db', 'academy_dev'], env),
    ).toThrow(/disposable/);
  });

  it('refuses --into-existing without the explicit --drop-schema confirmation', () => {
    expect(() =>
      parseRestoreDrillArgs(
        ['--from', tmpdir(), '--target-db', 'academy_scratch', '--into-existing'],
        env,
      ),
    ).toThrow(/--drop-schema/);
  });

  it('refuses to restore the media into the repo or over the live MEDIA_ROOT', () => {
    expect(() =>
      parseRestoreDrillArgs(
        ['--from', tmpdir(), '--media-dir', path.join(REPO_ROOT, '.media-restore')],
        env,
      ),
    ).toThrow(/inside the repo/);
    expect(() =>
      parseRestoreDrillArgs(['--from', tmpdir(), '--media-dir', env.MEDIA_ROOT], env),
    ).toThrow(/MEDIA_ROOT/);
    expect(() =>
      parseRestoreDrillArgs(
        ['--from', tmpdir(), '--media-dir', path.join(env.MEDIA_ROOT, 'inner')],
        env,
      ),
    ).toThrow(/MEDIA_ROOT/);
  });
});

// ---------------------------------------------------------------------------
// Postgres tool plumbing
// ---------------------------------------------------------------------------

describe('the Postgres command line', () => {
  it('finds the tools through PG_BIN or an explicit override, never a hard-coded path', () => {
    expect(pgToolPath('pg_dump', {})).toBe('pg_dump');
    expect(pgToolPath('pg_dump', { PG_BIN: '/opt/pg/bin' })).toBe(
      path.join('/opt/pg/bin', process.platform === 'win32' ? 'pg_dump.exe' : 'pg_dump'),
    );
    expect(pgToolPath('pg_restore', { ACADEMY_PG_RESTORE: '/usr/bin/pg_restore17' })).toBe(
      '/usr/bin/pg_restore17',
    );
  });

  it('never puts the password on the command line', () => {
    const args = pgArgs({
      host: 'db.invalid',
      port: 5432,
      database: 'academy_dev',
      user: 'academy_owner',
      password: 'correct-horse-battery-staple',
      ssl: false,
    });
    expect(args.join(' ')).not.toContain('correct-horse');
    expect(args).toContain('--no-password');
  });
});

// ---------------------------------------------------------------------------
// The manifest and the comparisons the verdict is built from
// ---------------------------------------------------------------------------

describe('the manifest', () => {
  it('survives a write/read round trip', async () => {
    const dir = await tempDir();
    const file = path.join(dir, 'manifest.json');
    const manifest = fixtureManifest();
    await writeManifest(file, manifest);
    await expect(readManifest(file)).resolves.toStrictEqual(manifest);
  });

  it('refuses a manifest that is missing or malformed', async () => {
    const dir = await tempDir();
    await expect(readManifest(path.join(dir, 'nothing.json'))).rejects.toThrow(/not a backup/);
    const broken = path.join(dir, 'broken.json');
    await writeFile(broken, '{ "manifestVersion": 1 }', 'utf8');
    await expect(readManifest(broken)).rejects.toThrow(/expected shape/);
  });
});

describe('comparing a restore with the manifest', () => {
  const expected = fixtureManifest().database.tables;

  it('passes when the tables and the counts are identical', () => {
    expect(compareTableList(expected, [...expected])).toStrictEqual([]);
    expect(compareRowCounts(expected, [...expected])).toStrictEqual([]);
  });

  it('names a table that did not come back, and one that should not be there', () => {
    const actual = [
      { table: 'stages', rows: 28 },
      { table: 'surprise', rows: 1 },
    ];
    expect(compareTableList(expected, actual)).toStrictEqual([
      { what: 'lessons', expected: 'present', actual: 'MISSING' },
      { what: 'surprise', expected: 'absent', actual: 'UNEXPECTED' },
    ]);
  });

  it('names every table whose row count moved', () => {
    const actual = [
      { table: 'stages', rows: 28 },
      { table: 'lessons', rows: 65 },
    ];
    expect(compareRowCounts(expected, actual)).toStrictEqual([
      { what: 'lessons', expected: '66', actual: '65' },
    ]);
  });
});

describe('comparing the restored media', () => {
  const files = [
    { key: 'a.mp3', bytes: 3, sha256: sha256('aaa') },
    { key: 'b.mp3', bytes: 3, sha256: sha256('bbb') },
  ];

  it('passes when every file is back with the same checksum', () => {
    expect(compareMedia(files, [...files])).toStrictEqual({
      missing: [],
      corrupt: [],
      extra: [],
      matched: 2,
    });
  });

  it('catches a missing file, a changed file and a stray one', () => {
    const actual = [
      { key: 'b.mp3', bytes: 3, sha256: sha256('BBB') },
      { key: 'c.mp3', bytes: 1, sha256: sha256('c') },
    ];
    expect(compareMedia(files, actual)).toStrictEqual({
      missing: ['a.mp3'],
      corrupt: ['b.mp3'],
      extra: ['c.mp3'],
      matched: 0,
    });
  });

  it('knows a PDF from anything else', () => {
    expect(looksLikePdf(Buffer.from('%PDF-1.7\n'))).toBe(true);
    expect(looksLikePdf(Buffer.from('not a pdf'))).toBe(false);
    expect(looksLikePdf(Buffer.alloc(0))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Copying and describing files (invented content only)
// ---------------------------------------------------------------------------

describe('copying the media half', () => {
  it('copies every file, keeps the layout and records a matching sha256', async () => {
    const source = await tempDir();
    const destination = await tempDir();
    await mkdir(path.join(source, 'academy', 'media'), { recursive: true });
    await writeFile(path.join(source, 'academy', 'media', 'one.txt'), 'hello', 'utf8');
    await writeFile(path.join(source, 'academy', 'media', 'two.txt'), 'world', 'utf8');

    const entries = await copyMedia(source, destination);
    expect(entries.map((e) => e.key)).toStrictEqual([
      'academy/media/one.txt',
      'academy/media/two.txt',
    ]);
    expect(entries[0]?.sha256).toBe(sha256('hello'));
    expect(await listFiles(destination)).toStrictEqual(entries.map((e) => e.key));

    // An independent re-scan of the copy must agree with what copyMedia said.
    await expect(describeMedia(destination)).resolves.toStrictEqual(entries);
    await expect(sha256OfFile(path.join(destination, 'academy', 'media', 'two.txt'))).resolves.toBe(
      sha256('world'),
    );
  });

  it('reports a missing folder as no files rather than throwing', async () => {
    await expect(listFiles(path.join(tmpdir(), 'academy-not-here-at-all'))).resolves.toStrictEqual(
      [],
    );
  });
});

describe('finding the newest backup', () => {
  it('takes the folder itself when it holds a manifest', async () => {
    const dir = await tempDir();
    await writeManifest(path.join(dir, 'manifest.json'), fixtureManifest());
    await expect(findLatestBackup(dir)).resolves.toBe(dir);
  });

  it('otherwise takes the newest academy-backup-* folder that has one', async () => {
    const root = await tempDir();
    for (const stamp of ['20260101-000000', '20260923-141408', '20260501-120000']) {
      const dir = path.join(root, `academy-backup-${stamp}`);
      await mkdir(dir, { recursive: true });
      await writeManifest(path.join(dir, 'manifest.json'), fixtureManifest());
    }
    // A half-written folder with no manifest is ignored, not chosen.
    await mkdir(path.join(root, 'academy-backup-20261231-000000'), { recursive: true });
    await expect(findLatestBackup(root)).resolves.toBe(
      path.join(root, 'academy-backup-20260923-141408'),
    );
  });

  it('says so when there is no backup at all', async () => {
    const root = await tempDir();
    await expect(findLatestBackup(root)).rejects.toThrow(/No backup found/);
  });
});

describe('small helpers', () => {
  it('stamps a folder name that sorts and is legal on every platform', () => {
    expect(backupStamp(new Date('2026-09-23T14:14:08.000Z'))).toBe('20260923-141408');
    expect(backupStamp(new Date('2026-01-02T03:04:05.000Z'))).toBe('20260102-030405');
  });

  it('formats bytes for a human', () => {
    expect(formatBytes(512)).toBe('512 B');
    expect(formatBytes(1024)).toBe('1.0 KB');
    expect(formatBytes(35 * 1024 * 1024)).toBe('35.0 MB');
  });
});
