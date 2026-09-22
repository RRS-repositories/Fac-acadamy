// Unit tests for the migration runner's helpers. No database needed.
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  MIGRATIONS_DIR,
  MigrationError,
  applyMigrations,
  lineAndColumn,
  parseCliArgs,
  readMigrationFiles,
  settingsFromEnv,
  sha256,
} from '../../src/db/migrate.js';

// sha256 of the supplied fac-academy-schema.sql. 0001 is never edited.
const SCHEMA_0001_SHA256 = '137bba44eaccfb0ab943557b5a61029228ca4826a3235b8c89b449aac4628443';

describe('parseCliArgs', () => {
  it('defaults to a dry run', () => {
    expect(parseCliArgs([])).toEqual({
      commit: false,
      expectDb: undefined,
      note: undefined,
      help: false,
    });
  });

  it('reads --commit, --expect-db and --note', () => {
    expect(parseCliArgs(['--commit', '--expect-db', 'academy_ci', '--note', 'S01'])).toEqual({
      commit: true,
      expectDb: 'academy_ci',
      note: 'S01',
      help: false,
    });
  });

  it('rejects unknown arguments', () => {
    expect(() => parseCliArgs(['--comit'])).toThrow(MigrationError);
    expect(() => parseCliArgs(['stray'])).toThrow(MigrationError);
  });
});

describe('settingsFromEnv', () => {
  const base = {
    DB_HOST: 'localhost',
    DB_PORT: '5432',
    DB_NAME: 'academy_x',
    DB_USER: 'academy_app',
    DB_PASSWORD: 'app-secret',
  };

  it('names the missing variables and never prints values', () => {
    let message = '';
    try {
      settingsFromEnv({ DB_PASSWORD: 'do-not-print' });
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).toMatch(/DB_HOST/);
    expect(message).toMatch(/DB_NAME/);
    expect(message).toMatch(/DB_USER/);
    expect(message).not.toMatch(/do-not-print/);
  });

  it('uses DB_USER / DB_PASSWORD when no override is set', () => {
    const s = settingsFromEnv(base);
    expect(s.DB_USER).toBe('academy_app');
    expect(s.DB_PASSWORD).toBe('app-secret');
  });

  it('lets MIGRATE_DB_USER / MIGRATE_DB_PASSWORD override them', () => {
    const s = settingsFromEnv({
      ...base,
      MIGRATE_DB_USER: 'academy_owner',
      MIGRATE_DB_PASSWORD: 'owner-secret',
    });
    expect(s.DB_USER).toBe('academy_owner');
    expect(s.DB_PASSWORD).toBe('owner-secret');
  });
});

describe('sha256', () => {
  it('hashes LF and CRLF copies the same', () => {
    expect(sha256('a\r\nb\r\n')).toBe(sha256('a\nb\n'));
    expect(sha256('a\nb\n')).not.toBe(sha256('a\nc\n'));
  });
});

describe('lineAndColumn', () => {
  it('maps a 1-based Postgres position to line and column', () => {
    const sql = 'SELECT 1;\nSELEC 2;\n';
    expect(lineAndColumn(sql, 1)).toEqual({ line: 1, column: 1 });
    expect(lineAndColumn(sql, 11)).toEqual({ line: 2, column: 1 });
    expect(lineAndColumn(sql, 13)).toEqual({ line: 2, column: 3 });
  });
});

describe('readMigrationFiles', () => {
  let dir = '';
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'academy-migrate-'));
  });
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('sorts by name and ignores files that are not NNNN_name.sql', async () => {
    await writeFile(join(dir, '0010_later.sql'), 'SELECT 10;');
    await writeFile(join(dir, '0002_second.sql'), 'SELECT 2;');
    await writeFile(join(dir, '0001_first.sql'), 'SELECT 1;');
    await writeFile(join(dir, 'README.md'), '# not a migration');
    await writeFile(join(dir, '3_bad_name.sql'), 'SELECT 3;');
    const files = await readMigrationFiles(dir);
    expect(files.map((f) => f.filename)).toEqual([
      '0001_first.sql',
      '0002_second.sql',
      '0010_later.sql',
    ]);
    expect(files[0]?.sha256).toBe(sha256('SELECT 1;'));
  });

  it('refuses two files with the same number', async () => {
    await writeFile(join(dir, '0002_clash.sql'), 'SELECT 2;');
    await expect(readMigrationFiles(dir)).rejects.toThrow(/share number 0002/);
  });

  it('finds 0000-0002 in the real folder, with 0001 unchanged', async () => {
    const files = await readMigrationFiles(MIGRATIONS_DIR);
    const names = files.map((f) => f.filename);
    expect(names.slice(0, 3)).toEqual([
      '0000_extensions.sql',
      '0001_academy_schema.sql',
      '0002_academy_v2_alignment.sql',
    ]);
    expect(files[1]?.sha256).toBe(SCHEMA_0001_SHA256);
  });
});

describe('applyMigrations guard', () => {
  it('refuses --commit without --expect-db before connecting', async () => {
    await expect(applyMigrations({ commit: true, log: () => undefined })).rejects.toThrow(
      /--expect-db/,
    );
  });
});
