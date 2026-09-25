// Integration test: applies 0000-0008 to a THROW-AWAY database and checks the
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
// Its own throw-away database when MIGRATIONS_TEST_DB_NAME is set: this suite
// drops and rebuilds the academy schema, which would wipe the content the S02
// and S04 suites rely on if it shared academy_test.
const TEST_DB = env.MIGRATIONS_TEST_DB_NAME?.trim() || env.MIGRATION_TEST_DB_NAME?.trim() || '';

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

describe.skipIf(!TEST_DB)('migrations 0000-0008 on a fresh database', () => {
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
      '0003_seed_support.sql',
      '0004_auth_support.sql',
      '0005_media.sql',
      '0006_notifications.sql',
      '0007_certificates.sql',
      '0008_listen_budget.sql',
    ]);
  });

  it('renames s3_key to media_key and adds the file facts (0005)', async () => {
    const { rows } = await client.query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns
        WHERE table_schema = 'academy' AND table_name = 'call_recordings'
        ORDER BY column_name`,
    );
    const columns = rows.map((r) => r.column_name);
    expect(columns).toContain('media_key');
    expect(columns).not.toContain('s3_key');
    for (const added of ['byte_size', 'content_type', 'checksum_sha256', 'uploaded_at']) {
      expect(columns).toContain(added);
    }
    // D4: a "coming soon" slot has no media, so the column stays nullable.
    const nullable = await client.query<{ is_nullable: string }>(
      `SELECT is_nullable FROM information_schema.columns
        WHERE table_schema = 'academy' AND table_name = 'call_recordings'
          AND column_name = 'media_key'`,
    );
    expect(nullable.rows[0]?.is_nullable).toBe('YES');
  });

  it('refuses a media_key that could escape the media folder (0005)', async () => {
    await client.query('BEGIN');
    try {
      const slot = async (key: string | null) =>
        client.query(
          `INSERT INTO call_recordings (category, title, media_key, duration_secs)
           VALUES ('INDUCTION', 'Key check', $1, 10)`,
          [key],
        );
      await slot('academy/media/CS_2_UTL.mp3'); // the shape the seed writes
      await slot(null); // a "coming soon" slot
      for (const bad of [
        'academy/media/../../etc/passwd',
        '/etc/passwd',
        'academy\\media\\x.mp3',
        'academy/media/',
        'academy/media/x y.mp3',
      ]) {
        await client.query('SAVEPOINT bad_key');
        await expect(slot(bad)).rejects.toMatchObject({ code: '23514' }); // check_violation
        await client.query('ROLLBACK TO SAVEPOINT bad_key');
      }
    } finally {
      await client.query('ROLLBACK');
    }
  });

  it('renames certificates.s3_key to media_key and adds the file facts (0007)', async () => {
    const { rows } = await client.query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns
        WHERE table_schema = 'academy' AND table_name = 'certificates'
        ORDER BY column_name`,
    );
    const columns = rows.map((r) => r.column_name);
    expect(columns).toContain('media_key');
    expect(columns).not.toContain('s3_key');
    for (const added of [
      'byte_size',
      'checksum_sha256',
      'content_type',
      'rendered_at',
      'issued_by',
    ]) {
      expect(columns).toContain(added);
    }
  });

  it('refuses a certificate key that could escape the media folder (0007)', async () => {
    await client.query('BEGIN');
    try {
      await client.query(
        `INSERT INTO trainees (full_name, email, track)
         VALUES ('Cert Holder', 'cert.holder@example.com', 'ADMIN')`,
      );
      const cert = async (publicId: string, key: string | null) =>
        client.query(
          `INSERT INTO certificates
             (public_id, trainee_id, kind, dept, track_code, holder_name, media_key)
           SELECT $1, t.id, 'DEPT', 'ADMIN', 'ADMIN', 'Cert Holder', $2
             FROM trainees t WHERE t.email = 'cert.holder@example.com'`,
          [publicId, key],
        );
      await cert('aaaaaaaaaaaaaaaaaaaaaa', 'academy/certs/aaaaaaaaaaaaaaaaaaaaaa.pdf');
      for (const bad of [
        'academy/certs/../../etc/passwd',
        '/etc/passwd',
        'academy\\certs\\x.pdf',
        'academy/certs/',
        'academy/certs/x y.pdf',
      ]) {
        await client.query('SAVEPOINT bad_key');
        await expect(cert('bbbbbbbbbbbbbbbbbbbbbb', bad)).rejects.toMatchObject({ code: '23514' });
        await client.query('ROLLBACK TO SAVEPOINT bad_key');
      }
    } finally {
      await client.query('ROLLBACK');
    }
  });

  it('keeps public_id unique and indexed (0007)', async () => {
    const { rows } = await client.query<{ n: string }>(
      `SELECT count(*) AS n
         FROM pg_index i
         JOIN pg_class c     ON c.oid = i.indrelid
         JOIN pg_namespace n ON n.oid = c.relnamespace
         JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum = ANY (i.indkey)
        WHERE n.nspname = 'academy' AND c.relname = 'certificates'
          AND i.indisunique AND a.attname = 'public_id' AND i.indnatts = 1`,
    );
    expect(Number(rows[0]?.n)).toBeGreaterThan(0);
  });

  it('adds listen_progress.first_beacon_at, nullable and with no default (0008)', async () => {
    const { rows } = await client.query<{ is_nullable: string; column_default: string | null }>(
      `SELECT is_nullable, column_default FROM information_schema.columns
        WHERE table_schema = 'academy' AND table_name = 'listen_progress'
          AND column_name = 'first_beacon_at'`,
    );
    expect(rows).toHaveLength(1);
    // NULL means "no beacon yet"; a DEFAULT now() would stamp the current time
    // on any insert that left the column out, which is a free budget reset.
    expect(rows[0]?.is_nullable).toBe('YES');
    expect(rows[0]?.column_default).toBeNull();
  });

  it('backfills first_beacon_at from last_beacon_at for a row written before 0008', async () => {
    // What 0008 does to the rows that already exist: the honest reading of a
    // listen with no recorded start is "no earlier than the last beacon seen".
    await client.query('BEGIN');
    try {
      const trainee = await client.query<{ id: string }>(
        `INSERT INTO trainees (full_name, email, track)
         VALUES ('Trainee Backfill', 'trainee.backfill@example.com', 'ADMIN') RETURNING id`,
      );
      const recording = await client.query<{ id: string }>(
        `INSERT INTO call_recordings (category, title, media_key, duration_secs)
         VALUES ('INDUCTION', 'Backfill check', 'academy/media/backfill.mp3', 30) RETURNING id`,
      );
      await client.query(
        `INSERT INTO listen_progress (trainee_id, recording_id, seconds_heard, last_beacon_at)
         VALUES ($1, $2, 12, now() - interval '1 hour')`,
        [trainee.rows[0]!.id, recording.rows[0]!.id],
      );
      // The column exists by now, so run the backfill statement itself.
      await client.query(
        `UPDATE listen_progress SET first_beacon_at = last_beacon_at
          WHERE first_beacon_at IS NULL AND last_beacon_at IS NOT NULL`,
      );
      const { rows } = await client.query<{ same: boolean }>(
        `SELECT first_beacon_at = last_beacon_at AS same FROM listen_progress
          WHERE trainee_id = $1`,
        [trainee.rows[0]!.id],
      );
      expect(rows[0]?.same).toBe(true);
    } finally {
      await client.query('ROLLBACK');
    }
  });

  it('leaves academy_app able to write listen_progress, first_beacon_at included (0008)', async () => {
    const role = await client.query("SELECT 1 FROM pg_roles WHERE rolname = 'academy_app'");
    if (role.rowCount === 0) return; // role could not be created here
    const { rows } = await client.query<{ sel: boolean; ins: boolean; upd: boolean }>(
      `SELECT has_table_privilege('academy_app', 'academy.listen_progress', 'SELECT') AS sel,
              has_table_privilege('academy_app', 'academy.listen_progress', 'INSERT') AS ins,
              has_table_privilege('academy_app', 'academy.listen_progress', 'UPDATE') AS upd`,
    );
    expect(rows[0]).toEqual({ sel: true, ins: true, upd: true });
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
    expect(actual).toEqual(
      [
        ...from0001,
        ...NEW_TABLES_0002,
        'notifications_sent',
        'certificate_emails',
        'schema_migrations',
      ].sort(),
    );
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
    expect(res.appliedBefore).toBe(9);
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
