// S02 content seed: loads the prototype's training content into the academy
// schema. Safe to re-run: every row is upserted on a stable key, and a row
// that already matches is left untouched (the second run reports 0 changes).
//
//   npx tsx ops/seed/seed-content.ts --expect-db <name> [--dry-run]
//   (or from ops/: npm run seed -- --expect-db <name> [--dry-run])
//
// --expect-db must equal current_database() (the wrong-database guard, as in
// the migration runner). --dry-run does all the work and then rolls back.
// Everything runs in ONE transaction.
//
// Keys:  levels.level_number · departments.code · stages.code ·
//        lessons (stage, position) · quizzes.stage_id · questions (quiz, position) ·
//        question_options (question, position) · call_recordings.code ('<stage>-rec<n>') ·
//        status_guide.status · track_visibility (track, stage)
//
// Rows the prototype no longer has are left alone and reported, never deleted.
// Output is counts and ids only: no lesson text, questions, answers or names.

import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import pg from 'pg';
import { loadDotenvIfPresent } from '../../server/src/config/dotenv.js';
import { DbSettingsSchema, pgConfig } from '../../server/src/db/connection.js';
import {
  loadPrototype,
  TRACK_CODES_IN_ORDER,
  type PrototypeData,
  type ProtoStage,
} from './prototype.js';

const OPS_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ORACLE_FILE = path.join(OPS_DIR, 'fixtures', 'expected-track-visibility.json');

export class SeedError extends Error {
  override name = 'SeedError';
}

type Category = 'SALES' | 'CUSTOMER_SERVICE' | 'INDUCTION' | 'DEPARTMENT';

/**
 * The legacy stages.track value and the recording category of a stage, taken
 * from the prototype's own visibility (never re-implemented):
 *   department module                   -> track = dept code, category DEPARTMENT
 *   seen by CS but not Sales (s4, ...)   -> track CS,    category CUSTOMER_SERVICE
 *   seen by Sales but not CS (s5, ...)   -> track SALES, category SALES
 *   anything else (core, levels 2-5)     -> track FULL,  category INDUCTION
 * track_visibility is the real source of truth for who sees what; stages.track
 * is kept filled only because 0001 made it NOT NULL.
 */
export function classifyStage(
  stage: ProtoStage,
  proto: Pick<PrototypeData, 'visibleStageIds'>,
): { track: string; category: Category } {
  if (stage.dept) return { track: stage.dept, category: 'DEPARTMENT' };
  const cs = proto.visibleStageIds('CS').includes(stage.id);
  const sales = proto.visibleStageIds('SALES').includes(stage.id);
  if (cs && !sales) return { track: 'CS', category: 'CUSTOMER_SERVICE' };
  if (sales && !cs) return { track: 'SALES', category: 'SALES' };
  return { track: 'FULL', category: 'INDUCTION' };
}

export const recordingCode = (stageId: string, position: number): string =>
  `${stageId}-rec${position}`;

/**
 * The store key for one media file. Not an S3 key any more (D15/D16): it is
 * the path under MEDIA_ROOT on the server's own disk that the API streams from.
 */
export const mediaKeyFor = (file: string): string => `academy/media/${file}`;

// ---------------------------------------------------------------------------
// Counters
// ---------------------------------------------------------------------------

interface Tally {
  source: number;
  inserted: number;
  updated: number;
  unchanged: number;
  stale: number;
}

const TABLES = [
  'levels',
  'departments',
  'stages',
  'lessons',
  'quizzes',
  'questions',
  'question_options',
  'status_guide',
  'call_recordings',
  'track_visibility',
] as const;
type Table = (typeof TABLES)[number];

function newTallies(): Record<Table, Tally> {
  return Object.fromEntries(
    TABLES.map((t) => [t, { source: 0, inserted: 0, updated: 0, unchanged: 0, stale: 0 }]),
  ) as Record<Table, Tally>;
}

/**
 * Runs an `INSERT ... ON CONFLICT DO UPDATE ... WHERE <changed> RETURNING id,
 * (xmax = 0) AS inserted`. No row back = the existing row already matched;
 * `lookup` then finds its id.
 */
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
  if (id === undefined) throw new SeedError('Upsert matched a row that the lookup cannot find.');
  return id;
}

// ---------------------------------------------------------------------------
// The seed
// ---------------------------------------------------------------------------

export interface SeedResult {
  tallies: Record<Table, Tally>;
  perStage: {
    code: string;
    lessons: number;
    recordings: number;
    media: number;
    questions: number;
    passMark: number;
  }[];
  checks: { label: string; ok: boolean; detail: string }[];
}

export async function seedContent(
  client: pg.ClientBase,
  proto: PrototypeData,
): Promise<SeedResult> {
  const t = newTallies();

  // Levels: 0001 already seeded 1-5; the prototype's wording wins on content.
  const levelIds = new Map<number, string>();
  for (const l of proto.levels) {
    const id = await upsert(
      client,
      t.levels,
      `INSERT INTO academy.levels (level_number, name, weeks_label, accomplishment, description)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (level_number) DO UPDATE
         SET name = EXCLUDED.name, weeks_label = EXCLUDED.weeks_label,
             accomplishment = EXCLUDED.accomplishment, description = EXCLUDED.description
       WHERE (levels.name, levels.weeks_label, levels.accomplishment, levels.description)
             IS DISTINCT FROM
             (EXCLUDED.name, EXCLUDED.weeks_label, EXCLUDED.accomplishment, EXCLUDED.description)
       RETURNING id, (xmax = 0) AS inserted`,
      [l.n, l.name, l.weeks, l.accomplishment, l.desc],
      { sql: 'SELECT id FROM academy.levels WHERE level_number = $1', params: [l.n] },
    );
    levelIds.set(l.n, id!);
  }

  // Departments: rows come from 0002 (they are track codes too). Only the
  // academy metadata is filled here; an unknown code is an error.
  for (const d of proto.depts) {
    t.departments.source++;
    const exists = await client.query('SELECT 1 FROM academy.departments WHERE code = $1', [
      d.code,
    ]);
    if (exists.rowCount === 0) {
      throw new SeedError(`Department ${d.code} is not in academy.departments (see 0002).`);
    }
    const res = await client.query(
      `UPDATE academy.departments
          SET academy_name = $2, icon = $3, accomplishment = $4, description = $5
        WHERE code = $1
          AND (academy_name, icon, accomplishment, description)
              IS DISTINCT FROM ($2::text, $3::text, $4::text, $5::text)`,
      [d.code, d.name, d.icon, d.accomplishment, d.desc],
    );
    if (res.rowCount) t.departments.updated++;
    else t.departments.unchanged++;
  }

  // Position of each stage inside its level or its department.
  const groupPos = new Map<string, number>();
  const perStage: SeedResult['perStage'] = [];

  for (const s of proto.stages) {
    const group = s.dept ? `D:${s.dept}` : `L:${s.level}`;
    const position = (groupPos.get(group) ?? 0) + 1;
    groupPos.set(group, position);
    const { track, category } = classifyStage(s, proto);
    const levelId = s.level === null ? null : levelIds.get(s.level);
    if (levelId === undefined) throw new SeedError(`Stage ${s.id}: level ${s.level} not seeded.`);

    const stageId = await upsert(
      client,
      t.stages,
      `INSERT INTO academy.stages
         (code, level_id, dept, display_num, position, sort, title, blurb, track, pass_mark)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
       ON CONFLICT (code) DO UPDATE
         SET level_id = EXCLUDED.level_id, dept = EXCLUDED.dept,
             display_num = EXCLUDED.display_num, position = EXCLUDED.position,
             sort = EXCLUDED.sort, title = EXCLUDED.title, blurb = EXCLUDED.blurb,
             track = EXCLUDED.track, pass_mark = EXCLUDED.pass_mark
       WHERE (stages.level_id, stages.dept, stages.display_num, stages.position, stages.sort,
              stages.title, stages.blurb, stages.track, stages.pass_mark)
             IS DISTINCT FROM
             (EXCLUDED.level_id, EXCLUDED.dept, EXCLUDED.display_num, EXCLUDED.position,
              EXCLUDED.sort, EXCLUDED.title, EXCLUDED.blurb, EXCLUDED.track, EXCLUDED.pass_mark)
       RETURNING id, (xmax = 0) AS inserted`,
      [s.id, levelId, s.dept, s.displayNum, position, s.num, s.title, s.blurb, track, s.passMark],
      { sql: 'SELECT id FROM academy.stages WHERE code = $1', params: [s.id] },
    );

    // Lessons: title + body HTML verbatim. A change bumps the version.
    for (const [i, l] of s.lessons.entries()) {
      await upsert(
        client,
        t.lessons,
        `INSERT INTO academy.lessons (stage_id, position, title, body_html)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (stage_id, position) DO UPDATE
           SET title = EXCLUDED.title, body_html = EXCLUDED.body_html,
               version = lessons.version + 1, updated_at = now()
         WHERE (lessons.title, lessons.body_html) IS DISTINCT FROM (EXCLUDED.title, EXCLUDED.body_html)
         RETURNING id, (xmax = 0) AS inserted`,
        [stageId, i + 1, l.title, l.bodyHtml],
      );
    }

    // Recordings: 'coming soon' slots have no media_key and no duration (0002 X6).
    for (const [i, r] of s.recordings.entries()) {
      await upsert(
        client,
        t.call_recordings,
        `INSERT INTO academy.call_recordings
           (code, stage_id, position, category, title, description, media_key, duration_secs, media_type)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
         ON CONFLICT (code) DO UPDATE
           SET stage_id = EXCLUDED.stage_id, position = EXCLUDED.position,
               category = EXCLUDED.category, title = EXCLUDED.title,
               description = EXCLUDED.description, media_key = EXCLUDED.media_key,
               duration_secs = EXCLUDED.duration_secs, media_type = EXCLUDED.media_type
         WHERE (call_recordings.stage_id, call_recordings.position, call_recordings.category,
                call_recordings.title, call_recordings.description, call_recordings.media_key,
                call_recordings.duration_secs, call_recordings.media_type)
               IS DISTINCT FROM
               (EXCLUDED.stage_id, EXCLUDED.position, EXCLUDED.category, EXCLUDED.title,
                EXCLUDED.description, EXCLUDED.media_key, EXCLUDED.duration_secs, EXCLUDED.media_type)
         RETURNING id, (xmax = 0) AS inserted`,
        [
          recordingCode(s.id, i + 1),
          stageId,
          i + 1,
          category,
          r.title,
          r.description,
          r.mediaFile !== null ? mediaKeyFor(r.mediaFile) : null,
          r.mediaFile !== null ? r.durationSecs : null,
          r.mediaType,
        ],
      );
    }

    // Quiz: pass mark resolved by the prototype's pm(); prototype order, no shuffle.
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
      [stageId, s.passMark],
      { sql: 'SELECT id FROM academy.quizzes WHERE stage_id = $1', params: [stageId] },
    );

    for (const [qi, q] of s.quiz.entries()) {
      const questionId = await upsert(
        client,
        t.questions,
        `INSERT INTO academy.questions
           (quiz_id, position, prompt, source, approval_state, approved_at, is_active)
         VALUES ($1, $2, $3, 'HUMAN', 'APPROVED', now(), TRUE)
         ON CONFLICT (quiz_id, position) DO UPDATE
           SET prompt = EXCLUDED.prompt, source = 'HUMAN', approval_state = 'APPROVED',
               is_active = TRUE
         WHERE (questions.prompt, questions.source, questions.approval_state, questions.is_active)
               IS DISTINCT FROM (EXCLUDED.prompt, 'HUMAN', 'APPROVED', TRUE)
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

    perStage.push({
      code: s.id,
      lessons: s.lessons.length,
      recordings: s.recordings.length,
      media: s.recordings.filter((r) => r.mediaFile !== null).length,
      questions: s.quiz.length,
      passMark: s.passMark,
    });
  }

  // Status Guide (sort is deferred-unique, so reordering is safe).
  for (const g of proto.statusGuide) {
    await upsert(
      client,
      t.status_guide,
      `INSERT INTO academy.status_guide (status, client_line, sort)
       VALUES ($1, $2, $3)
       ON CONFLICT (status) DO UPDATE
         SET client_line = EXCLUDED.client_line, sort = EXCLUDED.sort, updated_at = now()
       WHERE (status_guide.client_line, status_guide.sort)
             IS DISTINCT FROM (EXCLUDED.client_line, EXCLUDED.sort)
       RETURNING id, (xmax = 0) AS inserted`,
      [g.status, g.clientLine, g.sort],
    );
  }

  // Track visibility from the prototype's own visibleStage(), in unlock order.
  for (const track of TRACK_CODES_IN_ORDER) {
    for (const [i, code] of proto.visibleStageIds(track).entries()) {
      await upsert(
        client,
        t.track_visibility,
        `INSERT INTO academy.track_visibility (track_code, stage_id, position)
         SELECT $1, s.id, $3 FROM academy.stages s WHERE s.code = $2
         ON CONFLICT (track_code, stage_id) DO UPDATE SET position = EXCLUDED.position
         WHERE track_visibility.position IS DISTINCT FROM EXCLUDED.position
         RETURNING NULL::bigint AS id, (xmax = 0) AS inserted`,
        [track, code, i + 1],
      );
    }
  }

  await countStale(client, proto, t);
  return { tallies: t, perStage, checks: await verify(client, proto) };
}

/** Rows in the DB that the prototype no longer has. Reported, never deleted. */
async function countStale(client: pg.ClientBase, proto: PrototypeData, t: Record<Table, Tally>) {
  const codes = proto.stages.map((s) => s.id);
  const n = async (sql: string, params: unknown[]): Promise<number> => {
    const r = await client.query<{ n: string }>(sql, params);
    return Number(r.rows[0]?.n ?? 0);
  };
  const lessonCounts = proto.stages.map((s) => s.lessons.length);
  const quizCounts = proto.stages.map((s) => s.quiz.length);

  t.levels.stale = await n(
    'SELECT count(*) AS n FROM academy.levels WHERE NOT (level_number = ANY($1::int[]))',
    [proto.levels.map((l) => l.n)],
  );
  t.departments.stale = await n(
    'SELECT count(*) AS n FROM academy.departments WHERE NOT (code = ANY($1::text[]))',
    [proto.depts.map((d) => d.code)],
  );
  t.stages.stale = await n(
    'SELECT count(*) AS n FROM academy.stages WHERE NOT (code = ANY($1::text[]))',
    [codes],
  );
  t.lessons.stale = await n(
    `SELECT count(*) AS n FROM academy.lessons l JOIN academy.stages s ON s.id = l.stage_id
       LEFT JOIN unnest($1::text[], $2::int[]) AS p(code, cnt) ON p.code = s.code
      WHERE p.code IS NULL OR l.position > p.cnt`,
    [codes, lessonCounts],
  );
  t.quizzes.stale = await n(
    `SELECT count(*) AS n FROM academy.quizzes q JOIN academy.stages s ON s.id = q.stage_id
      WHERE NOT (s.code = ANY($1::text[]))`,
    [codes],
  );
  // Prototype-keyed questions only (position set); NULL positions are not the seed's.
  t.questions.stale = await n(
    `SELECT count(*) AS n FROM academy.questions x
       JOIN academy.quizzes q ON q.id = x.quiz_id JOIN academy.stages s ON s.id = q.stage_id
       LEFT JOIN unnest($1::text[], $2::int[]) AS p(code, cnt) ON p.code = s.code
      WHERE x.position IS NOT NULL AND (p.code IS NULL OR x.position > p.cnt)`,
    [codes, quizCounts],
  );
  const optionKeys = proto.stages.flatMap((s) =>
    s.quiz.map((q, qi) => ({ code: s.id, pos: qi + 1, cnt: q.options.length })),
  );
  t.question_options.stale = await n(
    `SELECT count(*) AS n FROM academy.question_options o
       JOIN academy.questions x ON x.id = o.question_id
       JOIN academy.quizzes q ON q.id = x.quiz_id JOIN academy.stages s ON s.id = q.stage_id
       LEFT JOIN unnest($1::text[], $2::int[], $3::int[]) AS p(code, pos, cnt)
         ON p.code = s.code AND p.pos = x.position
      WHERE x.position IS NOT NULL AND (p.code IS NULL OR o.position > p.cnt)`,
    [optionKeys.map((k) => k.code), optionKeys.map((k) => k.pos), optionKeys.map((k) => k.cnt)],
  );
  t.status_guide.stale = await n(
    'SELECT count(*) AS n FROM academy.status_guide WHERE NOT (status = ANY($1::text[]))',
    [proto.statusGuide.map((g) => g.status)],
  );
  // Seed-owned recordings only (code set); manager uploads have no code.
  const recCodes = proto.stages.flatMap((s) =>
    s.recordings.map((_, i) => recordingCode(s.id, i + 1)),
  );
  t.call_recordings.stale = await n(
    `SELECT count(*) AS n FROM academy.call_recordings
      WHERE code IS NOT NULL AND NOT (code = ANY($1::text[]))`,
    [recCodes],
  );
  const vis = TRACK_CODES_IN_ORDER.flatMap((tr) =>
    proto.visibleStageIds(tr).map((code) => ({ tr, code })),
  );
  t.track_visibility.stale = await n(
    `SELECT count(*) AS n FROM academy.track_visibility v JOIN academy.stages s ON s.id = v.stage_id
       LEFT JOIN unnest($1::text[], $2::text[]) AS p(tr, code)
         ON p.tr = v.track_code AND p.code = s.code
      WHERE p.code IS NULL`,
    [vis.map((v) => v.tr), vis.map((v) => v.code)],
  );
}

/** Read back from the DB and compare with the prototype (and the hand-typed oracle). */
async function verify(client: pg.ClientBase, proto: PrototypeData): Promise<SeedResult['checks']> {
  const checks: SeedResult['checks'] = [];
  const add = (label: string, ok: boolean, detail: string) => checks.push({ label, ok, detail });
  const codes = proto.stages.map((s) => s.id);

  const one = async (sql: string, params: unknown[] = []) =>
    (await client.query<Record<string, string>>(sql, params)).rows[0] ?? {};

  const c = await one(
    `SELECT
       (SELECT count(*) FROM academy.stages WHERE code = ANY($1::text[])) AS stages,
       (SELECT count(*) FROM academy.lessons l JOIN academy.stages s ON s.id = l.stage_id
         WHERE s.code = ANY($1::text[])) AS lessons,
       (SELECT count(*) FROM academy.questions x JOIN academy.quizzes q ON q.id = x.quiz_id
         JOIN academy.stages s ON s.id = q.stage_id WHERE s.code = ANY($1::text[])) AS questions,
       (SELECT count(*) FROM academy.question_options o JOIN academy.questions x ON x.id = o.question_id
         JOIN academy.quizzes q ON q.id = x.quiz_id JOIN academy.stages s ON s.id = q.stage_id
         WHERE s.code = ANY($1::text[])) AS options,
       (SELECT count(*) FROM academy.question_options o JOIN academy.questions x ON x.id = o.question_id
         JOIN academy.quizzes q ON q.id = x.quiz_id JOIN academy.stages s ON s.id = q.stage_id
         WHERE s.code = ANY($1::text[]) AND o.is_correct) AS correct,
       (SELECT count(*) FROM academy.status_guide) AS status_rows,
       (SELECT count(*) FROM academy.call_recordings r JOIN academy.stages s ON s.id = r.stage_id
         WHERE s.code = ANY($1::text[])) AS recordings,
       (SELECT count(*) FROM academy.call_recordings r JOIN academy.stages s ON s.id = r.stage_id
         WHERE s.code = ANY($1::text[]) AND r.media_key IS NOT NULL) AS with_media`,
    [codes],
  );
  const lessons = proto.stages.reduce((a, s) => a + s.lessons.length, 0);
  const questions = proto.stages.reduce((a, s) => a + s.quiz.length, 0);
  const options = proto.stages.reduce(
    (a, s) => a + s.quiz.reduce((b, q) => b + q.options.length, 0),
    0,
  );
  const recs = proto.stages.flatMap((s) => s.recordings);
  const media = recs.filter((r) => r.mediaFile !== null).length;
  const eq = (label: string, db: string | undefined, want: number) =>
    add(label, Number(db) === want, `db ${db ?? '?'} / prototype ${want}`);
  eq('stages', c.stages, proto.stages.length);
  eq('lessons', c.lessons, lessons);
  eq('questions', c.questions, questions);
  eq('options', c.options, options);
  eq('correct options', c.correct, questions);
  eq('status guide rows', c.status_rows, proto.statusGuide.length);
  eq('recordings', c.recordings, recs.length);
  eq('recordings with media', c.with_media, media);

  const bad = await one(
    `SELECT count(*) AS n FROM (
       SELECT x.id FROM academy.questions x
         JOIN academy.quizzes q ON q.id = x.quiz_id JOIN academy.stages s ON s.id = q.stage_id
         LEFT JOIN academy.question_options o ON o.question_id = x.id AND o.is_correct
        WHERE s.code = ANY($1::text[])
        GROUP BY x.id HAVING count(o.id) <> 1) z`,
    [codes],
  );
  add('every question has exactly 1 correct option', bad.n === '0', `${bad.n ?? '?'} bad`);

  const pm = await client.query<{ code: string; pm: number }>(
    `SELECT s.code, q.pass_mark AS pm FROM academy.stages s JOIN academy.quizzes q ON q.stage_id = s.id
      WHERE s.code = ANY($1::text[])`,
    [codes],
  );
  const pmDb = new Map(pm.rows.map((r) => [r.code, Number(r.pm)]));
  const pmBad = proto.stages.filter((s) => pmDb.get(s.id) !== s.passMark).map((s) => s.id);
  add('quiz pass marks = prototype pm()', pmBad.length === 0, pmBad.join(' ') || 'all match');

  let oracle: Record<string, unknown> | null = null;
  if (existsSync(ORACLE_FILE)) {
    oracle = JSON.parse(readFileSync(ORACLE_FILE, 'utf8')) as Record<string, unknown>;
  }
  for (const track of TRACK_CODES_IN_ORDER) {
    const r = await client.query<{ code: string }>(
      `SELECT s.code FROM academy.track_visibility v JOIN academy.stages s ON s.id = v.stage_id
        WHERE v.track_code = $1 ORDER BY v.position`,
      [track],
    );
    const db = r.rows.map((x) => x.code).join(' ');
    const want = proto.visibleStageIds(track).join(' ');
    const expected = oracle?.[track];
    const oracleOk = Array.isArray(expected) ? expected.join(' ') === db : null;
    add(
      `track_visibility ${track}`,
      db === want && oracleOk !== false,
      `${r.rows.length} stages; diff vs visibleStage(): ${db === want ? 0 : 'MISMATCH'}` +
        (oracleOk === null ? '' : `; vs PROJECT-PLAN §1: ${oracleOk ? 0 : 'MISMATCH'}`),
    );
  }
  return checks;
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function printResult(res: SeedResult, dryRun: boolean): void {
  const rows = TABLES.map((name) => {
    const x = res.tallies[name];
    return [name, x.source, x.inserted, x.updated, x.unchanged, x.stale].map(String);
  });
  const head = ['table', 'source', 'inserted', 'updated', 'unchanged', 'stale (kept)'];
  printTable(head, rows);
  console.log('');
  printTable(
    ['stage', 'lessons', 'recordings', 'with media', 'questions', 'pass mark'],
    res.perStage.map((s) =>
      [s.code, s.lessons, s.recordings, s.media, s.questions, s.passMark].map(String),
    ),
  );
  console.log('');
  printTable(
    ['check', 'result', 'detail'],
    res.checks.map((c) => [c.label, c.ok ? 'PASS' : 'FAIL', c.detail]),
  );
  const changed = TABLES.reduce((a, n) => a + res.tallies[n].inserted + res.tallies[n].updated, 0);
  console.log('');
  console.log(`Rows written: ${changed}. ${dryRun ? 'DRY RUN: rolled back.' : 'Committed.'}`);
}

function printTable(head: string[], rows: string[][]): void {
  const widths = head.map((h, i) => Math.max(h.length, ...rows.map((r) => (r[i] ?? '').length)));
  const line = (cells: string[]) =>
    cells.map((c, i) => (i === 0 ? c.padEnd(widths[i]!) : c.padStart(widths[i]!))).join('  ');
  console.log(line(head));
  console.log(widths.map((w) => '-'.repeat(w)).join('  '));
  for (const r of rows) console.log(line(r));
}

async function main(): Promise<number> {
  const { values } = parseArgs({
    args: process.argv.slice(2),
    strict: true,
    allowPositionals: false,
    options: {
      'dry-run': { type: 'boolean', default: false },
      'expect-db': { type: 'string' },
      help: { type: 'boolean', short: 'h', default: false },
    },
  });
  if (values.help) {
    console.log('Usage: seed-content --expect-db <database name> [--dry-run]');
    return 0;
  }
  const expectDb = values['expect-db'];
  if (!expectDb)
    throw new SeedError('--expect-db <database name> is required (wrong-database guard).');
  const dryRun = values['dry-run'] === true;

  loadDotenvIfPresent();
  const parsed = DbSettingsSchema.safeParse(process.env);
  if (!parsed.success) {
    const names = [...new Set(parsed.error.issues.map((i) => String(i.path[0])))];
    throw new SeedError(`Missing or invalid database settings: ${names.join(', ')}.`);
  }

  const proto = await loadPrototype();
  console.log(
    `Prototype: ${proto.stages.length} stages, ${proto.statusGuide.length} status rows, ` +
      `${proto.mediaFiles.length} embedded media files.`,
  );

  const client = new pg.Client(
    pgConfig(parsed.data, { applicationName: 'academy-seed', statementTimeoutMs: 60_000 }),
  );
  await client.connect();
  try {
    const info = await client.query<{ db: string; usr: string }>(
      'SELECT current_database() AS db, current_user AS usr',
    );
    const { db, usr } = info.rows[0]!;
    console.log(`Database: ${db}   user: ${usr}   mode: ${dryRun ? 'dry run' : 'commit'}`);
    if (db !== expectDb) {
      throw new SeedError(`Wrong database: connected to "${db}" but --expect-db is "${expectDb}".`);
    }
    await client.query('BEGIN');
    let res: SeedResult;
    try {
      res = await seedContent(client, proto);
      if (res.checks.some((c) => !c.ok)) {
        printResult(res, true);
        throw new SeedError('A post-seed check failed: rolled back, nothing written.');
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
      // Message only: pg errors can echo parameter values (content), so no detail/stack.
      const e = err as { message?: string; code?: string; name?: string };
      const known = e.name === 'SeedError' || e.name === 'PrototypeError';
      console.error(`seed: ${known ? e.message : `${e.code ?? ''} ${e.message ?? String(err)}`}`);
      process.exit(1);
    },
  );
}
