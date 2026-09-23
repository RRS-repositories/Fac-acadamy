// S05: GET /api/status-guide against the REAL seeded content in the local
// test database (MIGRATION_TEST_DB_NAME). The expected row count comes from
// ops/fixtures/expected-track-visibility.json (counts.statusGuide), the same
// fixture the S02 seed verification uses.
//
// Nothing here asserts on the status text or the client lines: those are the
// firm's content and must never be copied into this repo. The suite checks the
// shape, the count and the order, and skips cleanly when there is no local
// test database or no seeded content.
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseEnv } from 'node:util';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type pg from 'pg';
import { StatusGuideResponseSchema } from '@fac-academy/shared';
import type { StatusGuideResponse } from '@fac-academy/shared';
import { TEST_DB, get, openTestDb, signIn } from './helpers/authHarness.js';
import type { Db, Harness, SignedIn } from './helpers/authHarness.js';

const REPO_ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const FIXTURE_PATH = resolve(REPO_ROOT, 'ops/fixtures/expected-track-visibility.json');
const fixture = JSON.parse(readFileSync(FIXTURE_PATH, 'utf8')) as {
  counts?: { statusGuide?: number };
};
const fixtureCount: unknown = fixture.counts?.statusGuide;
if (typeof fixtureCount !== 'number') {
  throw new Error('fixture has no counts.statusGuide');
}
const EXPECTED_ROWS: number = fixtureCount;

/** The prototype path, from the environment or the repo-root .env. */
function prototypePath(): string {
  if ((process.env.PROTOTYPE_PATH ?? '').trim() !== '') return process.env.PROTOTYPE_PATH!;
  const file = resolve(REPO_ROOT, '.env');
  if (!existsSync(file)) return '';
  return (parseEnv(readFileSync(file, 'utf8')).PROTOTYPE_PATH ?? '').trim();
}

/** Runs the S02 seed against the TEST database only. Returns true on success. */
function reseed(prototype: string): boolean {
  const res = spawnSync('npx', ['tsx', 'ops/seed/seed-content.ts', '--expect-db', TEST_DB], {
    cwd: REPO_ROOT,
    env: { ...process.env, DB_NAME: TEST_DB, PROTOTYPE_PATH: prototype },
    encoding: 'utf8',
    shell: true,
    timeout: 300_000,
  });
  if (res.status === 0) return true;
  console.warn(`[status-guide] the content seed failed (exit ${String(res.status)}).`);
  return false;
}

async function countRows(pool: pg.Pool): Promise<number> {
  const { rows } = await pool.query<{ n: string }>(
    'SELECT count(*) AS n FROM academy.status_guide',
  );
  return Number(rows[0]?.n ?? 0);
}

const db: Db | null = TEST_DB ? await openTestDb() : null;
let rowCount = 0;
if (db !== null) {
  rowCount = await countRows(db.pool);
  if (rowCount === 0) {
    const prototype = prototypePath();
    if (prototype !== '' && existsSync(prototype) && reseed(prototype)) {
      rowCount = await countRows(db.pool);
    }
  }
  if (rowCount === 0) {
    console.warn(
      `[status-guide] SKIPPED: ${TEST_DB} has no status guide rows. Seed it first:\n` +
        '  DB_NAME=<test db> PROTOTYPE_PATH=<build-pack>/FAC-Academy-Portal-v2.5.html \\\n' +
        '    npx tsx ops/seed/seed-content.ts --expect-db <test db>\n' +
        '(set PROTOTYPE_PATH and this suite re-seeds by itself).',
    );
    await db.cleanup();
  }
}
const ready = db !== null && rowCount > 0;

describe.skipIf(!ready)('S05 GET /api/status-guide', () => {
  let pool: pg.Pool;
  let h: Harness;
  let session: SignedIn;

  beforeAll(async () => {
    pool = db!.pool;
    h = db!.harness();
    const account = h.crm.add(db!.newAccount());
    session = await signIn(h, account);
  });

  afterAll(async () => {
    await db!.cleanup();
  });

  async function guide(harness: Harness = h): Promise<StatusGuideResponse> {
    const res = await get(harness, '/api/status-guide', session.cookie).expect(200);
    return StatusGuideResponseSchema.parse(res.body);
  }

  it(`serves all ${String(EXPECTED_ROWS)} rows, in sort order`, async () => {
    const body = await guide();

    expect(body.rows).toHaveLength(EXPECTED_ROWS);
    // 1-based and contiguous, exactly as the seed numbers them.
    expect(body.rows.map((r) => r.sort)).toEqual(
      Array.from({ length: EXPECTED_ROWS }, (_, i) => i + 1),
    );
    // Every row is a real pair, and the statuses are distinct.
    for (const row of body.rows) {
      expect(row.status.trim().length).toBeGreaterThan(0);
      expect(row.clientLine.trim().length).toBeGreaterThan(0);
      expect(Object.keys(row).sort()).toEqual(['clientLine', 'sort', 'status']);
    }
    expect(new Set(body.rows.map((r) => r.status)).size).toBe(EXPECTED_ROWS);
    // The response carries the rows and nothing else.
    expect(Object.keys(body)).toEqual(['rows']);
  });

  it('matches academy.status_guide row for row', async () => {
    const body = await guide();
    const { rows } = await pool.query<{ status: string; client_line: string; sort: number }>(
      'SELECT status, client_line, sort::int AS sort FROM academy.status_guide ORDER BY sort',
    );
    expect(body.rows).toEqual(
      rows.map((r) => ({ status: r.status, clientLine: r.client_line, sort: r.sort })),
    );
  });

  it('refuses the route without a session', async () => {
    await get(h, '/api/status-guide').expect(401, { error: 'not_signed_in' });
  });

  it('answers 503 while ACADEMY_V2 is off', async () => {
    const off = db!.harness({ flagEnabled: false });
    await get(off, '/api/status-guide').expect(503, { flag: 'off' });
    await get(off, '/api/status-guide', session.cookie).expect(503, { flag: 'off' });
  });
});
