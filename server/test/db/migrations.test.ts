// Integration test: applies 0000-0011 to a THROW-AWAY database and checks the
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

/** Written out rather than inline so an escape cannot get lost in an edit. */
const NEWLINE = String.fromCharCode(10);
const ENGINE = 'faster-whisper:small';

describe.skipIf(!TEST_DB)('migrations 0000-0011 on a fresh database', () => {
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
      '0009_call_summary.sql',
      '0010_transcript_segments.sql',
      '0011_transcript_speaker.sql',
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

  it('adds the three summary columns to call_recordings, all nullable (0009)', async () => {
    const { rows } = await client.query<{
      column_name: string;
      is_nullable: string;
      column_default: string | null;
    }>(
      `SELECT column_name, is_nullable, column_default FROM information_schema.columns
        WHERE table_schema = 'academy' AND table_name = 'call_recordings'
          AND column_name IN ('summary', 'summary_model', 'summary_at')
        ORDER BY column_name`,
    );
    expect(rows.map((r) => r.column_name)).toEqual(['summary', 'summary_at', 'summary_model']);
    // "No summary yet" is the normal state of every recording, and for one that
    // will never be transcribed it is the only state there will ever be. A
    // DEFAULT on summary_at would make a row with no summary look like one.
    for (const row of rows) {
      expect(row.is_nullable, row.column_name).toBe('YES');
      expect(row.column_default, row.column_name).toBeNull();
    }
  });

  it('will not let a summary be stored without its model and its time (0009)', async () => {
    await client.query('BEGIN');
    try {
      const recording = await client.query<{ id: string }>(
        `INSERT INTO call_recordings (category, title, media_key, duration_secs)
         VALUES ('INDUCTION', 'Summary constraint check', 'academy/media/summary.mp3', 30)
         RETURNING id`,
      );
      const id = recording.rows[0]!.id;

      // Half a summary is refused: it could never be traced to what wrote it.
      // A blank one is refused too, so "there is a summary" can never mean an
      // empty string the API would then serve as the answer.
      for (const half of [
        "summary = 'A summary.'",
        "summary = 'A summary.', summary_model = 'a-model'",
        'summary_at = now()',
        "summary = '   ', summary_model = 'a-model', summary_at = now()",
      ]) {
        await client.query('SAVEPOINT half');
        await expect(
          client.query(`UPDATE call_recordings SET ${half} WHERE id = $1`, [id]),
        ).rejects.toThrow(/call_recordings_summary_complete/);
        await client.query('ROLLBACK TO SAVEPOINT half');
      }

      // All three together is accepted, and so is clearing all three again.
      await client.query(
        `UPDATE call_recordings
            SET summary = $2, summary_model = $3, summary_at = now() WHERE id = $1`,
        [id, 'A summary.', 'a-model'],
      );
      await client.query(
        `UPDATE call_recordings
            SET summary = NULL, summary_model = NULL, summary_at = NULL WHERE id = $1`,
        [id],
      );
    } finally {
      await client.query('ROLLBACK');
    }
  });

  it('leaves academy_app able to UPDATE call_recordings, which 0009 needs (0009)', async () => {
    const role = await client.query("SELECT 1 FROM pg_roles WHERE rolname = 'academy_app'");
    if (role.rowCount === 0) return; // role could not be created here
    const { rows } = await client.query<{ sel: boolean; upd: boolean }>(
      `SELECT has_table_privilege('academy_app', 'academy.call_recordings', 'SELECT') AS sel,
              has_table_privilege('academy_app', 'academy.call_recordings', 'UPDATE') AS upd`,
    );
    // Until 0009 the app only ever READ this table. Without the UPDATE the
    // button would call the model, spend the time, and fail on the save.
    expect(rows[0]).toEqual({ sel: true, upd: true });
  });

  it('adds the three transcript columns to call_recordings, all nullable (0010)', async () => {
    const { rows } = await client.query<{
      column_name: string;
      data_type: string;
      is_nullable: string;
      column_default: string | null;
    }>(
      `SELECT column_name, data_type, is_nullable, column_default
         FROM information_schema.columns
        WHERE table_schema = 'academy' AND table_name = 'call_recordings'
          AND column_name IN ('transcript_segments', 'transcript_engine', 'transcript_at')
        ORDER BY column_name`,
    );
    expect(rows.map((r) => r.column_name)).toEqual([
      'transcript_at',
      'transcript_engine',
      'transcript_segments',
    ]);
    // JSONB, not JSON: it is the type Postgres can look inside, which is what the
    // CHECK below needs and what a future search across transcripts would need.
    expect(rows.find((r) => r.column_name === 'transcript_segments')?.data_type).toBe('jsonb');
    // "Not transcribed yet" is the normal state of every recording today. A
    // DEFAULT on transcript_at would make a row with no transcript look like one.
    for (const row of rows) {
      expect(row.is_nullable, row.column_name).toBe('YES');
      expect(row.column_default, row.column_name).toBeNull();
    }
  });

  it('stores timed segments and reads them back as an array of objects (0010)', async () => {
    // The round trip that the panel under the player depends on: fractions of a
    // second survive, the order survives, and pg hands the value back as a real
    // JavaScript array rather than a string to parse.
    await client.query('BEGIN');
    try {
      const recording = await client.query<{ id: string }>(
        `INSERT INTO call_recordings (category, title, media_key, duration_secs)
         VALUES ('INDUCTION', 'Transcript round trip', 'academy/media/transcript.mp3', 30)
         RETURNING id`,
      );
      const id = recording.rows[0]!.id;

      // Invented lines between invented people: no real call, nothing from the
      // prototype.
      const segments = [
        { start: 0, end: 3.5, text: 'Good morning, this is Dana from the claims team.' },
        { start: 3.5, end: 5.25, text: 'Speaking.' },
        { start: 6, end: 9.75, text: 'I am calling about the questionnaire.' },
      ];
      await client.query(
        `UPDATE call_recordings
            SET transcript = $2,
                transcript_segments = $3::jsonb,
                transcript_engine = $4,
                transcript_at = now(),
                transcript_status = 'DONE'
          WHERE id = $1`,
        [id, segments.map((s) => s.text).join(NEWLINE), JSON.stringify(segments), ENGINE],
      );

      const { rows } = await client.query<{
        transcript: string;
        transcript_segments: unknown;
        transcript_engine: string;
        transcript_status: string;
        at_set: boolean;
      }>(
        `SELECT transcript, transcript_segments, transcript_engine, transcript_status,
                (transcript_at IS NOT NULL) AS at_set
           FROM call_recordings WHERE id = $1`,
        [id],
      );
      const row = rows[0]!;
      expect(row.transcript_segments).toEqual(segments);
      expect(Array.isArray(row.transcript_segments)).toBe(true);
      expect(row.transcript.split(NEWLINE)).toHaveLength(3);
      expect(row.transcript_engine).toBe(ENGINE);
      expect(row.transcript_status).toBe('DONE');
      expect(row.at_set).toBe(true);
    } finally {
      await client.query('ROLLBACK');
    }
  });

  it('stores a speaker on a line, and lets a line have none (0011)', async () => {
    // The speaker is a key INSIDE the existing array, not a column: it belongs to
    // a line, and it is written and replaced with the rest of the line. A line
    // with no speaker is a line nobody could attribute, and it must round-trip
    // as a line with no speaker rather than as one with a null.
    await client.query('BEGIN');
    try {
      const recording = await client.query<{ id: string }>(
        `INSERT INTO call_recordings (category, title, media_key, duration_secs)
         VALUES ('INDUCTION', 'Speaker round trip', 'academy/media/speakers.mp3', 12)
         RETURNING id`,
      );
      const id = recording.rows[0]!.id;
      const segments = [
        { start: 0, end: 3, text: 'One side of an invented call.', speaker: 'A' },
        { start: 3, end: 6, text: 'The other side.', speaker: 'B' },
        { start: 6, end: 9, text: 'Both at once, so nobody could tell.' },
      ];
      await client.query(
        `UPDATE call_recordings
            SET transcript = $2, transcript_segments = $3::jsonb,
                transcript_engine = $4, transcript_at = now(), transcript_status = 'DONE'
          WHERE id = $1`,
        [id, segments.map((s) => s.text).join(NEWLINE), JSON.stringify(segments), ENGINE],
      );
      const { rows } = await client.query<{ transcript_segments: unknown }>(
        'SELECT transcript_segments FROM call_recordings WHERE id = $1',
        [id],
      );
      expect(rows[0]!.transcript_segments).toEqual(segments);
      const third = (rows[0]!.transcript_segments as Record<string, unknown>[])[2]!;
      expect('speaker' in third).toBe(false);
    } finally {
      await client.query('ROLLBACK');
    }
  });

  it('describes the speaker in the column comment, so psql tells the truth (0011)', async () => {
    // The column's own description is the first thing somebody reads when they
    // come to this table with psql and no access to the repository. 0010 said
    // three keys; there are now four, and 0010 is not edited to say so because
    // the runner refuses a file whose sha256 has changed since it was applied.
    const { rows } = await client.query<{ comment: string | null }>(
      `SELECT col_description('academy.call_recordings'::regclass, a.attnum) AS comment
         FROM pg_attribute a
        WHERE a.attrelid = 'academy.call_recordings'::regclass
          AND a.attname = 'transcript_segments'`,
    );
    expect(rows[0]!.comment).toMatch(/speaker/i);
    expect(rows[0]!.comment).toMatch(/left channel/i);
  });

  it('refuses segments that are not an array, and segments with no transcript (0010)', async () => {
    await client.query('BEGIN');
    try {
      const recording = await client.query<{ id: string }>(
        `INSERT INTO call_recordings (category, title, media_key, duration_secs)
         VALUES ('INDUCTION', 'Transcript constraint check', 'academy/media/tc.mp3', 30)
         RETURNING id`,
      );
      const id = recording.rows[0]!.id;

      for (const half of [
        // Timings with no words: meaningless, and every reader in the codebase
        // asks "is there a transcript?" by looking at the TEXT.
        `transcript_segments = '[]'::jsonb`,
        // Not an array: the client iterates it, and a player is the last thing in
        // this app that may break.
        `transcript = 'Some words.', transcript_segments = '{"start": 0}'::jsonb`,
        `transcript = 'Some words.', transcript_segments = '"a line"'::jsonb`,
        `transcript = '   ', transcript_segments = '[]'::jsonb`,
      ]) {
        await client.query('SAVEPOINT half');
        await expect(
          client.query(`UPDATE call_recordings SET ${half} WHERE id = $1`, [id]),
        ).rejects.toThrow(/call_recordings_transcript_segments_shape/);
        await client.query('ROLLBACK TO SAVEPOINT half');
      }

      // Text with NO segments is legal on purpose: that is what a transcript
      // typed in by a person looks like, and the panel says it cannot follow
      // along rather than inventing times.
      await client.query(
        `UPDATE call_recordings SET transcript = 'Typed in by hand.' WHERE id = $1`,
        [id],
      );
      // An empty array beside real text is legal too — nothing was said.
      await client.query(
        `UPDATE call_recordings SET transcript_segments = '[]'::jsonb WHERE id = $1`,
        [id],
      );
    } finally {
      await client.query('ROLLBACK');
    }
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
    // 0000 through 0011: twelve files.
    expect(res.appliedBefore).toBe(12);
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
