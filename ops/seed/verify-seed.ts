// S02 independent verification. Reads the seeded `academy` schema and the prototype, and prints
// the CHECKLIST 02 evidence as a PASS/FAIL table. Exits 1 on any FAIL.
//
//   PROTOTYPE_PATH=<build pack>/FAC-Academy-Portal-v2.5.html \
//     npx tsx ops/seed/verify-seed.ts --expect-db academy_dev
//
// Data hygiene: the output holds counts, stage codes, offsets and hashes only. Lesson text,
// questions, answers and status lines are compared in memory and never printed.
//
// Three sources are compared where they overlap:
//   DB       what the seed wrote
//   proto    the prototype, parsed by ops/seed/prototype.ts
//   fixture  ops/fixtures/expected-track-visibility.json, typed by hand from PROJECT-PLAN §1

import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import pg from 'pg';
import { loadDotenvIfPresent } from '../../server/src/config/dotenv.js';
import { DbSettingsSchema, pgConfig } from '../../server/src/db/connection.js';
import { resolvePrototypePath } from '../lib/prototype-path.js';
import { compareLessonHtml } from './lesson-diff.js';
import { loadPrototype } from './prototype.js';
import type { PrototypeData, ProtoStage, TrackCode } from './prototype.js';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const FIXTURE_FILE = path.join(REPO_ROOT, 'ops', 'fixtures', 'expected-track-visibility.json');
const CANARY_FILE = path.join(REPO_ROOT, 'ops', 'fixtures', 'leak-canaries.json');
const LEAK_SCRIPT = path.join(REPO_ROOT, 'scripts', 'check-bundle-leaks.mjs');
const MEDIA_PREFIX = 'academy/media/';

export const TRACKS: readonly TrackCode[] = [
  'FULL',
  'CS',
  'SALES',
  'ADMIN',
  'FOS',
  'MGMT',
  'PAY',
  'IT',
  'DEBT',
];

// CHECKLIST 02 pass-mark rule: L1/L2 80, L3/L4 85, L5 90, department modules 80.
export function rulePassMark(level: number | null, dept: string | null): number {
  if (dept !== null || level === null || level === 0) return 80;
  if (level >= 5) return 90;
  if (level >= 3) return 85;
  return 80;
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface Check {
  id: string;
  item: string;
  pass: boolean;
  evidence: string;
}

interface Fixture {
  counts: {
    stages: number;
    lessons: number;
    questions: number;
    statusGuide: number;
    recordings: number;
    recordingsWithMedia: number;
  };
  questionsPerTrack: Record<TrackCode, number>;
  tracks: Record<TrackCode, string[]>;
}

interface Canary {
  label: string;
  length: number;
  sha256: string;
}

interface LeakModule {
  findCanaries(text: string, canaries: Canary[]): string[];
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
  default_pass_mark: number | null;
  quiz_pass_mark: number | null;
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

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function sha256(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

function sameList(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((v, i) => v === b[i]);
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

function table(headers: string[], rows: (string | number)[][]): string {
  const cells = [headers, ...rows.map((r) => r.map(String))];
  const widths = headers.map((_, c) => Math.max(...cells.map((r) => (r[c] ?? '').length)));
  const line = (r: string[]): string =>
    '| ' + r.map((v, c) => v.padEnd(widths[c] ?? 0)).join(' | ') + ' |';
  const sep = '|' + widths.map((w) => '-'.repeat(w + 2)).join('|') + '|';
  return [line(headers), sep, ...cells.slice(1).map(line)].join('\n');
}

function argValue(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

export function loadFixture(file = FIXTURE_FILE): Fixture {
  const raw = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
  const tracks = {} as Record<TrackCode, string[]>;
  for (const t of TRACKS) {
    const list = raw[t];
    if (!Array.isArray(list) || !list.every((v) => typeof v === 'string')) {
      throw new Error(`expected-track-visibility.json: track ${t} must be a list of stage ids`);
    }
    tracks[t] = list as string[];
  }
  return {
    counts: raw['counts'] as Fixture['counts'],
    questionsPerTrack: raw['questionsPerTrack'] as Record<TrackCode, number>,
    tracks,
  };
}

function listFiles(dir: string, exts: ReadonlySet<string>): string[] {
  if (!existsSync(dir)) return [];
  if (statSync(dir).isFile()) return [dir];
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules') continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listFiles(full, exts));
    else if (exts.has(path.extname(entry.name).toLowerCase())) out.push(full);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<number> {
  const expectDb = argValue('--expect-db');
  if (!expectDb) {
    console.error('Usage: npx tsx ops/seed/verify-seed.ts --expect-db <database name>');
    return 2;
  }

  loadDotenvIfPresent();
  const db = DbSettingsSchema.parse(process.env);
  if (db.DB_NAME !== expectDb) {
    console.error(`verify-seed: DB_NAME is "${db.DB_NAME}", expected "${expectDb}". Refusing.`);
    return 2;
  }

  const proto: PrototypeData = await loadPrototype(resolvePrototypePath());
  const fixture = loadFixture();
  const checks: Check[] = [];
  const add = (id: string, item: string, pass: boolean, evidence: string): void => {
    checks.push({ id, item, pass, evidence });
  };

  const pool = new pg.Pool(pgConfig(db, { applicationName: 'academy-verify-seed', max: 2 }));
  try {
    const q = async <T>(sql: string): Promise<T[]> => (await pool.query(sql)).rows as T[];

    const [{ current_database: currentDb } = { current_database: '' }] = await q<{
      current_database: string;
    }>('SELECT current_database()');
    console.log(`Database: ${currentDb} (expected ${expectDb})`);
    add('0', 'Connected to the expected database', currentDb === expectDb, currentDb);

    const stages = await q<StageRow>(`
      SELECT s.id::text, s.code, s.title, s.blurb, s.dept, s.display_num, s.position, s.track,
             s.pass_mark, s.is_exam, l.level_number, l.default_pass_mark,
             z.pass_mark AS quiz_pass_mark
        FROM academy.stages s
        LEFT JOIN academy.levels l ON l.id = s.level_id
        LEFT JOIN academy.quizzes z ON z.stage_id = s.id
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
    const stageByCode = new Map(stages.map((s) => [s.code, s]));
    const codeOf = (id: string | null): string =>
      id === null ? '(none)' : (stageById.get(id)?.code ?? `?${id}`);
    const lessonsByStage = groupBy(lessons, (l) => codeOf(l.stage_id));
    const questionsByStage = groupBy(questions, (x) => codeOf(x.stage_id));
    const optionsByQuestion = groupBy(options, (o) => o.question_id);
    const recordingsByStage = groupBy(recordings, (r) => codeOf(r.stage_id));

    // ---- a. stages ------------------------------------------------------------
    const protoCodes = proto.stages.map((s) => s.id);
    const dbCodes = stages.map((s) => s.code);
    const missing = protoCodes.filter((c) => !stageByCode.has(c));
    const extra = dbCodes.filter((c) => !protoCodes.includes(c));
    add(
      'a',
      'Stage count DB == prototype (== fixture)',
      stages.length === proto.stages.length &&
        stages.length === fixture.counts.stages &&
        missing.length === 0 &&
        extra.length === 0,
      `DB ${stages.length}, prototype ${proto.stages.length}, fixture ${fixture.counts.stages}` +
        `; missing [${missing.join(' ')}] extra [${extra.join(' ')}]`,
    );
    const metaDiffs: string[] = [];
    for (const ps of proto.stages) {
      const s = stageByCode.get(ps.id);
      if (!s) continue;
      const protoLevel = ps.dept !== null ? null : ps.level;
      const dbLevel = s.dept !== null ? null : s.level_number;
      if (s.title !== ps.title || (s.blurb ?? '') !== ps.blurb) metaDiffs.push(`${ps.id}:text`);
      if ((s.dept ?? null) !== (ps.dept ?? null)) metaDiffs.push(`${ps.id}:dept`);
      if (dbLevel !== protoLevel) metaDiffs.push(`${ps.id}:level`);
    }
    add(
      'a2',
      'Stage title, blurb, level and department match the prototype',
      metaDiffs.length === 0,
      metaDiffs.length === 0
        ? `${proto.stages.length}/${proto.stages.length} stages match`
        : metaDiffs.join(' '),
    );

    // ---- b. lessons per stage -------------------------------------------------
    const lessonTable: (string | number)[][] = [];
    let lessonCountOk = true;
    let lessonContentDiffs = 0;
    let lessonsIdentical = 0;
    for (const ps of proto.stages) {
      const dbl = lessonsByStage.get(ps.id) ?? [];
      const ok = dbl.length === ps.lessons.length;
      if (!ok) lessonCountOk = false;
      ps.lessons.forEach((pl, i) => {
        const d = dbl[i];
        if (d && d.title === pl.title && d.body_html === pl.bodyHtml) lessonsIdentical += 1;
        else lessonContentDiffs += 1;
      });
      lessonTable.push([ps.id, dbl.length, ps.lessons.length, ok ? 'ok' : 'MISMATCH']);
    }
    const protoLessonTotal = proto.stages.reduce((n, s) => n + s.lessons.length, 0);
    console.log('\nb. Lessons per stage\n' + table(['stage', 'DB', 'prototype', ''], lessonTable));
    add(
      'b',
      'Lesson count per stage matches the prototype',
      lessonCountOk &&
        lessons.length === protoLessonTotal &&
        protoLessonTotal === fixture.counts.lessons,
      `total DB ${lessons.length}, prototype ${protoLessonTotal}, fixture ${fixture.counts.lessons}; ` +
        `${lessonTable.filter((r) => r[3] === 'ok').length}/${proto.stages.length} stages equal`,
    );
    add(
      'b2',
      'Every lesson title + body byte-identical to the prototype, in order',
      lessonContentDiffs === 0,
      `${lessonsIdentical}/${protoLessonTotal} identical, ${lessonContentDiffs} differ`,
    );

    // ---- c. questions, options, pass marks -----------------------------------
    const quizTable: (string | number)[][] = [];
    let qCountOk = true;
    let qTextDiffs = 0;
    let badCorrect = 0;
    let badOptionCount = 0;
    let wrongCorrectIndex = 0;
    let notApproved = 0;
    let passMarkDiffs = 0;
    let ruleOverrides = 0;
    for (const ps of proto.stages) {
      const dbq = questionsByStage.get(ps.id) ?? [];
      const s = stageByCode.get(ps.id);
      if (dbq.length !== ps.quiz.length) qCountOk = false;
      ps.quiz.forEach((pq, i) => {
        const d = dbq[i];
        if (!d) return;
        const opts = optionsByQuestion.get(d.id) ?? [];
        const correct = opts.filter((o) => o.is_correct);
        if (correct.length !== 1) badCorrect += 1;
        if (opts.length !== 4) badOptionCount += 1;
        const correctAt = opts.findIndex((o) => o.is_correct);
        if (correctAt !== pq.correctIndex) wrongCorrectIndex += 1;
        if (
          d.prompt !== pq.prompt ||
          !sameList(
            opts.map((o) => o.body),
            pq.options,
          )
        ) {
          qTextDiffs += 1;
        }
        if (d.source !== 'HUMAN' || d.approval_state !== 'APPROVED' || !d.is_active) {
          notApproved += 1;
        }
      });
      const effective =
        s?.quiz_pass_mark ?? s?.pass_mark ?? (s?.level_number ? s.default_pass_mark : null) ?? 80;
      const rule = rulePassMark(ps.dept !== null ? null : ps.level, ps.dept);
      const pmOk = effective === ps.passMark;
      if (!pmOk) passMarkDiffs += 1;
      if (ps.passMark !== rule) ruleOverrides += 1;
      const levelLabel = ps.dept !== null ? `dept ${ps.dept}` : `L${ps.level ?? '?'}`;
      quizTable.push([
        ps.id,
        levelLabel,
        dbq.length,
        ps.quiz.length,
        effective,
        ps.passMark,
        rule,
        dbq.length === ps.quiz.length && pmOk ? 'ok' : 'MISMATCH',
      ]);
    }
    const protoQTotal = proto.stages.reduce((n, s) => n + s.quiz.length, 0);
    console.log(
      '\nc. Quiz questions and pass marks per stage\n' +
        table(
          ['stage', 'level', 'Q DB', 'Q proto', 'pass DB', 'pass proto', 'rule', ''],
          quizTable,
        ),
    );
    add(
      'c1',
      'Question count per quiz matches the prototype',
      qCountOk && questions.length === protoQTotal && protoQTotal === fixture.counts.questions,
      `total DB ${questions.length}, prototype ${protoQTotal}, fixture ${fixture.counts.questions}`,
    );
    add(
      'c2',
      'Every question has exactly one correct option and 4 options, at the prototype index',
      badCorrect === 0 &&
        badOptionCount === 0 &&
        wrongCorrectIndex === 0 &&
        options.length === questions.length * 4,
      `${options.length} options for ${questions.length} questions; not-exactly-one-correct ${badCorrect}, ` +
        `not-4-options ${badOptionCount}, correct index differs ${wrongCorrectIndex}`,
    );
    add(
      'c3',
      'Question prompts and option texts identical to the prototype, in order',
      qTextDiffs === 0,
      `${protoQTotal - qTextDiffs}/${protoQTotal} identical`,
    );
    add(
      'c4',
      'Seeded questions are HUMAN, APPROVED and active (X10)',
      notApproved === 0,
      `${questions.length - notApproved}/${questions.length}`,
    );
    add(
      'c5',
      'Effective pass mark per stage DB == prototype (rule L1/L2 80, L3/L4 85, L5 90, dept 80)',
      passMarkDiffs === 0,
      `${proto.stages.length - passMarkDiffs}/${proto.stages.length} match; ` +
        `prototype overrides the rule on ${ruleOverrides} stage(s)`,
    );

    // ---- d. status guide ------------------------------------------------------
    const sgContentOk =
      statusRows.length === proto.statusGuide.length &&
      [...proto.statusGuide]
        .sort((x, y) => x.sort - y.sort)
        .every((p, i) => {
          const d = statusRows[i];
          return d !== undefined && d.status === p.status && d.client_line === p.clientLine;
        });
    add(
      'd',
      'Status Guide rows == prototype entries (text identical, in order)',
      statusRows.length === proto.statusGuide.length &&
        statusRows.length === fixture.counts.statusGuide &&
        sgContentOk,
      `DB ${statusRows.length}, prototype ${proto.statusGuide.length}, fixture ${fixture.counts.statusGuide}; ` +
        `content ${sgContentOk ? 'identical' : 'DIFFERS'}`,
    );

    // ---- e. track visibility (three-way) -------------------------------------
    const visByTrack = groupBy(visibility, (v) => v.track_code);
    const visTable: (string | number)[][] = [];
    let visOk = true;
    let qPerTrackOk = true;
    for (const t of TRACKS) {
      const dbList = (visByTrack.get(t) ?? []).map((v) => v.code);
      const protoList = proto.visibleStageIds(t);
      const fixList = fixture.tracks[t];
      const positionsOk = (visByTrack.get(t) ?? []).every((v, i) => v.position === i + 1);
      const same = sameList(dbList, protoList) && sameList(protoList, fixList);
      const dbQ = dbList.reduce((n, c) => n + (questionsByStage.get(c)?.length ?? 0), 0);
      const qOk = dbQ === fixture.questionsPerTrack[t];
      if (!same || !positionsOk) visOk = false;
      if (!qOk) qPerTrackOk = false;
      visTable.push([
        t,
        dbList.length,
        protoList.length,
        fixList.length,
        same ? 0 : 'DIFF',
        positionsOk ? '1..n' : 'GAPS',
        dbQ,
        fixture.questionsPerTrack[t],
      ]);
      if (!same) {
        console.log(`  ${t} DB     : ${dbList.join(' ')}`);
        console.log(`  ${t} proto  : ${protoList.join(' ')}`);
        console.log(`  ${t} fixture: ${fixList.join(' ')}`);
      }
    }
    const extraTracks = [...visByTrack.keys()].filter((k) => !TRACKS.includes(k as TrackCode));
    console.log(
      '\ne. Track visibility (DB vs prototype visibleStageIds() vs fixture)\n' +
        table(
          ['track', 'DB', 'proto', 'fixture', 'diff', 'positions', 'Q DB', 'Q fixture'],
          visTable,
        ),
    );
    add(
      'e1',
      'track_visibility: 9 tracks, DB == prototype == fixture, ordered, zero diff',
      visOk && extraTracks.length === 0,
      `${visTable.filter((r) => r[4] === 0).length}/9 tracks identical; ${visibility.length} rows` +
        (extraTracks.length ? `; unexpected tracks ${extraTracks.join(' ')}` : ''),
    );
    add(
      'e2',
      'Questions per track (DB) == PROJECT-PLAN §1 table',
      qPerTrackOk,
      TRACKS.map((t) => `${t} ${visTable.find((r) => r[0] === t)?.[6] ?? '?'}`).join(', '),
    );

    // ---- f. recordings ---------------------------------------------------------
    const withKey = recordings.filter((r) => r.media_key !== null);
    const withoutKey = recordings.filter((r) => r.media_key === null);
    const protoRecTotal = proto.stages.reduce((n, s) => n + s.recordings.length, 0);
    const protoWithMedia = proto.stages.reduce(
      (n, s) => n + s.recordings.filter((r) => r.mediaFile !== null).length,
      0,
    );
    add(
      'f1',
      'Recording slots: 48 total, 7 with media_key, 41 NULL',
      recordings.length === protoRecTotal &&
        recordings.length === fixture.counts.recordings &&
        withKey.length === protoWithMedia &&
        withKey.length === fixture.counts.recordingsWithMedia &&
        withoutKey.length === fixture.counts.recordings - fixture.counts.recordingsWithMedia,
      `DB ${recordings.length} (with media_key ${withKey.length}, NULL ${withoutKey.length}); ` +
        `prototype ${protoRecTotal} (with media ${protoWithMedia}); ` +
        `fixture ${fixture.counts.recordings} (${fixture.counts.recordingsWithMedia})`,
    );
    const keyCounts = new Map<string, number>();
    for (const r of withKey)
      keyCounts.set(r.media_key ?? '', (keyCounts.get(r.media_key ?? '') ?? 0) + 1);
    // The embedded MEDIA keys (audio) plus any external file a slot names (the FOS video).
    const slotMedia = proto.stages.flatMap((s) =>
      s.recordings.flatMap((r) => (r.mediaFile === null ? [] : [r.mediaFile])),
    );
    const allMedia = [...new Set([...proto.mediaFiles, ...slotMedia])];
    const unusedEmbedded = proto.mediaFiles.filter((f) => !slotMedia.includes(f));
    const mediaNotOnce = allMedia.filter((f) => keyCounts.get(MEDIA_PREFIX + f) !== 1);
    const strayKeys = [...keyCounts.keys()].filter(
      (k) => !allMedia.some((f) => MEDIA_PREFIX + f === k),
    );
    add(
      'f2',
      `Every prototype media file appears exactly once as ${MEDIA_PREFIX}<file>`,
      mediaNotOnce.length === 0 && strayKeys.length === 0 && unusedEmbedded.length === 0,
      `${allMedia.length - mediaNotOnce.length}/${allMedia.length} media files exactly once ` +
        `(${proto.mediaFiles.length} embedded + ${allMedia.length - proto.mediaFiles.length} external); ` +
        `not once ${mediaNotOnce.length}, keys not in prototype ${strayKeys.length}, ` +
        `embedded but unused ${unusedEmbedded.length}`,
    );
    let slotDiffs = 0;
    const slotDiffStages: string[] = [];
    for (const ps of proto.stages) {
      const dbr = recordingsByStage.get(ps.id) ?? [];
      const ok =
        dbr.length === ps.recordings.length &&
        ps.recordings.every((pr, i) => {
          const d = dbr[i];
          const key = pr.mediaFile === null ? null : MEDIA_PREFIX + pr.mediaFile;
          return (
            d !== undefined &&
            d.title === pr.title &&
            (d.description ?? '') === pr.description &&
            d.media_key === key &&
            d.media_type === pr.mediaType
          );
        });
      if (!ok) {
        slotDiffs += 1;
        slotDiffStages.push(ps.id);
      }
    }
    const unassigned = recordingsByStage.get('(none)')?.length ?? 0;
    add(
      'f3',
      'Recording slots per stage: order, title, description, media key and type match the prototype',
      slotDiffs === 0 && unassigned === 0,
      `${proto.stages.length - slotDiffs}/${proto.stages.length} stages match; unassigned ${unassigned}` +
        (slotDiffStages.length ? `; differ: ${slotDiffStages.join(' ')}` : ''),
    );

    // ---- g. fingerprint -------------------------------------------------------
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
    const fpTable: (string | number)[][] = Object.entries(canonical).map(([name, rows]) => [
      name,
      rows.length,
      sha256(JSON.stringify(rows)).slice(0, 16),
    ]);
    const fingerprint = sha256(JSON.stringify(canonical));
    console.log(
      '\ng. Seeded content fingerprint\n' + table(['table', 'rows', 'sha256 (16)'], fpTable),
    );
    console.log(`   overall fingerprint: ${fingerprint}`);
    add('g', 'Content fingerprint (compare across two seed runs)', true, fingerprint);

    // ---- h. lesson HTML spot-check -------------------------------------------
    const pick = (
      label: string,
      filter: (s: ProtoStage) => boolean,
      lessonTest: (title: string, body: string) => boolean,
    ): { label: string; stage: string; index: number } | null => {
      for (const s of proto.stages.filter(filter)) {
        const i = s.lessons.findIndex((l) => lessonTest(l.title, l.bodyHtml));
        if (i >= 0) return { label, stage: s.id, index: i };
      }
      return null;
    };
    const spots = [
      pick(
        'script lesson',
        (s) => s.id !== 's4',
        (t) => /\bscript\b/i.test(t),
      ) ??
        pick(
          'script lesson',
          () => true,
          (t) => /script/i.test(t),
        ),
      pick(
        'Status Guide lesson',
        (s) => s.id === 's4',
        (t) => /status guide/i.test(t),
      ),
      pick(
        'DSAR replica lesson',
        (s) => s.id === 'dA2',
        (_t, b) => /replica/i.test(b),
      ),
    ];
    const spotTable: (string | number)[][] = [];
    let spotsOk = true;
    for (const [i, spot] of spots.entries()) {
      if (!spot) {
        spotsOk = false;
        spotTable.push([`#${i + 1}`, '(not found in prototype)', '-', '-', 'FAIL', '-']);
        continue;
      }
      const protoBody = proto.stages.find((s) => s.id === spot.stage)?.lessons[spot.index]
        ?.bodyHtml;
      const dbBody = lessonsByStage.get(spot.stage)?.[spot.index]?.body_html;
      if (protoBody === undefined || dbBody === undefined) {
        spotsOk = false;
        spotTable.push([spot.label, spot.stage, spot.index + 1, '-', 'MISSING IN DB', '-']);
        continue;
      }
      const cmp = compareLessonHtml(dbBody, protoBody);
      if (cmp.verdict === 'DIFF') spotsOk = false;
      spotTable.push([
        spot.label,
        spot.stage,
        spot.index + 1,
        `${cmp.lengths[0]}/${cmp.lengths[1]}`,
        cmp.verdict,
        cmp.verdict === 'IDENTICAL'
          ? '-'
          : `raw@${cmp.rawOffset ?? '-'} norm@${cmp.normalisedOffset ?? '-'}`,
      ]);
    }
    console.log(
      '\nh. Lesson HTML spot-check (DB body vs prototype body)\n' +
        table(
          ['lesson', 'stage', 'lesson #', 'chars DB/proto', 'verdict', 'first diff'],
          spotTable,
        ),
    );
    add(
      'h',
      'Spot-check 3 lessons (script, Status Guide, DSAR replica) identical to prototype',
      spotsOk,
      spotTable.map((r) => `${r[1]}#${r[2]} ${r[4]}`).join('; '),
    );

    // ---- i. no answers in client-served files --------------------------------
    const leak = (await import(pathToFileURL(LEAK_SCRIPT).href)) as LeakModule;
    const canaries = JSON.parse(readFileSync(CANARY_FILE, 'utf8')) as Canary[];
    const scanExts = new Set([
      '.js',
      '.jsx',
      '.ts',
      '.mjs',
      '.css',
      '.html',
      '.json',
      '.map',
      '.svg',
      '.txt',
    ]);
    const distDir = path.join(REPO_ROOT, 'client', 'dist');
    const scanTargets = [
      distDir,
      path.join(REPO_ROOT, 'client', 'src'),
      path.join(REPO_ROOT, 'client', 'public'),
      path.join(REPO_ROOT, 'client', 'index.html'),
      path.join(REPO_ROOT, 'shared', 'src'),
    ];
    const scanned = scanTargets.flatMap((d) => listFiles(d, scanExts));
    const hits: string[] = [];
    for (const f of scanned) {
      for (const label of leak.findCanaries(readFileSync(f, 'utf8'), canaries)) {
        hits.push(`${path.relative(REPO_ROOT, f)}:${label}`);
      }
    }
    // Positive control: every canary must be present in the seeded content, or the scan
    // above proves nothing.
    const seededText = [
      ...lessons.map((l) => l.body_html),
      ...options.map((o) => o.body),
      ...statusRows.map((r) => r.client_line),
    ].join('\n');
    const live = new Set(leak.findCanaries(seededText, canaries));
    const dead = canaries.filter((c) => !live.has(c.label)).map((c) => c.label);
    add(
      'i1',
      'Leak canaries are live (each found in the seeded DB content)',
      canaries.length >= 3 && dead.length === 0,
      `${live.size}/${canaries.length} found in DB content` +
        (dead.length ? `; not found: ${dead.join(' ')}` : ''),
    );
    add(
      'i2',
      'No answer / lesson / status text in client-served files (client/dist, client/src, shared/src)',
      existsSync(distDir) && hits.length === 0,
      existsSync(distDir)
        ? `${scanned.length} files scanned, ${hits.length} hit(s)` +
            (hits.length ? `: ${hits.join(' ')}` : '')
        : 'client/dist missing: run npm run build -w @fac-academy/client first',
    );
  } finally {
    await pool.end();
  }

  // ---- summary -----------------------------------------------------------------
  console.log(
    '\nCHECKLIST 02 evidence\n' +
      table(
        ['#', 'item', 'result', 'evidence'],
        checks.map((c) => [c.id, c.item, c.pass ? 'PASS' : 'FAIL', c.evidence]),
      ),
  );
  const failed = checks.filter((c) => !c.pass);
  console.log(
    failed.length === 0
      ? `\nverify-seed: ALL PASS (${checks.length} checks)`
      : `\nverify-seed: ${failed.length} FAIL(s): ${failed.map((c) => c.id).join(' ')}`,
  );
  return failed.length === 0 ? 0 : 1;
}

const invokedDirectly =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedDirectly) {
  main().then(
    (code) => process.exit(code),
    (err: unknown) => {
      console.error('verify-seed: error:', err instanceof Error ? err.message : String(err));
      process.exit(1);
    },
  );
}
