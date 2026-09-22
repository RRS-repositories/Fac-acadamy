// Integration test: applies 0000-0002 to a THROW-AWAY database and checks the
// result. Runs only when MIGRATION_TEST_DB_NAME is set (CI and the local test
// database set it). It DROPS the academy schema in that database: never point
// it at anything that matters.
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parseEnv } from 'node:util';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { pgConfig, type DbSettings } from '../../src/db/connection.js';
import {
  MIGRATIONS_DIR,
  applyMigrations,
  readMigrationFiles,
  settingsFromEnv,
} from '../../src/db/migrate.js';

// Read the local .env without touching process.env (other test files share it).
function envWithDotenv(): NodeJS.ProcessEnv {
  const candidates = process.env.ENV_FILE
    ? [resolve(process.env.ENV_FILE)]
    : [resolve(process.cwd(), '.env'), resolve(process.cwd(), '..', '.env')];
  const file = candidates.find((f) => existsSync(f));
  const fromFile = file ? parseEnv(readFileSync(file, 'utf8')) : {};
  return { ...fromFile, ...process.env };
}

const env = envWithDotenv();
const TEST_DB = env.MIGRATION_TEST_DB_NAME?.trim() || '';

const NEW_TABLES_0002 = [
  'certificates',
  'departments',
  'dept_completions',
  'role_overrides',
  'status_guide',
  'trainee_mfa',
  'track_visibility',
  'tracks',
];

function tablesCreatedIn(filename: string): string[] {
  const sql = readFileSync(join(MIGRATIONS_DIR, filename), 'utf8');
  const names = [...sql.matchAll(/CREATE TABLE\s+(?:IF NOT EXISTS\s+)?academy\.(\w+)/gi)].map(
    (m) => m[1]!,
  );
  return [...new Set(names)].sort();
}

const quiet = () => undefined;

describe.skipIf(!TEST_DB)('migrations 0000-0002 on a fresh database', () => {
  let settings: DbSettings;
  let client: pg.Client;

  beforeAll(async () => {
    settings = { ...settingsFromEnv(env), DB_NAME: TEST_DB };
    client = new pg.Client(pgConfig(settings, { applicationName: 'academy-migrate-test' }));
    await client.connect();
    const { rows } = await client.query<{ db: string }>('SELECT current_database() AS db');
    expect(rows[0]?.db).toBe(TEST_DB);
    // Fresh start: the ledger lives in academy, so it goes too.
    await client.query('DROP SCHEMA IF EXISTS academy CASCADE');
    try {
      await client.query(`DO $$ BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'academy_app') THEN
          CREATE ROLE academy_app NOLOGIN;
        END IF; END $$`);
    } catch (err) {
      if ((err as { code?: string }).code !== '42501') throw err; // insufficient_privilege
    }
  });

  afterAll(async () => {
    await client?.end();
  });

  it('applies every pending migration with --commit', async () => {
    const res = await applyMigrations({ commit: true, expectDb: TEST_DB, settings, log: quiet });
    expect(res.appliedBefore).toBe(0);
    expect(res.applied).toEqual([
      '0000_extensions.sql',
      '0001_academy_schema.sql',
      '0002_academy_v2_alignment.sql',
    ]);
  });

  it('creates every table named in 0001 (19) and the 0002 tables', async () => {
    const from0001 = tablesCreatedIn('0001_academy_schema.sql');
    expect(from0001).toHaveLength(19);
    expect(tablesCreatedIn('0002_academy_v2_alignment.sql')).toEqual([...NEW_TABLES_0002].sort());
    const { rows } = await client.query<{ table_name: string }>(
      `SELECT table_name FROM information_schema.tables
       WHERE table_schema = 'academy' AND table_type = 'BASE TABLE'`,
    );
    const actual = rows.map((r) => r.table_name).sort();
    expect(actual).toEqual([...from0001, ...NEW_TABLES_0002, 'schema_migrations'].sort());
  });

  it('creates both views, and they run', async () => {
    const { rows } = await client.query<{ table_name: string }>(
      `SELECT table_name FROM information_schema.views WHERE table_schema = 'academy'
       ORDER BY table_name`,
    );
    expect(rows.map((r) => r.table_name)).toEqual(['v_stuck_trainees', 'v_trainee_overview']);
    await client.query('SELECT * FROM academy.v_trainee_overview');
    await client.query('SELECT * FROM academy.v_stuck_trainees');
  });

  it('seeds 9 tracks and 6 departments', async () => {
    const t = await client.query<{ n: string }>('SELECT count(*) AS n FROM academy.tracks');
    const d = await client.query<{ n: string }>('SELECT count(*) AS n FROM academy.departments');
    expect(Number(t.rows[0]?.n)).toBe(9);
    expect(Number(d.rows[0]?.n)).toBe(6);
  });

  it('compares CITEXT emails case-insensitively and accepts all 9 track codes', async () => {
    await client.query('BEGIN');
    try {
      await client.query(
        `INSERT INTO trainees (full_name, email, track) VALUES ('Trainee A', 'Trainee.A@Example.com', 'ADMIN')`,
      );
      const { rows } = await client.query<{ n: string }>(
        `SELECT count(*) AS n FROM trainees WHERE email = 'trainee.a@example.com'`,
      );
      expect(Number(rows[0]?.n)).toBe(1);
      await client.query('SAVEPOINT bad_track');
      await expect(
        client.query(
          `INSERT INTO trainees (full_name, email, track) VALUES ('Trainee B', 'trainee.b@example.com', 'NOPE')`,
        ),
      ).rejects.toMatchObject({ code: '23503' }); // foreign_key_violation
      await client.query('ROLLBACK TO SAVEPOINT bad_track');
      const stuck = await client.query('SELECT id FROM v_stuck_trainees');
      expect(stuck.rows).toHaveLength(0); // started just now, no fails
    } finally {
      await client.query('ROLLBACK');
    }
  });

  it('leaves audit_events and provisioning_events append-only for academy_app', async () => {
    const role = await client.query("SELECT 1 FROM pg_roles WHERE rolname = 'academy_app'");
    if (role.rowCount === 0) return; // role could not be created here
    const { rows } = await client.query<{ ins: boolean; upd: boolean; del: boolean }>(
      `SELECT has_table_privilege('academy_app', 'academy.audit_events', 'INSERT') AS ins,
              has_table_privilege('academy_app', 'academy.audit_events', 'UPDATE') AS upd,
              has_table_privilege('academy_app', 'academy.provisioning_events', 'DELETE') AS del`,
    );
    expect(rows[0]).toEqual({ ins: true, upd: false, del: false });
  });

  it('applies nothing on a second run', async () => {
    const res = await applyMigrations({ commit: true, expectDb: TEST_DB, settings, log: quiet });
    expect(res.applied).toEqual([]);
    expect(res.appliedBefore).toBe(3);
  });

  it('dry run on an up-to-date database lists 0 pending', async () => {
    const res = await applyMigrations({ commit: false, settings, log: quiet });
    expect(res.pending).toEqual([]);
  });

  it('refuses --commit with the wrong --expect-db', async () => {
    await expect(
      applyMigrations({ commit: true, expectDb: `${TEST_DB}_wrong`, settings, log: quiet }),
    ).rejects.toThrow(/Wrong database/);
  });

  it('fails when an applied file no longer matches its ledger hash', async () => {
    await client.query(
      `UPDATE academy.schema_migrations SET sha256 = repeat('0', 64)
       WHERE filename = '0001_academy_schema.sql'`,
    );
    try {
      await expect(applyMigrations({ commit: false, settings, log: quiet })).rejects.toThrow(
        /0001_academy_schema\.sql has changed/,
      );
    } finally {
      const real = (await readMigrationFiles()).find(
        (f) => f.filename === '0001_academy_schema.sql',
      );
      await client.query(
        `UPDATE academy.schema_migrations SET sha256 = $1 WHERE filename = '0001_academy_schema.sql'`,
        [real?.sha256],
      );
    }
  });
});
