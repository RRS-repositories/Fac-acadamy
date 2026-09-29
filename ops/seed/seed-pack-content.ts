// Loads a content pack into the academy schema: a training module the
// prototype never described.
//
//   npx tsx ops/seed/seed-pack-content.ts --expect-db <name> [--commit]
//   ... --confirm-production     (only when <name> is the live database)
//
// It is the prototype seed's twin, and deliberately so — same wrong-database
// guard, one transaction, upserts on stable keys, output that is counts and ids
// only, and nothing is ever deleted. Two differences:
//
//   * it is a DRY RUN by default. ops/seed/seed-content.ts commits unless told
//     not to, because it re-writes content that is already there. This one adds
//     a module, so the safe default is to show what it would do.
//   * it needs migration 0012, because it marks every row it writes
//     content_source = 'PACK'.
//
// PLACEMENT. A pack stage says where it goes ("position 2 in ADMIN"), and the
// stages already at or after that position move down, badge and all. The
// prototype seed then steps over the slot this one took instead of writing over
// it — the two agree by construction, and the proof is that running the
// prototype seed straight afterwards reports 0 rows written.
//
// Data hygiene: the pack itself lives OUTSIDE this repo, behind
// CONTENT_PACK_PATH, exactly like the prototype. Nothing this script prints
// contains lesson text, a question, an answer, a client or a member of staff.

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import pg from 'pg';
import { loadDotenvIfPresent } from '../../server/src/config/dotenv.js';
import { DbSettingsSchema, pgConfig } from '../../server/src/db/connection.js';
import { isProductionDbName, productionReason } from '../lib/production-db.js';
import { ContentPackError, loadContentPack, type ContentPack } from './content-pack.js';

export class PackSeedError extends Error {
  override name = 'PackSeedError';
}

// ---------------------------------------------------------------------------
// Placement
// ---------------------------------------------------------------------------

export interface Placed {
  code: string;
  position: number;
  displayNum: string;
}

/**
 * Every prototype badge is its own position written out ('1', '8', 'A2',
 * 'IT1'), so a stage that moves takes its number with it and nothing else about
 * the string changes. A badge with no trailing number is left alone.
 *
 * This is the same rule ops/seed/seed-content.ts applies when it steps over an
 * occupied slot, which is why the two seeds agree on the finished layout.
 */
export function renumberBadge(displayNum: string, position: number): string {
  return /\d+$/.test(displayNum) ? displayNum.replace(/\d+$/, String(position)) : displayNum;
}

/**
 * The finished order of one group — one department, or one track — after the
 * pack's stages have been slotted into it.
 *
 * `existing` is what is already there, WITHOUT the pack's own stages, in
 * position order. `inserts` say where they want to be, 1-based. Positions come
 * out dense (1..n) so nothing depends on the numbers, only on the order.
 */
export function layoutGroup(existing: readonly Placed[], inserts: readonly Placed[]): Placed[] {
  const list = [...existing].sort((a, b) => a.position - b.position);
  for (const ins of [...inserts].sort((a, b) => a.position - b.position)) {
    const at = Math.min(Math.max(ins.position - 1, 0), list.length);
    list.splice(at, 0, ins);
  }
  return list.map((s, i) => ({
    code: s.code,
    position: i + 1,
    displayNum: renumberBadge(s.displayNum, i + 1),
  }));
}

/**
 * Applies position changes in an order that never collides.
 *
 * `stages (dept, position)` is a plain UNIQUE index, not a deferred constraint,
 * so two rows may not share a position even for the length of one statement.
 * Rather than guess an order, this takes whichever move lands on a slot that is
 * free right now, and repeats. Inserting in the middle always resolves (the
 * last stage moves down first). Anything that cannot resolve — a true rotation —
 * stops with a message instead of a constraint violation halfway through.
 */
export function orderMoves(
  current: ReadonlyMap<string, number>,
  target: ReadonlyMap<string, number>,
): string[] {
  const held = new Map<number, string>();
  for (const [code, pos] of current) held.set(pos, code);
  const todo = [...target.keys()].filter((c) => current.has(c) && current.get(c) !== target.get(c));
  const order: string[] = [];
  while (todo.length > 0) {
    const i = todo.findIndex((c) => {
      const want = target.get(c)!;
      const occupant = held.get(want);
      return occupant === undefined || occupant === c;
    });
    if (i === -1) {
      throw new PackSeedError(
        `Cannot renumber ${todo.join(' ')} without two stages sharing a position. ` +
          'Move them by hand, or give the pack a position at the end of the group.',
      );
    }
    const code = todo.splice(i, 1)[0]!;
    held.delete(current.get(code)!);
    held.set(target.get(code)!, code);
    order.push(code);
  }
  return order;
}

// ---------------------------------------------------------------------------
// Counters
// ---------------------------------------------------------------------------

const TABLES = [
  'stages',
  'lessons',
  'quizzes',
  'questions',
  'question_options',
  'track_visibility',
] as const;
type Table = (typeof TABLES)[number];

interface Tally {
  source: number;
  inserted: number;
  updated: number;
  unchanged: number;
  stale: number;
}

function newTallies(): Record<Table, Tally> {
  return Object.fromEntries(
    TABLES.map((t) => [t, { source: 0, inserted: 0, updated: 0, unchanged: 0, stale: 0 }]),
  ) as Record<Table, Tally>;
}

async function upsert(
  client: pg.ClientBase,
  tally: Tally,
  sql: string,
  params: unknown[],
  lookup?: { sql: string; params: unknown[] },
): Promise<string | null> {
  tally.source++;
  const res = await client.query<{ id: string | null; inserted: boolean }>(sql, params);
  const row = res.rows[0];
  if (row) {
    if (row.inserted) tally.inserted++;
    else tally.updated++;
    return row.id;
  }
  tally.unchanged++;
  if (!lookup) return null;
  const found = await client.query<{ id: string }>(lookup.sql, lookup.params);
  const id = found.rows[0]?.id;
  if (id === undefined)
    throw new PackSeedError('Upsert matched a row that the lookup cannot find.');
  return id;
}

// ---------------------------------------------------------------------------
// The seed
// ---------------------------------------------------------------------------

export interface PackSeedResult {
  tallies: Record<Table, Tally>;
  moved: { code: string; from: number; to: number; badge: string }[];
  perStage: { code: string; lessons: number; questions: number; passMark: number }[];
  checks: { label: string; ok: boolean; detail: string }[];
}

interface DbStage {
  id: string;
  code: string;
  position: number;
  display_num: string | null;
}

export async function seedPack(client: pg.ClientBase, pack: ContentPack): Promise<PackSeedResult> {
  const t = newTallies();
  const packCodes = pack.stages.map((s) => s.code);
  const moved: PackSeedResult['moved'] = [];

  await assertContentSourceColumn(client);

  // -- 1. Make room inside each department the pack writes into ---------------
  for (const dept of [...new Set(pack.stages.map((s) => s.dept))]) {
    const { rows } = await client.query<DbStage>(
      `SELECT id::text, code, position, display_num FROM academy.stages
        WHERE dept = $1 AND level_id IS NULL AND NOT (code = ANY($2::text[]))
        ORDER BY position`,
      [dept, packCodes],
    );
    if (rows.length === 0) {
      throw new PackSeedError(`Department ${dept} has no stages: check departments.code.`);
    }
    const inserts = pack.stages
      .filter((s) => s.dept === dept)
      .map((s) => ({ code: s.code, position: s.position, displayNum: s.displayNum }));
    const layout = layoutGroup(
      rows.map((r) => ({
        code: r.code,
        position: Number(r.position),
        displayNum: r.display_num ?? '',
      })),
      inserts,
    );
    await applyStageLayout(client, dept, rows, layout, packCodes, moved);
  }

  // -- 2. The pack's own stages, lessons, quiz and questions ------------------
  const perStage: PackSeedResult['perStage'] = [];
  for (const s of pack.stages) {
    const finalPosition = await positionFor(client, s.dept, s.code, s.position);
    const stageId = await upsert(
      client,
      t.stages,
      `INSERT INTO academy.stages
         (code, level_id, dept, display_num, position, sort, title, blurb, track, pass_mark,
          content_source)
       VALUES ($1, NULL, $2, $3, $4, $5, $6, $7, $8, $9, 'PACK')
       ON CONFLICT (code) DO UPDATE
         SET dept = EXCLUDED.dept, display_num = EXCLUDED.display_num,
             position = EXCLUDED.position, sort = EXCLUDED.sort, title = EXCLUDED.title,
             blurb = EXCLUDED.blurb, track = EXCLUDED.track, pass_mark = EXCLUDED.pass_mark,
             content_source = 'PACK'
       WHERE (stages.dept, stages.display_num, stages.position, stages.sort, stages.title,
              stages.blurb, stages.track, stages.pass_mark, stages.content_source)
             IS DISTINCT FROM
             (EXCLUDED.dept, EXCLUDED.display_num, EXCLUDED.position, EXCLUDED.sort,
              EXCLUDED.title, EXCLUDED.blurb, EXCLUDED.track, EXCLUDED.pass_mark, 'PACK')
       RETURNING id, (xmax = 0) AS inserted`,
      [
        s.code,
        s.dept,
        renumberBadge(s.displayNum, finalPosition),
        finalPosition,
        s.sort,
        s.title,
        s.blurb,
        s.dept,
        s.passMark,
      ],
      { sql: 'SELECT id FROM academy.stages WHERE code = $1', params: [s.code] },
    );

    for (const [i, l] of s.lessons.entries()) {
      await upsert(
        client,
        t.lessons,
        `INSERT INTO academy.lessons (stage_id, position, title, body_html, content_source)
         VALUES ($1, $2, $3, $4, 'PACK')
         ON CONFLICT (stage_id, position) DO UPDATE
           SET title = EXCLUDED.title, body_html = EXCLUDED.body_html,
               content_source = 'PACK', version = lessons.version + 1, updated_at = now()
         WHERE (lessons.title, lessons.body_html, lessons.content_source)
               IS DISTINCT FROM (EXCLUDED.title, EXCLUDED.body_html, 'PACK')
         RETURNING id, (xmax = 0) AS inserted`,
        [stageId, i + 1, l.title, l.bodyHtml],
      );
    }

    const quizId = await upsert(
      client,
      t.quizzes,
      `INSERT INTO academy.quizzes (stage_id, pass_mark, shuffle, question_count)
       VALUES ($1, $2, FALSE, NULL)
       ON CONFLICT (stage_id) DO UPDATE
         SET pass_mark = EXCLUDED.pass_mark, shuffle = FALSE, question_count = NULL
       WHERE (quizzes.pass_mark, quizzes.shuffle, quizzes.question_count)
             IS DISTINCT FROM (EXCLUDED.pass_mark, FALSE, NULL::smallint)
       RETURNING id, (xmax = 0) AS inserted`,
      [stageId, s.quiz.passMark],
      { sql: 'SELECT id FROM academy.quizzes WHERE stage_id = $1', params: [stageId] },
    );

    for (const [qi, q] of s.quiz.questions.entries()) {
      // HUMAN / APPROVED / active, the same values the prototype seed writes:
      // the runtime only ever serves a question that is both, and 0001's
      // ai_questions_need_approval CHECK is satisfied either way.
      const questionId = await upsert(
        client,
        t.questions,
        `INSERT INTO academy.questions
           (quiz_id, position, prompt, source, approval_state, approved_at, is_active,
            content_source)
         VALUES ($1, $2, $3, 'HUMAN', 'APPROVED', now(), TRUE, 'PACK')
         ON CONFLICT (quiz_id, position) DO UPDATE
           SET prompt = EXCLUDED.prompt, source = 'HUMAN', approval_state = 'APPROVED',
               is_active = TRUE, content_source = 'PACK'
         WHERE (questions.prompt, questions.source, questions.approval_state,
                questions.is_active, questions.content_source)
               IS DISTINCT FROM (EXCLUDED.prompt, 'HUMAN', 'APPROVED', TRUE, 'PACK')
         RETURNING id, (xmax = 0) AS inserted`,
        [quizId, qi + 1, q.prompt],
        {
          sql: 'SELECT id FROM academy.questions WHERE quiz_id = $1 AND position = $2',
          params: [quizId, qi + 1],
        },
      );
      for (const [oi, body] of q.options.entries()) {
        await upsert(
          client,
          t.question_options,
          `INSERT INTO academy.question_options (question_id, position, body, is_correct)
           VALUES ($1, $2, $3, $4)
           ON CONFLICT (question_id, position) DO UPDATE
             SET body = EXCLUDED.body, is_correct = EXCLUDED.is_correct
           WHERE (question_options.body, question_options.is_correct)
                 IS DISTINCT FROM (EXCLUDED.body, EXCLUDED.is_correct)
           RETURNING id, (xmax = 0) AS inserted`,
          [questionId, oi + 1, body, oi === q.correctIndex],
        );
      }
    }

    // Rows the pack no longer has. Reported, never deleted — a trainee's
    // lesson_progress and quiz_attempts point at them.
    t.lessons.stale += await count(
      client,
      'SELECT count(*) AS n FROM academy.lessons WHERE stage_id = $1 AND position > $2',
      [stageId, s.lessons.length],
    );
    t.questions.stale += await count(
      client,
      `SELECT count(*) AS n FROM academy.questions
        WHERE quiz_id = $1 AND position IS NOT NULL AND position > $2`,
      [quizId, s.quiz.questions.length],
    );

    perStage.push({
      code: s.code,
      lessons: s.lessons.length,
      questions: s.quiz.questions.length,
      passMark: s.quiz.passMark,
    });
  }

  // -- 3. Track visibility ----------------------------------------------------
  const tracks = [...new Set(pack.stages.flatMap((s) => s.visibility.map((v) => v.track)))];
  for (const track of tracks) {
    const { rows } = await client.query<{ code: string; position: number }>(
      `SELECT s.code, v.position FROM academy.track_visibility v
         JOIN academy.stages s ON s.id = v.stage_id
        WHERE v.track_code = $1 AND NOT (s.code = ANY($2::text[]))
        ORDER BY v.position`,
      [track, packCodes],
    );
    const inserts = pack.stages.flatMap((s) => {
      const v = s.visibility.find((x) => x.track === track);
      return v === undefined ? [] : [{ code: s.code, position: v.position, displayNum: '' }];
    });
    const layout = layoutGroup(
      rows.map((r) => ({ code: r.code, position: Number(r.position), displayNum: '' })),
      inserts,
    );
    await applyVisibilityLayout(client, track, rows, layout, packCodes, t.track_visibility);
  }

  return { tallies: t, moved, perStage, checks: await verifyPack(client, pack) };
}

async function count(client: pg.ClientBase, sql: string, params: unknown[]): Promise<number> {
  const r = await client.query<{ n: string }>(sql, params);
  return Number(r.rows[0]?.n ?? 0);
}

/** 0012 has to be applied first: every row this seeder writes is marked PACK. */
async function assertContentSourceColumn(client: pg.ClientBase): Promise<void> {
  const { rows } = await client.query<{ table_name: string }>(
    `SELECT table_name FROM information_schema.columns
      WHERE table_schema = 'academy' AND column_name = 'content_source'
        AND table_name IN ('stages', 'lessons', 'questions')`,
  );
  const have = new Set(rows.map((r) => r.table_name));
  const missing = ['stages', 'lessons', 'questions'].filter((t) => !have.has(t));
  if (missing.length > 0) {
    throw new PackSeedError(
      `academy.${missing.join(', academy.')} has no content_source column: ` +
        'apply migration 0012_content_source.sql first.',
    );
  }
}

/** Moves the stages already in a department down to make room for the pack's. */
async function applyStageLayout(
  client: pg.ClientBase,
  dept: string,
  existing: readonly DbStage[],
  layout: readonly Placed[],
  packCodes: readonly string[],
  moved: PackSeedResult['moved'],
): Promise<void> {
  const current = new Map(existing.map((r) => [r.code, Number(r.position)]));
  const target = new Map(
    layout.filter((p) => !packCodes.includes(p.code)).map((p) => [p.code, p.position]),
  );
  const badge = new Map(layout.map((p) => [p.code, p.displayNum]));
  for (const code of orderMoves(current, target)) {
    const to = target.get(code)!;
    const res = await client.query(
      `UPDATE academy.stages SET position = $2, display_num = $3
        WHERE code = $1 AND dept = $4 AND (position, display_num) IS DISTINCT FROM ($2, $3)`,
      [code, to, badge.get(code) ?? null, dept],
    );
    if (res.rowCount) {
      moved.push({ code, from: current.get(code)!, to, badge: badge.get(code) ?? '' });
    }
  }
  // A badge can need rewriting without the position changing (a re-run after a
  // half-finished one). Cheap to make certain.
  for (const p of layout) {
    if (packCodes.includes(p.code)) continue;
    await client.query(
      `UPDATE academy.stages SET display_num = $2
        WHERE code = $1 AND display_num IS DISTINCT FROM $2`,
      [p.code, p.displayNum],
    );
  }
}

/** The position the pack stage ends up at, after the group has been laid out. */
async function positionFor(
  client: pg.ClientBase,
  dept: string,
  code: string,
  wanted: number,
): Promise<number> {
  const { rows } = await client.query<{ position: number }>(
    `SELECT position FROM academy.stages
      WHERE dept = $1 AND level_id IS NULL AND code <> $2 ORDER BY position`,
    [dept, code],
  );
  const taken = new Set(rows.map((r) => Number(r.position)));
  let p = Math.max(1, wanted);
  while (taken.has(p)) p++;
  return p;
}

async function applyVisibilityLayout(
  client: pg.ClientBase,
  track: string,
  existing: readonly { code: string; position: number }[],
  layout: readonly Placed[],
  packCodes: readonly string[],
  tally: Tally,
): Promise<void> {
  // track_visibility_position_key is DEFERRABLE INITIALLY DEFERRED, so the whole
  // track can be renumbered inside this transaction without an ordering dance.
  for (const p of layout) {
    if (packCodes.includes(p.code)) continue;
    const was = existing.find((e) => e.code === p.code);
    if (was !== undefined && Number(was.position) === p.position) continue;
    await client.query(
      `UPDATE academy.track_visibility v SET position = $3
         FROM academy.stages s
        WHERE s.id = v.stage_id AND v.track_code = $1 AND s.code = $2`,
      [track, p.code, p.position],
    );
  }
  for (const p of layout) {
    if (!packCodes.includes(p.code)) continue;
    await upsert(
      client,
      tally,
      `INSERT INTO academy.track_visibility (track_code, stage_id, position)
       SELECT $1, s.id, $3 FROM academy.stages s WHERE s.code = $2
       ON CONFLICT (track_code, stage_id) DO UPDATE SET position = EXCLUDED.position
       WHERE track_visibility.position IS DISTINCT FROM EXCLUDED.position
       RETURNING NULL::bigint AS id, (xmax = 0) AS inserted`,
      [track, p.code, p.position],
    );
  }
}

// ---------------------------------------------------------------------------
// Checks
// ---------------------------------------------------------------------------

/** Reads back what was written and compares it with the pack. */
async function verifyPack(
  client: pg.ClientBase,
  pack: ContentPack,
): Promise<PackSeedResult['checks']> {
  const checks: PackSeedResult['checks'] = [];
  const add = (label: string, ok: boolean, detail: string) => checks.push({ label, ok, detail });
  const codes = pack.stages.map((s) => s.code);

  for (const s of pack.stages) {
    const lessons = await count(
      client,
      `SELECT count(*) AS n FROM academy.lessons l JOIN academy.stages st ON st.id = l.stage_id
        WHERE st.code = $1`,
      [s.code],
    );
    const questions = await count(
      client,
      `SELECT count(*) AS n FROM academy.questions q JOIN academy.quizzes z ON z.id = q.quiz_id
         JOIN academy.stages st ON st.id = z.stage_id
        WHERE st.code = $1 AND q.position IS NOT NULL`,
      [s.code],
    );
    const badOptions = await count(
      client,
      `SELECT count(*) AS n FROM (
         SELECT q.id FROM academy.questions q
           JOIN academy.quizzes z ON z.id = q.quiz_id
           JOIN academy.stages st ON st.id = z.stage_id
           LEFT JOIN academy.question_options o ON o.question_id = q.id
          WHERE st.code = $1
          GROUP BY q.id
         HAVING count(o.id) <> 4 OR count(o.id) FILTER (WHERE o.is_correct) <> 1) z`,
      [s.code],
    );
    add(
      `${s.code} lessons`,
      lessons === s.lessons.length,
      `db ${lessons} / pack ${s.lessons.length}`,
    );
    add(
      `${s.code} questions`,
      questions === s.quiz.questions.length,
      `db ${questions} / pack ${s.quiz.questions.length}`,
    );
    add(`${s.code} 4 options, 1 correct`, badOptions === 0, `${badOptions} bad`);

    for (const v of s.visibility) {
      const { rows } = await client.query<{ code: string }>(
        `SELECT s2.code FROM academy.track_visibility tv
           JOIN academy.stages s2 ON s2.id = tv.stage_id
          WHERE tv.track_code = $1 ORDER BY tv.position`,
        [v.track],
      );
      const at = rows.findIndex((r) => r.code === s.code) + 1;
      add(
        `${s.code} visible to ${v.track} at ${v.position}`,
        at === v.position,
        at === 0 ? 'not visible' : `position ${at} of ${rows.length}`,
      );
    }
  }

  // Positions are dense and unique everywhere the pack touched. A gap or a
  // repeat here is the thing that would break the gate, so it is checked
  // against the database rather than against the layout that produced it.
  for (const dept of [...new Set(pack.stages.map((s) => s.dept))]) {
    const { rows } = await client.query<{ position: number }>(
      'SELECT position FROM academy.stages WHERE dept = $1 AND level_id IS NULL ORDER BY position',
      [dept],
    );
    const dense = rows.every((r, i) => Number(r.position) === i + 1);
    add(`${dept} stage positions 1..${rows.length}`, dense, dense ? 'dense' : 'GAP OR REPEAT');
  }
  for (const track of [...new Set(pack.stages.flatMap((s) => s.visibility.map((v) => v.track)))]) {
    const { rows } = await client.query<{ position: number }>(
      'SELECT position FROM academy.track_visibility WHERE track_code = $1 ORDER BY position',
      [track],
    );
    const dense = rows.every((r, i) => Number(r.position) === i + 1);
    add(
      `${track} visibility positions 1..${rows.length}`,
      dense,
      dense ? 'dense' : 'GAP OR REPEAT',
    );
  }

  const marked = await count(
    client,
    `SELECT count(*) AS n FROM academy.stages WHERE code = ANY($1::text[]) AND content_source = 'PACK'`,
    [codes],
  );
  add('stages marked content_source = PACK', marked === codes.length, `${marked}/${codes.length}`);
  return checks;
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function printTable(head: string[], rows: string[][]): void {
  const widths = head.map((h, i) => Math.max(h.length, ...rows.map((r) => (r[i] ?? '').length)));
  const line = (cells: string[]) =>
    cells.map((c, i) => (i === 0 ? c.padEnd(widths[i]!) : c.padStart(widths[i]!))).join('  ');
  console.log(line(head));
  console.log(widths.map((w) => '-'.repeat(w)).join('  '));
  for (const r of rows) console.log(line(r));
}

function printResult(res: PackSeedResult, dryRun: boolean): void {
  printTable(
    ['table', 'source', 'inserted', 'updated', 'unchanged', 'stale (kept)'],
    TABLES.map((name) => {
      const x = res.tallies[name];
      return [name, x.source, x.inserted, x.updated, x.unchanged, x.stale].map(String);
    }),
  );
  console.log('');
  printTable(
    ['stage', 'lessons', 'questions', 'pass mark'],
    res.perStage.map((s) => [s.code, s.lessons, s.questions, s.passMark].map(String)),
  );
  if (res.moved.length > 0) {
    console.log('');
    printTable(
      ['renumbered', 'from', 'to', 'badge'],
      res.moved.map((m) => [m.code, m.from, m.to, m.badge].map(String)),
    );
  }
  console.log('');
  printTable(
    ['check', 'result', 'detail'],
    res.checks.map((c) => [c.label, c.ok ? 'PASS' : 'FAIL', c.detail]),
  );
  const changed = TABLES.reduce((a, n) => a + res.tallies[n].inserted + res.tallies[n].updated, 0);
  console.log('');
  console.log(
    `Rows written: ${changed}, stages renumbered: ${res.moved.length}. ` +
      (dryRun ? 'DRY RUN: rolled back. Add --commit to apply.' : 'Committed.'),
  );
}

async function main(): Promise<number> {
  const { values } = parseArgs({
    args: process.argv.slice(2),
    strict: true,
    allowPositionals: false,
    options: {
      commit: { type: 'boolean', default: false },
      'expect-db': { type: 'string' },
      'confirm-production': { type: 'boolean', default: false },
      help: { type: 'boolean', short: 'h', default: false },
    },
  });
  if (values.help) {
    console.log(
      'Usage: seed-pack-content --expect-db <database name> [--commit] [--confirm-production]',
    );
    return 0;
  }
  const expectDb = values['expect-db'];
  if (!expectDb) {
    throw new PackSeedError('--expect-db <database name> is required (wrong-database guard).');
  }
  const dryRun = values.commit !== true;
  if (isProductionDbName(expectDb) && values['confirm-production'] !== true) {
    throw new PackSeedError(
      `Refusing: ${productionReason(expectDb)}. Adding a module to the live academy needs ` +
        '--confirm-production as well as --expect-db.',
    );
  }

  loadDotenvIfPresent();
  const parsed = DbSettingsSchema.safeParse(process.env);
  if (!parsed.success) {
    const names = [...new Set(parsed.error.issues.map((i) => String(i.path[0])))];
    throw new PackSeedError(`Missing or invalid database settings: ${names.join(', ')}.`);
  }

  const pack = loadContentPack();
  console.log(
    `Content pack "${pack.packId}" v${pack.packVersion}: ${pack.stages.length} stage(s), ` +
      `${pack.stages.reduce((n, s) => n + s.lessons.length, 0)} lesson(s), ` +
      `${pack.stages.reduce((n, s) => n + s.quiz.questions.length, 0)} question(s).`,
  );
  console.log(`  ${pack.summary}`);

  const client = new pg.Client(
    pgConfig(parsed.data, { applicationName: 'academy-seed-pack', statementTimeoutMs: 60_000 }),
  );
  await client.connect();
  try {
    const info = await client.query<{ db: string; usr: string }>(
      'SELECT current_database() AS db, current_user AS usr',
    );
    const { db, usr } = info.rows[0]!;
    console.log(`Database: ${db}   user: ${usr}   mode: ${dryRun ? 'dry run' : 'commit'}`);
    if (db !== expectDb) {
      throw new PackSeedError(
        `Wrong database: connected to "${db}" but --expect-db is "${expectDb}".`,
      );
    }
    if (isProductionDbName(db) && values['confirm-production'] !== true) {
      throw new PackSeedError(
        `Refusing: ${productionReason(db)} and --confirm-production is not set.`,
      );
    }
    await client.query('BEGIN');
    let res: PackSeedResult;
    try {
      res = await seedPack(client, pack);
      if (res.checks.some((c) => !c.ok)) {
        printResult(res, true);
        throw new PackSeedError('A post-seed check failed: rolled back, nothing written.');
      }
      if (dryRun) await client.query('ROLLBACK');
      else await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw err;
    }
    console.log('');
    printResult(res, dryRun);
    return 0;
  } finally {
    await client.end().catch(() => undefined);
  }
}

function isMain(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  const a = path.resolve(entry);
  const b = fileURLToPath(import.meta.url);
  return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
}

if (isMain()) {
  main().then(
    (code) => process.exit(code),
    (err: unknown) => {
      // Message only: a pg error can echo the parameter values, and the values
      // here are lesson text and answers.
      const e = err as { message?: string; code?: string; name?: string };
      const known =
        e.name === 'PackSeedError' ||
        e.name === 'ContentPackError' ||
        err instanceof ContentPackError;
      console.error(
        `seed-pack: ${known ? e.message : `${e.code ?? ''} ${e.message ?? String(err)}`}`,
      );
      process.exit(1);
    },
  );
}
