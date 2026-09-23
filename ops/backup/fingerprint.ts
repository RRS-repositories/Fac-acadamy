// The content fingerprint: one sha256 over every row of seeded training
// content, in a canonical order.
//
// It is the same construction ops/seed/verify-seed.ts prints as check `g`
// ("Content fingerprint (compare across two seed runs)") — same queries, same
// column order, same sort — so a fingerprint taken here can be compared with
// one printed there. The restore drill uses it to prove that what came back
// out of the dump is the same content, rather than merely the same number of
// rows.
//
// Data hygiene: the fingerprint is a hash. Lesson HTML, questions and answers
// are read into memory to compute it and are never printed or written down.

import { createHash } from 'node:crypto';
import type pg from 'pg';

/** Anything with a pg-style query method (a Client, a Pool or a PoolClient). */
export type Queryable = Pick<pg.ClientBase, 'query'>;

export interface ContentFingerprint {
  /** sha256 over the whole canonical structure. */
  overall: string;
  /** sha256 per table, in the same order the tables are listed below. */
  perTable: Record<string, string>;
  /** Row count per table, for the printed table. */
  rowCounts: Record<string, number>;
}

function sha256(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

interface StageRow {
  id: string;
  code: string;
  title: string;
  blurb: string | null;
  dept: string | null;
  display_num: string | null;
  position: number;
  track: string;
  pass_mark: number | null;
  is_exam: boolean;
  level_number: number | null;
}

interface LessonRow {
  stage_id: string;
  position: number;
  title: string;
  body_html: string;
}

interface QuestionRow {
  id: string;
  stage_id: string;
  position: number | null;
  prompt: string;
  source: string;
  approval_state: string;
  is_active: boolean;
}

interface OptionRow {
  question_id: string;
  position: number;
  body: string;
  is_correct: boolean;
}

interface StatusRow {
  status: string;
  client_line: string;
  sort: number;
}

interface RecordingRow {
  code: string | null;
  stage_id: string | null;
  category: string;
  title: string;
  description: string | null;
  media_key: string | null;
  duration_secs: number | null;
  media_type: string;
  position: number | null;
  is_active: boolean;
}

interface VisibilityRow {
  track_code: string;
  position: number;
  code: string;
}

function groupBy<T>(rows: readonly T[], key: (r: T) => string): Map<string, T[]> {
  const out = new Map<string, T[]>();
  for (const r of rows) {
    const k = key(r);
    const list = out.get(k);
    if (list) list.push(r);
    else out.set(k, [r]);
  }
  return out;
}

/** Reads the `academy` content tables and folds them into one canonical hash. */
export async function contentFingerprint(db: Queryable): Promise<ContentFingerprint> {
  const q = async <T>(sql: string): Promise<T[]> => (await db.query(sql)).rows as T[];

  const stages = await q<StageRow>(`
    SELECT s.id::text, s.code, s.title, s.blurb, s.dept, s.display_num, s.position, s.track,
           s.pass_mark, s.is_exam, l.level_number
      FROM academy.stages s
      LEFT JOIN academy.levels l ON l.id = s.level_id
     ORDER BY s.id`);
  const lessons = await q<LessonRow>(`
    SELECT stage_id::text, position, title, body_html
      FROM academy.lessons ORDER BY stage_id, position`);
  const questions = await q<QuestionRow>(`
    SELECT qn.id::text, z.stage_id::text, qn.position, qn.prompt, qn.source,
           qn.approval_state, qn.is_active
      FROM academy.questions qn
      JOIN academy.quizzes z ON z.id = qn.quiz_id
     ORDER BY z.stage_id, qn.position NULLS LAST, qn.id`);
  const options = await q<OptionRow>(`
    SELECT question_id::text, position, body, is_correct
      FROM academy.question_options ORDER BY question_id, position`);
  const statusRows = await q<StatusRow>(`
    SELECT status, client_line, sort FROM academy.status_guide ORDER BY sort`);
  const recordings = await q<RecordingRow>(`
    SELECT code, stage_id::text, category, title, description, media_key, duration_secs,
           media_type, position, is_active
      FROM academy.call_recordings
     ORDER BY stage_id NULLS LAST, position NULLS LAST, id`);
  const visibility = await q<VisibilityRow>(`
    SELECT tv.track_code, tv.position, s.code
      FROM academy.track_visibility tv
      JOIN academy.stages s ON s.id = tv.stage_id
     ORDER BY tv.track_code, tv.position`);
  const levels = await q<Record<string, unknown>>(`
    SELECT level_number, name, weeks_label, accomplishment, description, default_pass_mark
      FROM academy.levels ORDER BY level_number`);
  const departments = await q<Record<string, unknown>>(`
    SELECT code, label, accomplishment, sort FROM academy.departments ORDER BY sort`);
  const quizzes = await q<Record<string, unknown>>(`
    SELECT s.code, z.pass_mark, z.question_count, z.shuffle
      FROM academy.quizzes z JOIN academy.stages s ON s.id = z.stage_id ORDER BY s.code`);

  const stageById = new Map(stages.map((s) => [s.id, s]));
  const codeOf = (id: string | null): string =>
    id === null ? '(none)' : (stageById.get(id)?.code ?? `?${id}`);
  const optionsByQuestion = groupBy(options, (o) => o.question_id);

  const canonical: Record<string, unknown[]> = {
    levels,
    departments,
    stages: [...stages]
      .sort((x, y) => x.code.localeCompare(y.code))
      .map((s) => [
        s.code,
        s.level_number,
        s.dept,
        s.position,
        s.display_num,
        s.title,
        s.blurb,
        s.track,
        s.pass_mark,
        s.is_exam,
      ]),
    quizzes,
    lessons: lessons
      .map((l) => [codeOf(l.stage_id), l.position, l.title, l.body_html] as const)
      .sort((x, y) => x[0].localeCompare(y[0]) || x[1] - y[1]),
    questions: questions
      .map((x) => {
        const opts = (optionsByQuestion.get(x.id) ?? []).map((o) => [
          o.position,
          o.body,
          o.is_correct,
        ]);
        return [
          codeOf(x.stage_id),
          x.position,
          x.prompt,
          x.source,
          x.approval_state,
          x.is_active,
          opts,
        ] as const;
      })
      .sort((x, y) => x[0].localeCompare(y[0]) || (x[1] ?? 0) - (y[1] ?? 0)),
    status_guide: statusRows.map((r) => [r.sort, r.status, r.client_line]),
    call_recordings: recordings
      .map((r) => [
        codeOf(r.stage_id),
        r.position,
        r.code,
        r.category,
        r.title,
        r.description,
        r.media_key,
        r.duration_secs,
        r.media_type,
        r.is_active,
      ])
      .sort((x, y) => JSON.stringify(x).localeCompare(JSON.stringify(y))),
    track_visibility: visibility.map((v) => [v.track_code, v.position, v.code]),
  };

  const perTable: Record<string, string> = {};
  const rowCounts: Record<string, number> = {};
  for (const [name, rows] of Object.entries(canonical)) {
    perTable[name] = sha256(JSON.stringify(rows));
    rowCounts[name] = rows.length;
  }
  return { overall: sha256(JSON.stringify(canonical)), perTable, rowCounts };
}
