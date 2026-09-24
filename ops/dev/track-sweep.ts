// CHECKLIST 04 evidence. LOCAL / TEST ONLY.
//
//   npx tsx ops/dev/track-sweep.ts --expect-db academy_dev [--base-url http://localhost:4100]
//
// For each of the 9 tracks it works out what the API must serve, straight from
// the database and with the same rules the server's gate() uses:
//   * the visible stage list is academy.track_visibility for that track, in
//     position order;
//   * a stage is AVAILABLE when it is the first visible stage, or the previous
//     visible stage has a stage_completions row; otherwise it is LOCKED;
//     a stage with a completion row of its own is DONE.
// It reads the real developer accounts (ops/dev/seed-test-accounts.ts), so the
// "fresh account" numbers are measured, not assumed, and it needs no sign-in.
//
// The last table is the locked sweep: how many stage, lesson and quiz requests
// the API must refuse across the 9 accounts. That is the total the Section 04
// API test asserts.
//
// Data hygiene: numbers and stage codes only. No lesson text, no questions, no
// answers are read or printed.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import {
  DEV_TRACKS,
  DEV_TRACK_ACCOUNTS,
  type Check,
  type DevTrack,
  type Queryable,
  connectDev,
  parseBaseUrl,
  parseExpectDb,
  runIfMain,
  summarise,
  table,
} from './lib.js';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const FIXTURE_FILE = path.join(REPO_ROOT, 'ops', 'fixtures', 'expected-track-visibility.json');

export const TRACK_SWEEP_USAGE =
  'Usage: track-sweep --expect-db <database name> [--base-url http://localhost:4100]';

export const DEFAULT_BASE_URL = 'http://localhost:4100';

export interface TrackSweepArgs {
  expectDb: string;
  baseUrl: string;
}

export function parseTrackSweepArgs(argv: string[]): TrackSweepArgs | 'help' {
  const { values } = parseArgs({
    args: argv,
    strict: true,
    allowPositionals: false,
    options: {
      'expect-db': { type: 'string' },
      'base-url': { type: 'string' },
      help: { type: 'boolean', short: 'h', default: false },
    },
  });
  if (values.help) return 'help';
  return {
    expectDb: parseExpectDb(values['expect-db']),
    baseUrl: parseBaseUrl(values['base-url'], DEFAULT_BASE_URL),
  };
}

// ---------------------------------------------------------------------------
// The fixture (ops/fixtures/expected-track-visibility.json): typed by hand from
// PROJECT-PLAN §1, and the independent oracle for both lists below.
// ---------------------------------------------------------------------------

export interface TrackFixture {
  stages: Record<DevTrack, readonly string[]>;
  questionsPerTrack: Record<DevTrack, number>;
}

export function loadTrackFixture(file = FIXTURE_FILE): TrackFixture {
  const raw = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
  const stages = {} as Record<DevTrack, readonly string[]>;
  const questionsPerTrack = {} as Record<DevTrack, number>;
  const perTrack = raw['questionsPerTrack'] as Record<string, unknown> | undefined;
  for (const t of DEV_TRACKS) {
    const list = raw[t];
    if (!Array.isArray(list) || !list.every((v) => typeof v === 'string')) {
      throw new TypeError(`expected-track-visibility.json: track ${t} must be a list of stage ids`);
    }
    const q = perTrack?.[t];
    if (typeof q !== 'number') {
      throw new TypeError(
        `expected-track-visibility.json: questionsPerTrack.${t} must be a number`,
      );
    }
    stages[t] = list as string[];
    questionsPerTrack[t] = q;
  }
  return { stages, questionsPerTrack };
}

// ---------------------------------------------------------------------------
// The gate rule, in the same words as server-side gate(): sequential through
// the account's visible list.
// ---------------------------------------------------------------------------

export type StageState = 'done' | 'available' | 'locked';

export interface VisibleStage {
  position: number;
  stageId: string;
  code: string;
}

export function stageStates(
  visible: readonly VisibleStage[],
  completedStageIds: ReadonlySet<string>,
): StageState[] {
  return visible.map((s, i) => {
    if (completedStageIds.has(s.stageId)) return 'done';
    const prev = visible[i - 1];
    const unlocked = i === 0 || (prev !== undefined && completedStageIds.has(prev.stageId));
    return unlocked ? 'available' : 'locked';
  });
}

// ---------------------------------------------------------------------------
// Database reads
// ---------------------------------------------------------------------------

interface VisibilityRow {
  track_code: string;
  position: number;
  stage_id: string;
  code: string;
}

interface CountRow {
  stage_id: string;
  n: number;
}

interface AccountRow {
  id: string;
  email: string;
  track: string | null;
  status: string;
  is_disabled: boolean;
}

interface CompletionRow {
  trainee_id: string;
  stage_id: string;
}

export interface SweepData {
  visible: Map<DevTrack, VisibleStage[]>;
  lessonsPerStage: Map<string, number>;
  questionsPerStage: Map<string, number>;
  quizPerStage: Set<string>;
  accounts: Map<string, AccountRow>;
  completions: Map<string, Set<string>>;
}

export async function readSweepData(db: Queryable): Promise<SweepData> {
  const vis = await db.query<VisibilityRow>(
    `SELECT tv.track_code, tv.position, s.id::text AS stage_id, s.code
       FROM academy.track_visibility tv
       JOIN academy.stages s ON s.id = tv.stage_id
      ORDER BY tv.track_code, tv.position`,
  );
  const visible = new Map<DevTrack, VisibleStage[]>(DEV_TRACKS.map((t) => [t, []]));
  for (const r of vis.rows) {
    visible
      .get(r.track_code as DevTrack)
      ?.push({ position: r.position, stageId: r.stage_id, code: r.code });
  }

  const lessons = await db.query<CountRow>(
    `SELECT stage_id::text AS stage_id, count(*)::int AS n
       FROM academy.lessons GROUP BY stage_id`,
  );
  // Only questions the API would serve: active and approved.
  const questions = await db.query<CountRow>(
    `SELECT z.stage_id::text AS stage_id, count(qn.id)::int AS n
       FROM academy.quizzes z
       LEFT JOIN academy.questions qn
              ON qn.quiz_id = z.id AND qn.is_active AND qn.approval_state = 'APPROVED'
      GROUP BY z.stage_id`,
  );
  const quizzes = await db.query<{ stage_id: string }>(
    'SELECT stage_id::text AS stage_id FROM academy.quizzes',
  );

  const emails = DEV_TRACK_ACCOUNTS.map((a) => a.email);
  const accountRows = await db.query<AccountRow>(
    `SELECT id::text AS id, email::text AS email, track, status, is_disabled
       FROM academy.trainees WHERE email = ANY($1::citext[])`,
    [emails],
  );
  const accounts = new Map(accountRows.rows.map((r) => [r.email.toLowerCase(), r]));

  const ids = accountRows.rows.map((r) => r.id);
  const completionRows =
    ids.length === 0
      ? { rows: [] as CompletionRow[] }
      : await db.query<CompletionRow>(
          `SELECT trainee_id::text AS trainee_id, stage_id::text AS stage_id
             FROM academy.stage_completions WHERE trainee_id = ANY($1::bigint[])`,
          [ids],
        );
  const completions = new Map<string, Set<string>>(ids.map((id) => [id, new Set<string>()]));
  for (const r of completionRows.rows) completions.get(r.trainee_id)?.add(r.stage_id);

  return {
    visible,
    lessonsPerStage: new Map(lessons.rows.map((r) => [r.stage_id, r.n])),
    questionsPerStage: new Map(questions.rows.map((r) => [r.stage_id, r.n])),
    quizPerStage: new Set(quizzes.rows.map((r) => r.stage_id)),
    accounts,
    completions,
  };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function sameList(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((v, i) => v === b[i]);
}

async function main(): Promise<number> {
  const args = parseTrackSweepArgs(process.argv.slice(2));
  if (args === 'help') {
    console.log(TRACK_SWEEP_USAGE);
    return 0;
  }
  const fixture = loadTrackFixture();
  const client = await connectDev(args.expectDb, 'academy-track-sweep');
  const checks: Check[] = [];
  const add = (id: string, item: string, pass: boolean, evidence: string): void => {
    checks.push({ id, item, pass, evidence });
  };

  try {
    console.log(
      `API base URL for the Section 04 tests: ${args.baseUrl} ` +
        '(not contacted: this sweep reads the database)',
    );
    const data = await readSweepData(client);

    // ---- 0. the developer accounts ------------------------------------------
    const accountTable: (string | number)[][] = [];
    let accountsOk = true;
    for (const a of DEV_TRACK_ACCOUNTS) {
      const row = data.accounts.get(a.email.toLowerCase());
      const ok =
        row !== undefined &&
        row.track === a.track &&
        row.status === 'ACTIVE' &&
        row.is_disabled === false;
      if (!ok) accountsOk = false;
      accountTable.push([
        a.email,
        a.track,
        row?.id ?? '(missing)',
        row?.track ?? '-',
        row?.status ?? '-',
        row === undefined ? '-' : row.is_disabled ? 'yes' : 'no',
        ok ? 'ok' : 'MISMATCH',
      ]);
    }
    console.log(
      '\n0. Developer accounts, one per track\n' +
        table(
          ['email', 'expected track', 'trainee id', 'DB track', 'status', 'disabled', ''],
          accountTable,
        ),
    );
    add(
      '0',
      'One ACTIVE account per track exists, with that track set',
      accountsOk,
      accountsOk
        ? `${DEV_TRACK_ACCOUNTS.length}/${DEV_TRACK_ACCOUNTS.length} accounts ready`
        : 'run: npx tsx ops/dev/seed-test-accounts.ts --expect-db ' + args.expectDb,
    );

    // ---- 1. visible stage list per track ------------------------------------
    const listTable: (string | number)[][] = [];
    let listOk = true;
    for (const t of DEV_TRACKS) {
      const dbList = (data.visible.get(t) ?? []).map((s) => s.code);
      const fixList = fixture.stages[t];
      const positions = (data.visible.get(t) ?? []).map((s) => s.position);
      const inOrder = positions.every((p, i) => p === i + 1);
      const diff = dbList.filter((c, i) => fixList[i] !== c).length;
      const ok = sameList(dbList, fixList) && inOrder;
      if (!ok) listOk = false;
      listTable.push([
        t,
        dbList.length,
        fixList.length,
        diff,
        inOrder ? '1..n' : 'GAPS',
        ok ? 'PASS' : 'FAIL',
      ]);
      if (!ok) {
        console.log(`  ${t} DB     : ${dbList.join(' ')}`);
        console.log(`  ${t} fixture: ${fixList.join(' ')}`);
      }
    }
    console.log(
      '\n1. Visible stage list per track (academy.track_visibility vs the §1 fixture)\n' +
        table(['track', 'DB stages', 'fixture stages', 'diff', 'positions', 'result'], listTable),
    );
    add(
      '1',
      'Per track: the API stage list equals the fixture, same order, zero diff',
      listOk,
      `${listTable.filter((r) => r[5] === 'PASS').length}/9 tracks identical; ` +
        `${listTable.reduce((n, r) => n + Number(r[1]), 0)} DB rows vs ` +
        `${listTable.reduce((n, r) => n + Number(r[2]), 0)} fixture entries`,
    );

    // ---- 2. fresh-account gating --------------------------------------------
    const gateTable: (string | number)[][] = [];
    let gateOk = accountsOk;
    for (const a of DEV_TRACK_ACCOUNTS) {
      const row = data.accounts.get(a.email.toLowerCase());
      const visible = data.visible.get(a.track) ?? [];
      const done = row ? (data.completions.get(row.id) ?? new Set<string>()) : new Set<string>();
      const states = stageStates(visible, done);
      const counts = {
        done: states.filter((s) => s === 'done').length,
        available: states.filter((s) => s === 'available').length,
        locked: states.filter((s) => s === 'locked').length,
      };
      const firstAvailable = visible[states.indexOf('available')]?.code ?? '(none)';
      const expectedFirst = visible[0]?.code ?? '(none)';
      const ok =
        row !== undefined &&
        counts.done === 0 &&
        counts.available === 1 &&
        counts.locked === visible.length - 1 &&
        firstAvailable === expectedFirst;
      if (!ok) gateOk = false;
      gateTable.push([
        a.track,
        visible.length,
        counts.done,
        counts.available,
        counts.locked,
        firstAvailable,
        ok ? 'PASS' : 'FAIL',
      ]);
    }
    console.log(
      '\n2. Fresh account: exactly one stage available, every other stage locked\n' +
        table(
          ['track', 'visible', 'done', 'available', 'locked', 'available stage', 'result'],
          gateTable,
        ),
    );
    add(
      '2',
      'Per track: exactly 1 stage available on a fresh account, all others locked',
      gateOk,
      `${gateTable.filter((r) => r[6] === 'PASS').length}/9 accounts; ` +
        `${gateTable.reduce((n, r) => n + Number(r[3]), 0)} available and ` +
        `${gateTable.reduce((n, r) => n + Number(r[4]), 0)} locked stages in total`,
    );

    // ---- 3. questions per track ---------------------------------------------
    const qTable: (string | number)[][] = [];
    let qOk = true;
    for (const t of DEV_TRACKS) {
      const visible = data.visible.get(t) ?? [];
      const dbQ = visible.reduce((n, s) => n + (data.questionsPerStage.get(s.stageId) ?? 0), 0);
      const plan = fixture.questionsPerTrack[t];
      const missingQuiz = visible.filter((s) => !data.quizPerStage.has(s.stageId)).length;
      const ok = dbQ === plan && missingQuiz === 0;
      if (!ok) qOk = false;
      qTable.push([t, visible.length, dbQ, plan, missingQuiz, ok ? 'PASS' : 'FAIL']);
    }
    console.log(
      '\n3. Questions per track (active, approved) vs the PROJECT-PLAN §1 table\n' +
        table(
          ['track', 'stages', 'DB questions', 'plan', 'stages without a quiz', 'result'],
          qTable,
        ),
    );
    add(
      '3',
      'Per track: question total equals the PROJECT-PLAN §1 table',
      qOk,
      DEV_TRACKS.map((t, i) => `${t} ${qTable[i]?.[2] ?? '?'}`).join(', '),
    );

    // ---- 4. locked sweep ------------------------------------------------------
    // What the API must refuse for a fresh account, per locked stage:
    //   GET  /api/stage/<code>           → 403 {locked:true}
    //   GET  /api/stage/<code>/quiz      → 403
    //   POST /api/stage/<code>/quiz      → 403
    //   POST /api/lesson/<id>/read       → 403, once per lesson in that stage
    const sweepTable: (string | number)[][] = [];
    const totals = { locked: 0, stage: 0, quizGet: 0, quizPost: 0, lesson: 0, all: 0 };
    let sweepOk = accountsOk;
    for (const a of DEV_TRACK_ACCOUNTS) {
      const row = data.accounts.get(a.email.toLowerCase());
      const visible = data.visible.get(a.track) ?? [];
      const done = row ? (data.completions.get(row.id) ?? new Set<string>()) : new Set<string>();
      const states = stageStates(visible, done);
      const locked = visible.filter((_s, i) => states[i] === 'locked');
      const lockedLessons = locked.reduce(
        (n, s) => n + (data.lessonsPerStage.get(s.stageId) ?? 0),
        0,
      );
      const subtotal = locked.length * 3 + lockedLessons;
      if (row === undefined || locked.length !== visible.length - 1) sweepOk = false;
      totals.locked += locked.length;
      totals.stage += locked.length;
      totals.quizGet += locked.length;
      totals.quizPost += locked.length;
      totals.lesson += lockedLessons;
      totals.all += subtotal;
      sweepTable.push([
        a.track,
        locked.length,
        locked.length,
        locked.length,
        locked.length,
        lockedLessons,
        subtotal,
      ]);
    }
    sweepTable.push([
      'TOTAL',
      totals.locked,
      totals.stage,
      totals.quizGet,
      totals.quizPost,
      totals.lesson,
      totals.all,
    ]);
    console.log(
      '\n4. Locked sweep: requests the API must refuse (403) for the 9 fresh accounts\n' +
        table(
          [
            'track',
            'locked stages',
            'GET stage',
            'GET quiz',
            'POST quiz',
            'POST lesson read',
            'subtotal',
          ],
          sweepTable,
        ),
    );
    add(
      '4',
      'Locked sweep total across the 9 accounts (the number the API test asserts)',
      sweepOk && totals.all > 0,
      `${totals.all} refusals = ${totals.locked} locked stages x 3 (stage, quiz GET, quiz POST) ` +
        `+ ${totals.lesson} lessons in locked stages`,
    );
  } finally {
    await client.end().catch(() => undefined);
  }

  return summarise('track-sweep', 'CHECKLIST 04 evidence (stage lists and locks)', checks);
}

runIfMain(import.meta.url, 'track-sweep', main);
