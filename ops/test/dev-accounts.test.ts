// The LOCAL-ONLY developer scripts (ops/dev/). Argument parsing, the
// production guard and the gate rule run everywhere (no database). The database
// tests run only when MIGRATION_TEST_DB_NAME is set (the throw-away test
// database, migrated to 0004). They connect with the app's own settings
// (DB_USER, normally academy_app), so they also prove the app role has the
// rights these scripts need. Every database test runs in a transaction that is
// rolled back, so nothing is left behind.
// Names and emails are invented.
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseEnv } from 'node:util';
import pg from 'pg';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { DbSettingsSchema, pgConfig } from '../../server/src/db/connection.js';
import {
  DEV_ACCOUNTS,
  DEV_TRACKS,
  DEV_TRACK_ACCOUNTS,
  DevError,
  MANAGER_CRM_USER_ID,
  connectDev,
  isLocalDbName,
  parseBaseUrl,
  parseExpectDb,
} from '../dev/lib.js';
import {
  PROGRESS_TABLES,
  clearProgress,
  parseSeedTestAccountsArgs,
  seedTestAccounts,
} from '../dev/seed-test-accounts.js';
import {
  DEFAULT_BASE_URL,
  loadTrackFixture,
  parseTrackSweepArgs,
  readSweepData,
  stageStates,
} from '../dev/track-sweep.js';

describe('ops/dev account list', () => {
  it('is one invented @example.com trainee per track plus one manager', () => {
    expect(DEV_ACCOUNTS).toHaveLength(10);
    expect(DEV_TRACK_ACCOUNTS).toHaveLength(9);
    expect(DEV_TRACK_ACCOUNTS.map((a) => a.track)).toEqual([...DEV_TRACKS]);
    expect(DEV_TRACK_ACCOUNTS.map((a) => a.email)).toEqual([
      'track.full@example.com',
      'track.cs@example.com',
      'track.sales@example.com',
      'track.admin@example.com',
      'track.fos@example.com',
      'track.mgmt@example.com',
      'track.pay@example.com',
      'track.it@example.com',
      'track.debt@example.com',
    ]);
    expect(DEV_ACCOUNTS.every((a) => a.email.endsWith('@example.com'))).toBe(true);
    expect(new Set(DEV_ACCOUNTS.map((a) => a.email)).size).toBe(DEV_ACCOUNTS.length);
    // Only the manager carries a (reserved, local-only) CRM user id.
    expect(DEV_TRACK_ACCOUNTS.every((a) => a.crmUserId === null)).toBe(true);
    const manager = DEV_ACCOUNTS.find((a) => a.role === 'MANAGER');
    expect(manager).toMatchObject({
      email: 'manager.test@example.com',
      track: 'MGMT',
      crmUserId: MANAGER_CRM_USER_ID,
    });
  });
});

describe('the production guard', () => {
  it('accepts only names that clearly belong to a local or throw-away database', () => {
    for (const name of ['academy_dev', 'academy_test', 'ACADEMY_DEV', 'fac_dev_2', 'devdb']) {
      expect(isLocalDbName(name)).toBe(true);
    }
    for (const name of [
      'crm_production',
      'production',
      'academy',
      'crm',
      'postgres',
      'academy_live',
      'academy_prod',
      'prod_test', // 'prod' wins: a name may not say both
      'dev_production',
      '',
      '   ',
    ]) {
      expect(isLocalDbName(name)).toBe(false);
    }
  });

  it('parseExpectDb refuses a production name and requires the flag', () => {
    expect(parseExpectDb(' academy_dev ')).toBe('academy_dev');
    expect(() => parseExpectDb('crm_production')).toThrow(DevError);
    expect(() => parseExpectDb('crm_production')).toThrow(/local only/);
    expect(() => parseExpectDb(undefined)).toThrow(/--expect-db/);
    expect(() => parseExpectDb('   ')).toThrow(/--expect-db/);
  });

  it('connectDev refuses a production name before it opens a connection', async () => {
    await expect(connectDev('crm_production', 'test')).rejects.toThrow(/local only/);
  });

  it('connectDev refuses a local name that is not the configured DB_NAME', async () => {
    // Guard 2: --expect-db must equal DB_NAME (and then current_database()).
    await expect(connectDev('some_other_dev_database', 'test')).rejects.toThrow(/DB_NAME is/);
  });
});

describe('seed-test-accounts argument parsing', () => {
  it('parses the full command line', () => {
    expect(parseSeedTestAccountsArgs(['--expect-db', 'academy_test', '--reset'])).toEqual({
      expectDb: 'academy_test',
      reset: true,
    });
    expect(parseSeedTestAccountsArgs(['--expect-db', 'academy_dev'])).toEqual({
      expectDb: 'academy_dev',
      reset: false,
    });
    expect(parseSeedTestAccountsArgs(['--help'])).toBe('help');
  });

  it('refuses a missing or production --expect-db, unknown options and positionals', () => {
    expect(() => parseSeedTestAccountsArgs([])).toThrow(/--expect-db/);
    expect(() => parseSeedTestAccountsArgs(['--expect-db', 'crm_production'])).toThrow(DevError);
    expect(() => parseSeedTestAccountsArgs(['--expect-db', 'academy_dev', '--force'])).toThrow();
    expect(() => parseSeedTestAccountsArgs(['--expect-db', 'academy_dev', 'extra'])).toThrow();
  });
});

describe('track-sweep argument parsing', () => {
  it('defaults the base URL and normalises the one given', () => {
    expect(parseTrackSweepArgs(['--expect-db', 'academy_dev'])).toEqual({
      expectDb: 'academy_dev',
      baseUrl: DEFAULT_BASE_URL,
    });
    expect(
      parseTrackSweepArgs(['--expect-db', 'academy_dev', '--base-url', 'http://127.0.0.1:4100/']),
    ).toEqual({ expectDb: 'academy_dev', baseUrl: 'http://127.0.0.1:4100' });
    expect(parseTrackSweepArgs(['--help'])).toBe('help');
  });

  it('refuses a bad base URL, a production database and unknown options', () => {
    expect(() => parseBaseUrl('not a url', DEFAULT_BASE_URL)).toThrow(/not a URL/);
    expect(() => parseBaseUrl('ftp://localhost', DEFAULT_BASE_URL)).toThrow(/http or https/);
    expect(parseBaseUrl(undefined, DEFAULT_BASE_URL)).toBe(DEFAULT_BASE_URL);
    expect(() => parseTrackSweepArgs(['--expect-db', 'crm_production'])).toThrow(DevError);
    expect(() => parseTrackSweepArgs(['--expect-db', 'academy_dev', '--verbose'])).toThrow();
  });
});

describe('the gate rule (same rule the server gate uses)', () => {
  const visible = ['a', 'b', 'c', 'd'].map((code, i) => ({
    position: i + 1,
    stageId: String(i + 1),
    code,
  }));

  it('a fresh account has exactly one available stage and the rest locked', () => {
    const states = stageStates(visible, new Set());
    expect(states).toEqual(['available', 'locked', 'locked', 'locked']);
    expect(states.filter((s) => s === 'available')).toHaveLength(1);
  });

  it('completing a stage unlocks exactly the next one in the visible list', () => {
    expect(stageStates(visible, new Set(['1']))).toEqual(['done', 'available', 'locked', 'locked']);
    expect(stageStates(visible, new Set(['1', '2']))).toEqual([
      'done',
      'done',
      'available',
      'locked',
    ]);
  });

  it('a completion out of order never unlocks anything before it', () => {
    // Someone with only stage 3 done: 1 is available (it is first), 2 stays
    // locked, 3 is done, and 4 unlocks because its predecessor is done.
    expect(stageStates(visible, new Set(['3']))).toEqual([
      'available',
      'locked',
      'done',
      'available',
    ]);
  });

  it('an empty visible list (no track assigned) has nothing available', () => {
    expect(stageStates([], new Set())).toEqual([]);
  });
});

describe('the §1 fixture the sweep compares against', () => {
  it('has a stage list and a question total for all 9 tracks', () => {
    const fixture = loadTrackFixture();
    expect(Object.keys(fixture.stages).sort()).toEqual([...DEV_TRACKS].sort());
    for (const t of DEV_TRACKS) {
      expect(fixture.stages[t].length).toBeGreaterThan(0);
      expect(fixture.questionsPerTrack[t]).toBeGreaterThan(0);
    }
  });
});

// ---------------------------------------------------------------------------
// Database tests
// ---------------------------------------------------------------------------

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

describe.skipIf(!TEST_DB)('seed-test-accounts against the test database', () => {
  let client: pg.Client;
  let hasContent = false;

  beforeAll(async () => {
    const settings = DbSettingsSchema.parse({ ...env, DB_NAME: TEST_DB });
    client = new pg.Client(pgConfig(settings, { applicationName: 'academy-dev-accounts-test' }));
    await client.connect();
    const { rows } = await client.query<{ db: string }>('SELECT current_database() AS db');
    expect(rows[0]?.db).toBe(TEST_DB);
    const content = await client.query<{ n: string }>(
      'SELECT count(*)::text AS n FROM academy.lessons',
    );
    hasContent = Number(content.rows[0]?.n ?? '0') > 0;
  });

  afterAll(async () => {
    await client?.end();
  });

  // Every test starts from a known slate INSIDE its transaction, so it does not
  // matter whether someone has already run the script against this database.
  // Tables that reference academy.trainees and that academy_app may delete from.
  // audit_events and provisioning_events are append-only for this role (no
  // DELETE grant) and these accounts never get rows there; if one ever did, the
  // DELETE on trainees below would fail loudly rather than hide it.
  const CHILD_TABLES = [
    'certificates',
    'dept_completions',
    'lesson_progress',
    'level_completions',
    'listen_progress',
    'progression_authorisations',
    'provisioning_requests',
    'quiz_attempts',
    'sessions',
    'stage_completions',
    'trainee_mfa',
  ] as const;

  async function removeDevAccounts(): Promise<void> {
    const emails = [DEV_ACCOUNTS.map((a) => a.email)];
    const ids = `SELECT id FROM academy.trainees WHERE email = ANY($1::citext[])`;
    await client.query(
      `DELETE FROM academy.attempt_answers
        WHERE attempt_id IN (SELECT id FROM academy.quiz_attempts WHERE trainee_id IN (${ids}))`,
      emails,
    );
    for (const t of CHILD_TABLES) {
      await client.query(`DELETE FROM academy.${t} WHERE trainee_id IN (${ids})`, emails);
    }
    await client.query('DELETE FROM academy.trainees WHERE email = ANY($1::citext[])', emails);
    await client.query('DELETE FROM academy.role_overrides WHERE crm_user_id = $1', [
      MANAGER_CRM_USER_ID,
    ]);
  }

  beforeEach(async () => {
    await client.query('BEGIN');
    await removeDevAccounts();
  });

  afterEach(async () => {
    await client.query('ROLLBACK');
  });

  it('creates one ACTIVE trainee per track plus the manager', async () => {
    const res = await seedTestAccounts(client, { reset: false });
    expect(res.accounts).toHaveLength(10);
    expect(res.cleared).toBeNull();
    expect(res.accounts.every((a) => a.created)).toBe(true);
    expect(new Set(res.accounts.map((a) => a.traineeId)).size).toBe(10);

    const { rows } = await client.query<{ email: string; track: string; status: string }>(
      `SELECT email::text AS email, track, status FROM academy.trainees
        WHERE email = ANY($1::citext[]) ORDER BY id`,
      [DEV_ACCOUNTS.map((a) => a.email)],
    );
    expect(rows).toHaveLength(10);
    expect(rows.every((r) => r.status === 'ACTIVE')).toBe(true);
    expect(rows.map((r) => r.track)).toEqual(DEV_ACCOUNTS.map((a) => a.track));

    const override = await client.query<{ role: string }>(
      'SELECT role FROM academy.role_overrides WHERE crm_user_id = $1',
      [MANAGER_CRM_USER_ID],
    );
    expect(override.rows[0]?.role).toBe('MANAGER');
  });

  it('is idempotent: a second run keeps the same ids and creates nothing', async () => {
    const first = await seedTestAccounts(client, { reset: false });
    const second = await seedTestAccounts(client, { reset: false });
    expect(second.accounts.every((a) => a.created)).toBe(false);
    expect(second.accounts.map((a) => a.traineeId)).toEqual(first.accounts.map((a) => a.traineeId));
    const { rows } = await client.query<{ n: string }>(
      'SELECT count(*)::text AS n FROM academy.trainees WHERE email = ANY($1::citext[])',
      [DEV_ACCOUNTS.map((a) => a.email)],
    );
    expect(rows[0]?.n).toBe('10');
  });

  it('re-seeding re-enables an account a manager had disabled', async () => {
    await seedTestAccounts(client, { reset: false });
    await client.query(
      `UPDATE academy.trainees SET is_disabled = TRUE, status = 'PAUSED', track = 'CS'
        WHERE email = $1::citext`,
      ['track.full@example.com'],
    );
    await seedTestAccounts(client, { reset: false });
    const { rows } = await client.query<{
      is_disabled: boolean;
      status: string;
      track: string;
    }>('SELECT is_disabled, status, track FROM academy.trainees WHERE email = $1::citext', [
      'track.full@example.com',
    ]);
    expect(rows[0]).toEqual({ is_disabled: false, status: 'ACTIVE', track: 'FULL' });
  });

  it('--reset clears the progress of these accounts and nobody else', async (ctx) => {
    // Needs seeded content (lessons and stages to point the progress rows at).
    if (!hasContent) ctx.skip();
    const res = await seedTestAccounts(client, { reset: false });
    const devId = res.accounts[0]!.traineeId;

    // A bystander with the same kind of progress. Invented name and email.
    const other = await client.query<{ id: string }>(
      `INSERT INTO academy.trainees (full_name, email, track)
            VALUES ('Other Trainee', 'other.bystander@example.com', 'CS')
         RETURNING id::text AS id`,
    );
    const otherId = other.rows[0]!.id;

    const stage = await client.query<{ id: string }>(
      'SELECT id::text AS id FROM academy.stages ORDER BY id LIMIT 1',
    );
    const lesson = await client.query<{ id: string }>(
      'SELECT id::text AS id FROM academy.lessons ORDER BY id LIMIT 1',
    );
    const stageId = stage.rows[0]!.id;
    const lessonId = lesson.rows[0]!.id;

    for (const id of [devId, otherId]) {
      await client.query(
        'INSERT INTO academy.lesson_progress (trainee_id, lesson_id) VALUES ($1, $2)',
        [id, lessonId],
      );
      await client.query(
        'INSERT INTO academy.stage_completions (trainee_id, stage_id, best_score) VALUES ($1, $2, 100)',
        [id, stageId],
      );
    }

    const cleared = await clearProgress(client, [devId]);
    expect(cleared.lesson_progress).toBe(1);
    expect(cleared.stage_completions).toBe(1);
    expect(Object.keys(cleared).sort()).toEqual([...PROGRESS_TABLES].sort());

    // Only the two trainees this test made: academy_test is shared, so another
    // suite's leftovers must not decide whether this one passes.
    const left = await client.query<{ trainee_id: string }>(
      `SELECT trainee_id::text AS trainee_id FROM academy.lesson_progress
        WHERE trainee_id = ANY($1::bigint[])
        UNION ALL
       SELECT trainee_id::text FROM academy.stage_completions
        WHERE trainee_id = ANY($1::bigint[])`,
      [[devId, otherId]],
    );
    expect(left.rows.map((r) => r.trainee_id)).toEqual([otherId, otherId]);
  });

  it('--reset on freshly created accounts deletes nothing', async () => {
    const res = await seedTestAccounts(client, { reset: true });
    expect(res.cleared).not.toBeNull();
    expect(Object.values(res.cleared!).reduce((n, v) => n + v, 0)).toBe(0);
  });

  it('the sweep reads the accounts and finds one available stage each', async (ctx) => {
    if (!hasContent) ctx.skip();
    await seedTestAccounts(client, { reset: true });
    const data = await readSweepData(client);
    expect(data.accounts.size).toBe(9);
    for (const a of DEV_TRACK_ACCOUNTS) {
      const row = data.accounts.get(a.email)!;
      expect(row.track).toBe(a.track);
      const visible = data.visible.get(a.track)!;
      expect(visible.length).toBeGreaterThan(0);
      const states = stageStates(visible, data.completions.get(row.id) ?? new Set());
      expect(states.filter((s) => s === 'available')).toHaveLength(1);
      expect(states[0]).toBe('available');
      expect(states.filter((s) => s === 'locked')).toHaveLength(visible.length - 1);
    }
  });
});
