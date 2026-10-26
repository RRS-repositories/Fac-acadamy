// ops/admin/withdraw-recording.ts. Argument parsing runs everywhere (no
// database). The database tests run only when MIGRATION_TEST_DB_NAME is set,
// connect with the app's own settings (so they also prove academy_app may make
// this change), and roll every test back. Titles and codes are invented.
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseEnv } from 'node:util';
import pg from 'pg';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { DbSettingsSchema, pgConfig } from '../../server/src/db/connection.js';
import { AdminError } from '../admin/lib.js';
import {
  parseRecordingCode,
  parseWithdrawArgs,
  withdrawRecordings,
} from '../admin/withdraw-recording.js';

describe('withdraw-recording argument parsing', () => {
  const base = ['--by', 'Alex', '--expect-db', 'academy_test', '--reason', 'no sound'];

  it('parses one or more --code values, de-duplicated, in the order given', () => {
    expect(
      parseWithdrawArgs([
        '--code',
        'l2s1-rec1',
        '--code',
        ' l2s1-rec2 ',
        '--code',
        'l2s1-rec1',
        ...base,
      ]),
    ).toEqual({
      codes: ['l2s1-rec1', 'l2s1-rec2'],
      operator: 'Alex',
      reason: 'no sound',
      expectDb: 'academy_test',
      restore: false,
      dryRun: false,
    });
  });

  it('--restore and --dry-run', () => {
    expect(
      parseWithdrawArgs(['--code', 'x-rec1', ...base, '--restore', '--dry-run']),
    ).toMatchObject({
      restore: true,
      dryRun: true,
    });
    expect(parseWithdrawArgs(['--help'])).toBe('help');
  });

  it('refuses a missing --code, --reason, --by or --expect-db', () => {
    expect(() => parseWithdrawArgs(base)).toThrow(/--code/);
    expect(() =>
      parseWithdrawArgs(['--code', 'x-rec1', '--by', 'Alex', '--expect-db', 'x']),
    ).toThrow(/--reason/);
    expect(() =>
      parseWithdrawArgs(['--code', 'x-rec1', '--expect-db', 'x', '--reason', 'r']),
    ).toThrow(/--by/);
    expect(() => parseWithdrawArgs(['--code', 'x-rec1', '--by', 'A', '--reason', 'r'])).toThrow(
      /--expect-db/,
    );
  });

  it('refuses a production database without --confirm-production', () => {
    const prod = [
      '--code',
      'x-rec1',
      '--by',
      'A',
      '--reason',
      'r',
      '--expect-db',
      'client_credentials',
    ];
    expect(() => parseWithdrawArgs(prod)).toThrow(/--confirm-production/);
    expect(parseWithdrawArgs([...prod, '--confirm-production'])).toMatchObject({
      expectDb: 'client_credentials',
    });
  });

  it('checks the shape of a recording code', () => {
    expect(parseRecordingCode('l2s1-rec1')).toBe('l2s1-rec1');
    for (const bad of ['', '  ', 'l2s1 rec1', "x';--", 'a'.repeat(65)]) {
      expect(() => parseRecordingCode(bad)).toThrow(AdminError);
    }
  });
});

// ---------------------------------------------------------------------------
// Database tests
// ---------------------------------------------------------------------------

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

const CODE_A = 'zz-withdraw-test-rec1';
const CODE_B = 'zz-withdraw-test-rec2';

describe.skipIf(!TEST_DB)('withdraw-recording against the test database', () => {
  let client: pg.Client;

  beforeAll(async () => {
    const settings = DbSettingsSchema.parse({ ...env, DB_NAME: TEST_DB });
    client = new pg.Client(pgConfig(settings, { applicationName: 'academy-admin-test' }));
    await client.connect();
    const { rows } = await client.query<{ db: string }>('SELECT current_database() AS db');
    expect(rows[0]?.db).toBe(TEST_DB);
  });

  afterAll(async () => {
    await client?.end();
  });

  // Two invented library videos (no stage), so no level or stage fixtures are needed.
  beforeEach(async () => {
    await client.query('BEGIN');
    for (const [code, title] of [
      [CODE_A, 'Fixture video A'],
      [CODE_B, 'Fixture video B'],
    ] as const) {
      await client.query(
        `INSERT INTO academy.call_recordings
           (code, stage_id, category, title, description, media_key, media_type, position)
         VALUES ($1, NULL, 'COACHING', $2, 'An invented video.', $3, 'VIDEO', 1)`,
        [code, title, `academy/media/${code}.mp4`],
      );
    }
  });

  afterEach(async () => {
    await client.query('ROLLBACK');
  });

  async function state(code: string) {
    const { rows } = await client.query<{ is_active: boolean; media_key: string | null }>(
      'SELECT is_active, media_key FROM academy.call_recordings WHERE code = $1',
      [code],
    );
    return rows[0];
  }

  async function audits(eventType: string) {
    const { rows } = await client.query<{ actor: string; payload: Record<string, unknown> }>(
      `SELECT actor, payload FROM academy.audit_events
        WHERE event_type = $1 AND actor LIKE 'ops:%' AND created_at >= now() ORDER BY id`,
      [eventType],
    );
    return rows;
  }

  it('withdraws each recording, keeps its file, and audits RECORDING_WITHDRAWN', async () => {
    const res = await withdrawRecordings(client, {
      codes: [CODE_A, CODE_B],
      operator: 'Alex',
      reason: 'no sound',
      restore: false,
    });
    expect(res.map((r) => [r.code, r.title, r.changed])).toEqual([
      [CODE_A, 'Fixture video A', true],
      [CODE_B, 'Fixture video B', true],
    ]);
    expect(await state(CODE_A)).toEqual({
      is_active: false,
      media_key: `academy/media/${CODE_A}.mp4`,
    });
    expect(await state(CODE_B)).toMatchObject({ is_active: false });
    const rows = await audits('RECORDING_WITHDRAWN');
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({
      actor: 'ops:Alex',
      payload: { code: CODE_A, title: 'Fixture video A', stage: null, reason: 'no sound' },
    });
  });

  it('a repeat is a no-op with no audit row; --restore brings it back', async () => {
    const opts = { codes: [CODE_A], operator: 'Alex', reason: 'no sound', restore: false };
    await withdrawRecordings(client, opts);
    const again = await withdrawRecordings(client, opts);
    expect(again[0]).toMatchObject({ changed: false, auditId: null });
    expect(await audits('RECORDING_WITHDRAWN')).toHaveLength(1);

    const back = await withdrawRecordings(client, {
      ...opts,
      reason: 're-recorded',
      restore: true,
    });
    expect(back[0]).toMatchObject({ changed: true });
    expect(await state(CODE_A)).toMatchObject({ is_active: true });
    expect(await audits('RECORDING_RESTORED')).toHaveLength(1);
  });

  it('refuses the whole batch when any code is unknown, changing nothing', async () => {
    await expect(
      withdrawRecordings(client, {
        codes: [CODE_A, 'zz-no-such-rec9'],
        operator: 'Alex',
        reason: 'no sound',
        restore: false,
      }),
    ).rejects.toThrow(/zz-no-such-rec9/);
    expect(await state(CODE_A)).toMatchObject({ is_active: true });
  });
});
