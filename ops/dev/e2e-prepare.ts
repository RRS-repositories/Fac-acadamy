// LOCAL / TEST ONLY. Puts academy_dev into the state the Section 10 Playwright
// suite expects, and takes it out again.
//
//   npx tsx ops/dev/e2e-prepare.ts --expect-db academy_dev [--json]
//   npx tsx ops/dev/e2e-prepare.ts --expect-db academy_dev --clean [--json]
//
// The suite's global setup runs the first form; its global teardown runs the
// second. Both are idempotent, so a crashed run leaves nothing behind that the
// next `prepare` does not clear.
//
// It does five things:
//
//  1. re-seeds the nine per-track dev accounts and the manager (the same
//     ops/dev/seed-test-accounts.ts the S04 sweeps use), clearing their
//     progress;
//  2. makes sure each mock-CRM sign-in account has a trainee row, clears its
//     progress, re-enables it, ends its old sessions and DELETES its
//     authenticator, so every spec run enrols a fresh TOTP secret it can
//     generate codes from;
//  3. deletes those accounts' certificates and the PDFs behind them, so the
//     certificate journey proves an issue rather than finding last run's row;
//  4. installs a SHORT fixture recording — a 20-second generated WAV — on the
//     first "coming soon" slot of stage s4, so the listening gate can be
//     driven honestly, end to end, at the pace the server's own wall-clock
//     rule accepts. The real call recordings run from 6 to 17 minutes, which
//     no test suite can sit through; nothing about the RULE is relaxed, only
//     the length of the thing listened to;
//  5. prints a JSON summary the suite reads (trainee ids, the fixture
//     recording id and its duration).
//
// `--clean` reverses (4) — the slot goes back to "coming soon" and the WAV is
// deleted — and leaves the accounts alone.
//
// `--allow-unseeded` is for a machine that has the schema but no training
// content — a CI runner, which has no prototype HTML to seed from. (1)-(3)
// still work, because an account needs no stage; (4) is impossible, so it is
// skipped and the result says `seeded: false`. WITHOUT the flag an empty
// database is an error, because on a developer's machine it means the seed has
// been lost, and carrying on quietly would hide it.
//
// The guards are the ones every ops/dev script uses: --expect-db must LOOK
// local ('dev' or 'test', never 'prod'/'live'), and must equal DB_NAME and
// current_database(). See ops/dev/lib.ts. Nothing here may run in production.
import { createHash } from 'node:crypto';
import { parseArgs } from 'node:util';
import { loadDotenvIfPresent } from '../../server/src/config/dotenv.js';
import { createLocalMediaStore } from '../../server/src/media/store.js';
import { DevError, type Queryable, connectDev, parseExpectDb, runIfMain, table } from './lib.js';
import { PROGRESS_TABLES, clearProgress, seedTestAccounts } from './seed-test-accounts.js';

// ---------------------------------------------------------------------------
// The accounts the suite signs in with
// ---------------------------------------------------------------------------

/**
 * The only accounts that CAN sign in locally: they are the invented accounts in
 * server/src/integrations/crm/mockCrm.ts, and sign-in needs the CRM to say yes
 * first. The nine ops/dev/seed-test-accounts.ts trainees deliberately have no
 * CRM user, so the suite cannot use them for a browser sign-in; it sets a track
 * on these instead. Password: 'dev-password' (mock CRM only).
 */
export interface E2eAccount {
  email: string;
  fullName: string;
  crmUserId: number;
  role: 'STAFF' | 'MANAGER';
  /** The track the account is parked on between specs; each spec sets its own. */
  track: string;
}

export const E2E_STAFF_ACCOUNTS: readonly E2eAccount[] = Object.freeze([
  {
    email: 'trainee.one@example.com',
    fullName: 'Trainee One',
    crmUserId: 900001,
    role: 'STAFF',
    track: 'CS',
  },
  {
    email: 'trainee.two@example.com',
    fullName: 'Trainee Two',
    crmUserId: 900002,
    role: 'STAFF',
    track: 'CS',
  },
  {
    email: 'shot.agent@example.com',
    fullName: 'Screenshot Agent',
    crmUserId: 900006,
    role: 'STAFF',
    track: 'CS',
  },
  {
    email: 'shot.dept@example.com',
    fullName: 'Screenshot Department',
    crmUserId: 900007,
    role: 'STAFF',
    track: 'ADMIN',
  },
]);

export const E2E_MANAGER_ACCOUNT: E2eAccount = Object.freeze({
  email: 'manager.one@example.com',
  fullName: 'Manager One',
  crmUserId: 900003,
  role: 'MANAGER',
  track: 'MGMT',
});

export const E2E_ACCOUNTS: readonly E2eAccount[] = Object.freeze([
  ...E2E_STAFF_ACCOUNTS,
  E2E_MANAGER_ACCOUNT,
]);

// ---------------------------------------------------------------------------
// The short fixture recording
// ---------------------------------------------------------------------------

/** The stage whose first empty slot carries the fixture. CS and FULL see it. */
export const FIXTURE_STAGE_CODE = 's4';
/** Long enough to need several honest beacons, short enough to sit through. */
export const FIXTURE_DURATION_SECS = 20;
export const FIXTURE_MEDIA_KEY = 'academy/media/e2e-fixture-listen-20s.wav';
export const FIXTURE_CONTENT_TYPE = 'audio/wav';
/** Written into the row so `--clean` can find what it installed. */
export const FIXTURE_MARKER = '[e2e fixture]';

/**
 * A real, decodable 20-second WAV: 8 kHz mono 16-bit PCM carrying a quiet
 * 440 Hz tone. Generated rather than committed, because no media file may live
 * in this repo (CLAUDE.md).
 */
export function makeFixtureWav(seconds = FIXTURE_DURATION_SECS): Buffer {
  const rate = 8000;
  const samples = rate * seconds;
  const data = Buffer.alloc(samples * 2);
  for (let i = 0; i < samples; i += 1) {
    // A quiet tone (about -20 dBFS): audible enough to be real audio, quiet
    // enough that a headless run playing it is not a nuisance.
    data.writeInt16LE(Math.round(Math.sin((2 * Math.PI * 440 * i) / rate) * 3200), i * 2);
  }
  const header = Buffer.alloc(44);
  header.write('RIFF', 0, 'ascii');
  header.writeUInt32LE(36 + data.length, 4);
  header.write('WAVE', 8, 'ascii');
  header.write('fmt ', 12, 'ascii');
  header.writeUInt32LE(16, 16); // PCM chunk size
  header.writeUInt16LE(1, 20); // format: PCM
  header.writeUInt16LE(1, 22); // channels
  header.writeUInt32LE(rate, 24);
  header.writeUInt32LE(rate * 2, 28); // byte rate
  header.writeUInt16LE(2, 32); // block align
  header.writeUInt16LE(16, 34); // bits per sample
  header.write('data', 36, 'ascii');
  header.writeUInt32LE(data.length, 40);
  return Buffer.concat([header, data]);
}

// ---------------------------------------------------------------------------
// Arguments
// ---------------------------------------------------------------------------

export const E2E_PREPARE_USAGE =
  'Usage: e2e-prepare --expect-db <database name> [--clean] [--json] [--allow-unseeded]';

export interface E2ePrepareArgs {
  expectDb: string;
  clean: boolean;
  json: boolean;
  allowUnseeded: boolean;
}

export function parseE2ePrepareArgs(argv: string[]): E2ePrepareArgs | 'help' {
  const { values } = parseArgs({
    args: argv,
    strict: true,
    allowPositionals: false,
    options: {
      'expect-db': { type: 'string' },
      clean: { type: 'boolean', default: false },
      json: { type: 'boolean', default: false },
      'allow-unseeded': { type: 'boolean', default: false },
      help: { type: 'boolean', short: 'h', default: false },
    },
  });
  if (values.help) return 'help';
  return {
    expectDb: parseExpectDb(values['expect-db']),
    clean: values.clean === true,
    json: values.json === true,
    allowUnseeded: values['allow-unseeded'] === true,
  };
}

// ---------------------------------------------------------------------------
// The work
// ---------------------------------------------------------------------------

export interface PreparedAccount extends E2eAccount {
  traineeId: number;
}

export interface FixtureRecording {
  recordingId: number;
  stageCode: string;
  durationSecs: number;
  mediaKey: string;
  byteSize: number;
}

export interface PrepareResult {
  accounts: PreparedAccount[];
  staff: string[];
  manager: string;
  /**
   * False when the database has been migrated but never seeded with the
   * training content — the state of a CI runner, which has no prototype HTML
   * to seed from. Everything that needs a stage is then impossible, and the
   * suite must be restricted to the tests that need none.
   */
  seeded: boolean;
  /** Null when `seeded` is false: there is no stage to hang a recording on. */
  fixture: FixtureRecording | null;
  cleared: Record<string, number>;
  certificatesRemoved: number;
}

function mediaRoot(): string {
  const root = process.env['MEDIA_ROOT'];
  if (root === undefined || root.trim() === '') {
    throw new DevError('MEDIA_ROOT is not set, so the fixture recording cannot be written.');
  }
  return root;
}

/** Upsert the trainee row for one sign-in account and return its id. */
async function upsertAccount(db: Queryable, account: E2eAccount): Promise<number> {
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO academy.trainees (full_name, email, track, status, crm_user_id)
          VALUES ($1, $2, $3, 'ACTIVE', $4)
     ON CONFLICT (email) DO UPDATE
            SET full_name   = EXCLUDED.full_name,
                track       = EXCLUDED.track,
                status      = 'ACTIVE',
                is_disabled = FALSE,
                disabled_by = NULL,
                disabled_at = NULL,
                crm_user_id = EXCLUDED.crm_user_id
      RETURNING id::text AS id`,
    [account.fullName, account.email, account.track, account.crmUserId],
  );
  const id = rows[0]?.id;
  if (id === undefined) throw new DevError(`Could not prepare the e2e account ${account.email}.`);
  return Number(id);
}

/**
 * Delete the certificates of these trainees and the PDFs behind them, so a
 * certificate the suite finds was issued by the run it is watching.
 */
async function removeCertificates(db: Queryable, traineeIds: readonly number[]): Promise<number> {
  if (traineeIds.length === 0) return 0;
  const { rows } = await db.query<{ media_key: string | null }>(
    `DELETE FROM academy.certificates
      WHERE trainee_id = ANY($1::bigint[])
      RETURNING media_key`,
    [traineeIds],
  );
  const store = createLocalMediaStore(mediaRoot());
  for (const row of rows) {
    if (row.media_key === null) continue;
    await store.delete(row.media_key).catch(() => undefined);
  }
  return rows.length;
}

/** End any session rows still open for these trainees, so "online now" is honest. */
async function endSessions(db: Queryable, traineeIds: readonly number[]): Promise<void> {
  if (traineeIds.length === 0) return;
  await db.query(
    `UPDATE academy.sessions
        SET signed_out_at = now(), revoked = TRUE
      WHERE trainee_id = ANY($1::bigint[]) AND signed_out_at IS NULL`,
    [traineeIds],
  );
}

/** Put every fixture slot back to "coming soon" and delete its file. */
export async function removeFixtureRecording(db: Queryable): Promise<number> {
  const { rows } = await db.query<{ media_key: string | null }>(
    `UPDATE academy.call_recordings
        SET media_key = NULL, duration_secs = NULL, byte_size = NULL,
            content_type = NULL, checksum_sha256 = NULL, uploaded_at = NULL,
            description = regexp_replace(COALESCE(description, ''), '\\s*\\[e2e fixture\\]$', '')
      WHERE media_key = $1 OR description LIKE '%' || $2 || '%'
      RETURNING media_key`,
    [FIXTURE_MEDIA_KEY, FIXTURE_MARKER],
  );
  const store = createLocalMediaStore(mediaRoot());
  await store.delete(FIXTURE_MEDIA_KEY).catch(() => undefined);
  return rows.length;
}

/**
 * Attach the 20-second WAV to the first "coming soon" slot of FIXTURE_STAGE_CODE.
 * An existing row is used rather than a new one, so the stage's recording count
 * is unchanged and `--clean` restores the seed exactly.
 */
export async function installFixtureRecording(db: Queryable): Promise<FixtureRecording> {
  await removeFixtureRecording(db);

  const wav = makeFixtureWav();
  const sha256 = createHash('sha256').update(wav).digest('hex');
  const store = createLocalMediaStore(mediaRoot());
  await store.put(FIXTURE_MEDIA_KEY, wav, { contentType: FIXTURE_CONTENT_TYPE });

  const { rows } = await db.query<{ id: string }>(
    `SELECT r.id::text AS id
       FROM academy.call_recordings r
       JOIN academy.stages s ON s.id = r.stage_id
      WHERE s.code = $1 AND r.is_active AND r.media_key IS NULL
      ORDER BY r.position NULLS LAST, r.id
      LIMIT 1`,
    [FIXTURE_STAGE_CODE],
  );
  const id = rows[0]?.id;
  if (id === undefined) {
    throw new DevError(
      `Stage ${FIXTURE_STAGE_CODE} has no empty recording slot to hold the e2e fixture.`,
    );
  }

  await db.query(
    `UPDATE academy.call_recordings
        SET media_key = $2, duration_secs = $3, byte_size = $4, content_type = $5,
            checksum_sha256 = $6, uploaded_at = now(),
            description = trim(both ' ' from COALESCE(description, '') || ' ' || $7)
      WHERE id = $1`,
    [
      id,
      FIXTURE_MEDIA_KEY,
      FIXTURE_DURATION_SECS,
      wav.length,
      FIXTURE_CONTENT_TYPE,
      sha256,
      FIXTURE_MARKER,
    ],
  );

  return {
    recordingId: Number(id),
    stageCode: FIXTURE_STAGE_CODE,
    durationSecs: FIXTURE_DURATION_SECS,
    mediaKey: FIXTURE_MEDIA_KEY,
    byteSize: wav.length,
  };
}

/** True when the training content has been seeded (there is at least one stage). */
export async function hasSeededContent(db: Queryable): Promise<boolean> {
  const { rows } = await db.query<{ n: string }>('SELECT count(*)::text AS n FROM academy.stages');
  return Number(rows[0]?.n ?? '0') > 0;
}

export interface PrepareOptions {
  /**
   * Allow a database with no training content in it at all. The accounts are
   * still prepared (they need no stage), the fixture recording is not, and the
   * result says `seeded: false` so the caller can refuse to run anything that
   * would need a stage. Without this, an empty database is an error: on a
   * developer's machine it means the seed has been lost, and quietly carrying
   * on would turn 41 browser tests into a handful without saying so.
   */
  allowUnseeded?: boolean;
}

/** Everything the suite needs, in one transaction. */
export async function prepareE2e(
  db: Queryable,
  options: PrepareOptions = {},
): Promise<PrepareResult> {
  const seeded = await hasSeededContent(db);
  if (!seeded && options.allowUnseeded !== true) {
    throw new DevError(
      'This database has no training content: academy.stages is empty, so there is nothing ' +
        'for the browser suite to walk through. Seed it (ops/seed/seed-content.ts, which reads ' +
        'the approved prototype through PROTOTYPE_PATH), or pass --allow-unseeded to prepare ' +
        'the accounts only — which leaves every test that needs a stage unable to run.',
    );
  }

  // The nine per-track accounts and the manager override, progress cleared.
  await seedTestAccounts(db, { reset: true });

  const accounts: PreparedAccount[] = [];
  for (const account of E2E_ACCOUNTS) {
    accounts.push({ ...account, traineeId: await upsertAccount(db, account) });
  }
  const ids = accounts.map((a) => a.traineeId);

  const cleared = await clearProgress(db, ids.map(String));
  const certificatesRemoved = await removeCertificates(db, ids);
  await endSessions(db, ids);

  // A fresh authenticator every run: the first sign-in then enrols, which is
  // the only moment the TOTP secret is handed out, and the only way a test can
  // generate a real code.
  await db.query('DELETE FROM academy.trainee_mfa WHERE trainee_id = ANY($1::bigint[])', [ids]);

  const fixture = seeded ? await installFixtureRecording(db) : null;

  return {
    accounts,
    staff: E2E_STAFF_ACCOUNTS.map((a) => a.email),
    manager: E2E_MANAGER_ACCOUNT.email,
    seeded,
    fixture,
    cleared,
    certificatesRemoved,
  };
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

async function main(): Promise<number> {
  const args = parseE2ePrepareArgs(process.argv.slice(2));
  if (args === 'help') {
    console.log(E2E_PREPARE_USAGE);
    return 0;
  }
  loadDotenvIfPresent();
  const client = await connectDev(args.expectDb, 'academy-e2e-prepare');
  try {
    await client.query('BEGIN');
    try {
      if (args.clean) {
        const reverted = await removeFixtureRecording(client);
        await client.query('COMMIT');
        if (args.json) console.log(JSON.stringify({ cleaned: true, reverted }));
        else console.log(`e2e-prepare --clean: ${String(reverted)} fixture slot(s) restored.`);
        return 0;
      }

      const result = await prepareE2e(client, { allowUnseeded: args.allowUnseeded });
      await client.query('COMMIT');

      if (args.json) {
        console.log(JSON.stringify(result));
        return 0;
      }
      console.log(
        '\nSign-in accounts (mock CRM, password dev-password)\n' +
          table(
            ['email', 'role', 'track', 'trainee id'],
            result.accounts.map((a) => [a.email, a.role, a.track, a.traineeId]),
          ),
      );
      console.log(
        `\nProgress cleared: ${String(
          Object.values(result.cleared).reduce((n, v) => n + v, 0),
        )} row(s) across ${String(PROGRESS_TABLES.length)} tables; ` +
          `${String(result.certificatesRemoved)} certificate(s) removed; ` +
          `authenticators reset.`,
      );
      if (result.fixture === null) {
        console.log(
          'NO TRAINING CONTENT in this database (--allow-unseeded): no fixture recording was ' +
            'installed, and nothing that needs a stage, a lesson or a quiz can be tested here.',
        );
      } else {
        console.log(
          `Fixture recording ${String(result.fixture.recordingId)} on stage ` +
            `${result.fixture.stageCode}: ${String(result.fixture.durationSecs)} s, ` +
            `${String(result.fixture.byteSize)} bytes. ` +
            'Run with --clean to put the slot back to "coming soon".',
        );
      }
      return 0;
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw err;
    }
  } finally {
    await client.end().catch(() => undefined);
  }
}

runIfMain(import.meta.url, 'e2e-prepare', main);
