import type { Pool, PoolClient } from 'pg';
import type { RosterTrainee } from '@fac-academy/shared';

// CSV export of the roster (S07 task 3). Generated on the server, from the
// database, and audited — the browser never assembles it, so what a manager
// downloads is what the server saw.
//
// One row per trainee. The fixed roster columns come first; `per_stage` then
// carries the per-stage statistics in one cell, in the trainee's own unlock
// order, as `code:pass|open:attempts:best:fails` items separated by `;`.
// A stage never attempted reads `code:open:0::0`.
//
// Two escaping jobs, both done here:
//  1. RFC 4180: a cell holding a quote, comma, CR or LF is wrapped in quotes
//     and its own quotes are doubled.
//  2. Formula injection: a text cell starting =, +, -, @, TAB or CR is
//     prefixed with an apostrophe, so Excel, Sheets and LibreOffice treat it
//     as text instead of running it. A trainee called `=cmd|...` is a name,
//     not a command.

type Db = Pool | PoolClient;

export const CSV_COLUMNS = [
  'id',
  'full_name',
  'email',
  'track',
  'status',
  'disabled',
  'online_now',
  'last_seen_at',
  'last_activity_at',
  'started_at',
  'stages_total',
  'stages_done',
  'current_stage_code',
  'current_stage_title',
  'attempts',
  'fails',
  'best_average',
  'stages_attempted',
  'stages_passed',
  'per_stage',
] as const;

/** UTF-8 byte order mark, so Excel reads a name with an accent correctly. */
export const BOM = String.fromCharCode(0xfeff);

const NEEDS_QUOTING = /["\r\n,]/;
const FORMULA_START = /^[=+\-@\t\r]/;

/** One CSV cell. Numbers and booleans pass through; text is neutralised first. */
export function csvCell(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : '';
  if (typeof value === 'boolean') return value ? 'yes' : 'no';
  let text = String(value);
  if (FORMULA_START.test(text)) text = `'${text}`;
  if (NEEDS_QUOTING.test(text)) text = `"${text.replace(/"/g, '""')}"`;
  return text;
}

export function csvRow(values: readonly unknown[]): string {
  return values.map(csvCell).join(',');
}

export interface StageStatsRow {
  perStage: string;
  stagesAttempted: number;
  stagesPassed: number;
}

interface DbStageStats {
  trainee_id: string;
  per_stage: string | null;
  stages_attempted: number;
  stages_passed: number;
}

/**
 * Per-stage statistics for every trainee in one query — never one query per
 * trainee. Empty map for an empty id list.
 */
export async function loadStageStatsFor(
  db: Db,
  traineeIds: readonly number[],
): Promise<Map<number, StageStatsRow>> {
  const out = new Map<number, StageStatsRow>();
  if (traineeIds.length === 0) return out;
  const { rows } = await db.query<DbStageStats>(
    `WITH people AS (
       SELECT t.id, t.track FROM academy.trainees t WHERE t.id = ANY($1::bigint[])
     ),
     cells AS (
       SELECT p.id                                     AS trainee_id,
              v.position,
              s.code,
              (c.trainee_id IS NOT NULL)               AS passed,
              st.attempts,
              st.fails,
              st.best
         FROM people p
         JOIN academy.track_visibility v ON v.track_code = p.track
         JOIN academy.stages s ON s.id = v.stage_id AND s.is_active
         LEFT JOIN academy.stage_completions c
                ON c.trainee_id = p.id AND c.stage_id = s.id
         LEFT JOIN LATERAL (
           SELECT count(*)::int                             AS attempts,
                  count(*) FILTER (WHERE NOT a.passed)::int AS fails,
                  max(a.score_pct)                          AS best
             FROM academy.quiz_attempts a
             JOIN academy.quizzes q ON q.id = a.quiz_id
            WHERE a.trainee_id = p.id AND q.stage_id = s.id
         ) st ON TRUE
     )
     SELECT trainee_id,
            string_agg(
              code || ':' || CASE WHEN passed THEN 'pass' ELSE 'open' END
                   || ':' || attempts
                   || ':' || COALESCE(best::float8::text, '')
                   || ':' || fails,
              ';' ORDER BY position
            )                                            AS per_stage,
            count(*) FILTER (WHERE attempts > 0)::int    AS stages_attempted,
            count(*) FILTER (WHERE passed)::int          AS stages_passed
       FROM cells
      GROUP BY trainee_id`,
    [traineeIds],
  );
  for (const r of rows) {
    out.set(Number(r.trainee_id), {
      perStage: r.per_stage ?? '',
      stagesAttempted: r.stages_attempted,
      stagesPassed: r.stages_passed,
    });
  }
  return out;
}

/**
 * The whole file. CRLF line endings (RFC 4180) and a UTF-8 byte order mark, so
 * Excel opens a name with an accent in it correctly.
 */
export function rosterCsv(
  trainees: readonly RosterTrainee[],
  stats: ReadonlyMap<number, StageStatsRow>,
): string {
  const lines = [csvRow(CSV_COLUMNS)];
  for (const t of trainees) {
    const s = stats.get(t.id);
    lines.push(
      csvRow([
        t.id,
        t.fullName,
        t.email,
        t.track,
        t.status,
        t.isDisabled,
        t.onlineNow,
        t.lastSeenAt,
        t.lastActivityAt,
        t.startedAt,
        t.stagesTotal,
        t.stagesDone,
        t.currentStageCode,
        t.currentStageTitle,
        t.attempts,
        t.fails,
        t.bestAverage,
        s?.stagesAttempted ?? 0,
        s?.stagesPassed ?? 0,
        s?.perStage ?? '',
      ]),
    );
  }
  return `${BOM}${lines.join('\r\n')}\r\n`;
}

/** `academy-roster-2026-09-23.csv` */
export function csvFilename(now: number): string {
  return `academy-roster-${new Date(now).toISOString().slice(0, 10)}.csv`;
}

/**
 * A small guard on the export: a manager may pull the file a few times a
 * minute, not in a loop. In memory on purpose — it protects one process from
 * one impatient click, and does not need to survive a restart.
 */
export class ExportThrottle {
  private readonly hits = new Map<number, number[]>();

  constructor(
    private readonly limit = 6,
    private readonly windowMs = 60_000,
  ) {}

  allow(managerId: number, now: number): boolean {
    const recent = (this.hits.get(managerId) ?? []).filter((t) => now - t < this.windowMs);
    if (recent.length >= this.limit) {
      this.hits.set(managerId, recent);
      return false;
    }
    recent.push(now);
    this.hits.set(managerId, recent);
    return true;
  }
}
