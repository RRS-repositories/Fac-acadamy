// IT admin commands (ops/admin/). Argument parsing runs everywhere (no database).
// The database tests run only when MIGRATION_TEST_DB_NAME is set (the throw-away
// test database, migrated to 0004). They connect with the app's own settings
// (DB_USER, normally academy_app), so they also prove the app role has the rights
// these commands need. Every database test runs in a transaction that is rolled
// back, so nothing is left behind (academy_app cannot delete audit rows).
// Names and emails are invented.
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseEnv } from 'node:util';
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, afterEach, describe, expect, it } from 'vitest';
import { DbSettingsSchema, pgConfig } from '../../server/src/db/connection.js';
import {
  AdminError,
  actorFor,
  inTransaction,
  parseEmail,
  parseOperator,
  parseReason,
} from '../admin/lib.js';
import { authoriseStage1, parseAuthoriseStage1Args } from '../admin/authorise-stage1.js';
import { parseResetMfaArgs, resetMfa } from '../admin/reset-mfa.js';
import { parseSetTrackArgs, parseTrackCode, setTrack } from '../admin/set-track.js';
import {
  parseCrmUserId,
  parseOverrideRole,
  parseSetRoleArgs,
  setRoleOverride,
} from '../admin/set-role-override.js';

describe('admin argument parsing', () => {
  it('parses a full reset-mfa command line', () => {
    expect(
      parseResetMfaArgs([
        '--email',
        ' trainee.admin@example.com ',
        '--by',
        'Alex Example',
        '--expect-db',
        'academy_test',
        '--reason',
        'lost phone',
        '--dry-run',
      ]),
    ).toEqual({
      email: 'trainee.admin@example.com',
      operator: 'Alex Example',
      reason: 'lost phone',
      expectDb: 'academy_test',
      dryRun: true,
    });
  });

  it('reset-mfa: reason is optional, dry run defaults off, --help short-circuits', () => {
    const a = parseResetMfaArgs(['--email', 'a@example.com', '--by', 'Alex', '--expect-db', 'x']);
    expect(a).toMatchObject({ reason: undefined, dryRun: false });
    expect(parseResetMfaArgs(['--help'])).toBe('help');
  });

  it('refuses a missing --expect-db, --by or --email', () => {
    expect(() => parseResetMfaArgs(['--email', 'a@example.com', '--by', 'Alex'])).toThrow(
      /--expect-db/,
    );
    expect(() => parseResetMfaArgs(['--email', 'a@example.com', '--expect-db', 'x'])).toThrow(
      /--by/,
    );
    expect(() => parseResetMfaArgs(['--by', 'Alex', '--expect-db', 'x'])).toThrow(/--email/);
  });

  it('refuses unknown options and positional arguments', () => {
    expect(() =>
      parseResetMfaArgs(['--email', 'a@example.com', '--by', 'A', '--expect-db', 'x', '--force']),
    ).toThrow();
    expect(() =>
      parseResetMfaArgs(['--email', 'a@example.com', '--by', 'A', '--expect-db', 'x', 'extra']),
    ).toThrow();
  });

  it('validates emails', () => {
    expect(parseEmail('Trainee.Admin@Example.com')).toBe('Trainee.Admin@Example.com');
    expect(() => parseEmail('not-an-email')).toThrow(AdminError);
    expect(() => parseEmail('a b@example.com')).toThrow(AdminError);
    expect(() => parseEmail('   ')).toThrow(/required/);
  });

  it('validates operator names and builds the ops: actor', () => {
    expect(parseOperator("  Sam O'Example-Smith ")).toBe("Sam O'Example-Smith");
    expect(actorFor('Sam')).toBe('ops:Sam');
    expect(() => parseOperator('')).toThrow(/--by/);
    expect(() => parseOperator('1abc')).toThrow(AdminError);
    expect(() => parseOperator('sam;drop')).toThrow(AdminError);
    expect(() => parseOperator('a'.repeat(65))).toThrow(AdminError);
  });

  it('validates reasons', () => {
    expect(parseReason(undefined, false)).toBeUndefined();
    expect(parseReason('  ', false)).toBeUndefined();
    expect(() => parseReason(undefined, true)).toThrow(/--reason/);
    expect(() => parseReason('x'.repeat(501), false)).toThrow(/too long/);
  });

  it('set-track: upper-cases the code and checks its shape', () => {
    expect(parseTrackCode(' cs ')).toBe('CS');
    expect(() => parseTrackCode(undefined)).toThrow(/--track/);
    expect(() => parseTrackCode('C S')).toThrow(AdminError);
    expect(
      parseSetTrackArgs([
        '--email',
        'a@example.com',
        '--track',
        'admin',
        '--by',
        'Alex',
        '--expect-db',
        'academy_test',
      ]),
    ).toEqual({
      email: 'a@example.com',
      track: 'ADMIN',
      operator: 'Alex',
      expectDb: 'academy_test',
      dryRun: false,
    });
  });

  it('set-track: --clear and --track none both mean "take the track away"', () => {
    const base = ['--email', 'a@example.com', '--by', 'Alex', '--expect-db', 'academy_test'];
    expect(parseTrackCode('none')).toBeNull();
    expect(parseTrackCode(' NONE ')).toBeNull();
    expect(parseSetTrackArgs([...base, '--clear'])).toMatchObject({ track: null });
    expect(parseSetTrackArgs([...base, '--track', 'none'])).toMatchObject({ track: null });
    // Belt and braces, both spellings together.
    expect(parseSetTrackArgs([...base, '--clear', '--track', 'NONE'])).toMatchObject({
      track: null,
    });
    // ...but not two different instructions at once, and not an empty --track.
    expect(() => parseSetTrackArgs([...base, '--clear', '--track', 'CS'])).toThrow(
      /either --clear or --track/,
    );
    expect(() => parseSetTrackArgs([...base, '--track', '  '])).toThrow(AdminError);
    expect(() => parseSetTrackArgs([...base, '--track', 'no track'])).toThrow(/not a track code/);
  });

  it('authorise-stage1: parses the full command line, --revoke and the optional reason', () => {
    const base = ['--email', 'a@example.com', '--by', 'Alex', '--expect-db', 'academy_test'];
    expect(parseAuthoriseStage1Args(base)).toEqual({
      email: 'a@example.com',
      operator: 'Alex',
      reason: undefined,
      expectDb: 'academy_test',
      revoke: false,
      dryRun: false,
    });
    expect(parseAuthoriseStage1Args([...base, '--revoke', '--dry-run'])).toMatchObject({
      revoke: true,
      dryRun: true,
    });
    expect(parseAuthoriseStage1Args([...base, '--reason', 'manager signed off'])).toMatchObject({
      reason: 'manager signed off',
    });
    expect(parseAuthoriseStage1Args(['--help'])).toBe('help');
    // The same guards as every other admin command.
    expect(() => parseAuthoriseStage1Args(['--by', 'Alex', '--expect-db', 'x'])).toThrow(/--email/);
    expect(() => parseAuthoriseStage1Args(['--email', 'a@example.com', '--by', 'Alex'])).toThrow(
      /--expect-db/,
    );
    expect(() => parseAuthoriseStage1Args([...base, '--force'])).toThrow();
    expect(() => parseAuthoriseStage1Args([...base, 'extra'])).toThrow();
  });

  it('set-role-override: parses id, role and required reason', () => {
    expect(parseCrmUserId('42')).toBe('42');
    expect(parseCrmUserId('9223372036854775807')).toBe('9223372036854775807');
    for (const bad of ['0', '-1', '01', '1.5', 'abc', '9223372036854775808']) {
      expect(() => parseCrmUserId(bad)).toThrow(AdminError);
    }
    expect(parseOverrideRole('manager')).toBe('MANAGER');
    expect(parseOverrideRole('STAFF')).toBe('STAFF');
    expect(parseOverrideRole('none')).toBeNull();
    expect(() => parseOverrideRole('ADMIN')).toThrow(/STAFF, MANAGER or none/);
    const base = ['--crm-user-id', '7', '--role', 'none', '--by', 'Alex', '--expect-db', 'x'];
    expect(() => parseSetRoleArgs(base)).toThrow(/--reason/);
    expect(parseSetRoleArgs([...base, '--reason', 'left the team'])).toEqual({
      crmUserId: '7',
      role: null,
      operator: 'Alex',
      reason: 'left the team',
      expectDb: 'x',
      dryRun: false,
    });
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

const EMAIL = 'trainee.admin@example.com';
const CRM_ID = '990000001';

describe.skipIf(!TEST_DB)('admin commands against the test database', () => {
  let client: pg.Client;
  let traineeId: string;

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

  // Each test: a fresh transaction with one invented trainee (no track, D13),
  // rolled back afterwards.
  beforeEach(async () => {
    await client.query('BEGIN');
    const { rows } = await client.query<{ id: string }>(
      `INSERT INTO academy.trainees (crm_user_id, full_name, email)
       VALUES ($1, 'Trainee Admin', $2) RETURNING id::text AS id`,
      [CRM_ID, EMAIL],
    );
    traineeId = rows[0]!.id;
  });

  afterEach(async () => {
    await client.query('ROLLBACK');
  });

  async function auditRows(eventType: string) {
    const { rows } = await client.query<{
      trainee_id: string | null;
      actor: string;
      payload: Record<string, unknown>;
    }>(
      `SELECT trainee_id::text AS trainee_id, actor, payload FROM academy.audit_events
       WHERE event_type = $1 AND actor LIKE 'ops:%' AND created_at >= now() ORDER BY id`,
      [eventType],
    );
    return rows;
  }

  it('a new trainee may have no track (0004, D13)', async () => {
    const { rows } = await client.query<{ track: string | null }>(
      'SELECT track FROM academy.trainees WHERE id = $1',
      [traineeId],
    );
    expect(rows[0]?.track).toBeNull();
  });

  it('reset-mfa deletes the authenticator and audits MFA_RESET', async () => {
    await client.query(
      `INSERT INTO academy.trainee_mfa (trainee_id, secret_enc, enrolled_at)
       VALUES ($1, '\\x01020304'::bytea, now())`,
      [traineeId],
    );
    const res = await resetMfa(client, {
      email: 'Trainee.Admin@Example.com', // CITEXT: case does not matter
      operator: 'Alex Example',
      reason: 'lost phone',
    });
    expect(res).toMatchObject({ traineeId, email: EMAIL, reset: true, wasEnrolled: true });
    const left = await client.query('SELECT 1 FROM academy.trainee_mfa WHERE trainee_id = $1', [
      traineeId,
    ]);
    expect(left.rowCount).toBe(0);
    const audit = await auditRows('MFA_RESET');
    expect(audit).toEqual([
      {
        trainee_id: traineeId,
        actor: 'ops:Alex Example',
        payload: { was_enrolled: true, reason: 'lost phone' },
      },
    ]);
  });

  it('reset-mfa with no authenticator on file changes nothing and writes no audit', async () => {
    const res = await resetMfa(client, { email: EMAIL, operator: 'Alex' });
    expect(res).toMatchObject({ reset: false, auditId: null });
    expect(await auditRows('MFA_RESET')).toEqual([]);
  });

  it('reset-mfa refuses an unknown email', async () => {
    await expect(
      resetMfa(client, { email: 'nobody.admin@example.com', operator: 'Alex' }),
    ).rejects.toThrow(/No trainee with email/);
  });

  it('set-track sets the track and audits TRACK_ASSIGNED; a repeat is a no-op', async () => {
    const res = await setTrack(client, { email: EMAIL, track: 'CS', operator: 'Alex' });
    expect(res).toMatchObject({ traineeId, from: null, to: 'CS', changed: true });
    const t = await client.query<{ track: string }>(
      'SELECT track FROM academy.trainees WHERE id = $1',
      [traineeId],
    );
    expect(t.rows[0]?.track).toBe('CS');
    const again = await setTrack(client, { email: EMAIL, track: 'CS', operator: 'Alex' });
    expect(again).toMatchObject({ changed: false, auditId: null });
    const moved = await setTrack(client, { email: EMAIL, track: 'ADMIN', operator: 'Alex' });
    expect(moved).toMatchObject({ from: 'CS', to: 'ADMIN', changed: true });
    expect(await auditRows('TRACK_ASSIGNED')).toEqual([
      { trainee_id: traineeId, actor: 'ops:Alex', payload: { from: null, to: 'CS' } },
      { trainee_id: traineeId, actor: 'ops:Alex', payload: { from: 'CS', to: 'ADMIN' } },
    ]);
  });

  it('set-track clears the track and audits TRACK_CLEARED, keeping the progress rows', async () => {
    await setTrack(client, { email: EMAIL, track: 'CS', operator: 'Alex' });
    // A stage this trainee has finished. It is keyed to the stage, not to the
    // track, so taking the track away must not touch it.
    const stage = await client.query<{ id: string }>(
      'SELECT id::text AS id FROM academy.stages ORDER BY id LIMIT 1',
    );
    const stageId = stage.rows[0]?.id ?? null;
    if (stageId !== null) {
      await client.query(
        `INSERT INTO academy.stage_completions (trainee_id, stage_id, best_score)
         VALUES ($1, $2, 90) ON CONFLICT DO NOTHING`,
        [traineeId, stageId],
      );
    }

    const cleared = await setTrack(client, { email: EMAIL, track: null, operator: 'Alex' });
    expect(cleared).toMatchObject({
      traineeId,
      from: 'CS',
      to: null,
      changed: true,
      eventType: 'TRACK_CLEARED',
    });
    const t = await client.query<{ track: string | null }>(
      'SELECT track FROM academy.trainees WHERE id = $1',
      [traineeId],
    );
    expect(t.rows[0]?.track).toBeNull();
    expect(await auditRows('TRACK_CLEARED')).toEqual([
      { trainee_id: traineeId, actor: 'ops:Alex', payload: { from: 'CS' } },
    ]);

    if (stageId !== null) {
      const kept = await client.query(
        'SELECT 1 FROM academy.stage_completions WHERE trainee_id = $1 AND stage_id = $2',
        [traineeId, stageId],
      );
      expect(kept.rowCount).toBe(1);
    }

    // Clearing a track that is not there changes nothing and writes no audit.
    const again = await setTrack(client, { email: EMAIL, track: null, operator: 'Alex' });
    expect(again).toMatchObject({ changed: false, to: null, eventType: null, auditId: null });
    expect(await auditRows('TRACK_CLEARED')).toHaveLength(1);
  });

  it('set-track refuses a code that is not in academy.tracks', async () => {
    await expect(
      setTrack(client, { email: EMAIL, track: 'NOPE', operator: 'Alex' }),
    ).rejects.toThrow(/Unknown track "NOPE"\. Valid tracks: .*ADMIN/);
  });

  it('set-role-override upserts, updates and deletes, auditing each change', async () => {
    const set = await setRoleOverride(client, {
      crmUserId: CRM_ID,
      role: 'MANAGER',
      operator: 'Alex',
      reason: 'team lead',
    });
    expect(set).toMatchObject({ traineeId, from: null, to: 'MANAGER', changed: true });
    const upd = await setRoleOverride(client, {
      crmUserId: CRM_ID,
      role: 'STAFF',
      operator: 'Sam',
      reason: 'stepped down',
    });
    expect(upd).toMatchObject({ from: 'MANAGER', to: 'STAFF' });
    const row = await client.query<{ role: string; reason: string; granted_by: string }>(
      'SELECT role, reason, granted_by FROM academy.role_overrides WHERE crm_user_id = $1',
      [CRM_ID],
    );
    expect(row.rows[0]).toEqual({ role: 'STAFF', reason: 'stepped down', granted_by: 'ops:Sam' });
    const del = await setRoleOverride(client, {
      crmUserId: CRM_ID,
      role: null,
      operator: 'Sam',
      reason: 'back to default',
    });
    expect(del).toMatchObject({ from: 'STAFF', to: null, changed: true });
    const gone = await client.query('SELECT 1 FROM academy.role_overrides WHERE crm_user_id = $1', [
      CRM_ID,
    ]);
    expect(gone.rowCount).toBe(0);
    const noop = await setRoleOverride(client, {
      crmUserId: CRM_ID,
      role: null,
      operator: 'Sam',
      reason: 'again',
    });
    expect(noop).toMatchObject({ changed: false, auditId: null });
    const audit = await auditRows('ROLE_OVERRIDE_SET');
    expect(audit.map((a) => a.payload)).toEqual([
      { crm_user_id: CRM_ID, from: null, to: 'MANAGER', reason: 'team lead' },
      { crm_user_id: CRM_ID, from: 'MANAGER', to: 'STAFF', reason: 'stepped down' },
      { crm_user_id: CRM_ID, from: 'STAFF', to: null, reason: 'back to default' },
    ]);
    expect(audit.every((a) => a.trainee_id === traineeId)).toBe(true);
  });

  // The STAGE1_AUTH_REQUIRED gate. gate() reads
  // progression_authorisations.authorised and treats a missing row as false, so
  // the command has to create the row, flip it back, and be a no-op when it is
  // already where it was asked to be.
  it('authorise-stage1 creates the row, revokes it again, and audits each change', async () => {
    const none = await client.query(
      'SELECT 1 FROM academy.progression_authorisations WHERE trainee_id = $1',
      [traineeId],
    );
    expect(none.rowCount).toBe(0);

    const granted = await authoriseStage1(client, {
      email: 'Trainee.Admin@Example.com', // CITEXT: case does not matter
      operator: 'Alex Example',
      reason: 'manager signed off',
    });
    expect(granted).toMatchObject({
      traineeId,
      email: EMAIL,
      from: false,
      to: true,
      changed: true,
    });

    const row = await client.query<{ authorised: boolean; authorised_at: Date | null }>(
      'SELECT authorised, authorised_at FROM academy.progression_authorisations WHERE trainee_id = $1',
      [traineeId],
    );
    expect(row.rows[0]?.authorised).toBe(true);
    expect(row.rows[0]?.authorised_at).toBeInstanceOf(Date);

    // Asking twice changes nothing and writes no second audit row.
    const again = await authoriseStage1(client, { email: EMAIL, operator: 'Alex' });
    expect(again).toMatchObject({ from: true, to: true, changed: false, auditId: null });

    const revoked = await authoriseStage1(client, {
      email: EMAIL,
      operator: 'Sam',
      revoke: true,
      reason: 'sent back to stage 1',
    });
    expect(revoked).toMatchObject({ from: true, to: false, changed: true });
    const after = await client.query<{ authorised: boolean; authorised_at: Date | null }>(
      'SELECT authorised, authorised_at FROM academy.progression_authorisations WHERE trainee_id = $1',
      [traineeId],
    );
    expect(after.rows[0]?.authorised).toBe(false);
    expect(after.rows[0]?.authorised_at).toBeNull();

    // Revoking an authorisation that is not there is a no-op, not an error.
    const noop = await authoriseStage1(client, { email: EMAIL, operator: 'Sam', revoke: true });
    expect(noop).toMatchObject({ changed: false, auditId: null });

    const audit = await auditRows('STAGE1_AUTHORISED');
    expect(audit).toEqual([
      {
        trainee_id: traineeId,
        actor: 'ops:Alex Example',
        payload: { from: false, to: true, reason: 'manager signed off' },
      },
      {
        trainee_id: traineeId,
        actor: 'ops:Sam',
        payload: { from: true, to: false, reason: 'sent back to stage 1' },
      },
    ]);
  });

  it('authorise-stage1 refuses an unknown email', async () => {
    await expect(
      authoriseStage1(client, { email: 'nobody.admin@example.com', operator: 'Alex' }),
    ).rejects.toThrow(/No trainee with email/);
  });

  it('set-role-override works before the person has a trainee row', async () => {
    const res = await setRoleOverride(client, {
      crmUserId: '990000002',
      role: 'MANAGER',
      operator: 'Alex',
      reason: 'new manager',
    });
    expect(res).toMatchObject({ traineeId: null, changed: true });
  });
});

// The dry-run path: inTransaction must roll back. Uses its own connection so it
// is not inside the per-test transaction above.
describe.skipIf(!TEST_DB)('inTransaction on the test database', () => {
  it('rolls back on dry run and on error, commits otherwise', async () => {
    const settings = DbSettingsSchema.parse({ ...env, DB_NAME: TEST_DB });
    const c = new pg.Client(pgConfig(settings, { applicationName: 'academy-admin-test' }));
    await c.connect();
    try {
      await c.query('CREATE TEMP TABLE admin_tx_probe (n int)');
      await inTransaction(c, true, () => c.query('INSERT INTO admin_tx_probe VALUES (1)'));
      await expect(
        inTransaction(c, false, async () => {
          await c.query('INSERT INTO admin_tx_probe VALUES (2)');
          throw new AdminError('boom');
        }),
      ).rejects.toThrow('boom');
      await inTransaction(c, false, () => c.query('INSERT INTO admin_tx_probe VALUES (3)'));
      const { rows } = await c.query<{ n: number }>('SELECT n FROM admin_tx_probe ORDER BY n');
      expect(rows.map((r) => r.n)).toEqual([3]);
    } finally {
      await c.end();
    }
  });
});
