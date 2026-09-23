import type { Pool, PoolClient } from 'pg';
import { TraineeStatusSchema } from '@fac-academy/shared';
import type {
  RosterCounts,
  RosterResponse,
  RosterTrainee,
  TraineeStage,
  TraineeStatus,
} from '@fac-academy/shared';
import { loadProgression, stageStates, visibleStages } from '../training/gate.js';
import { toTrackCode } from '../training/repo.js';
import { toIso, toNumber } from './deps.js';
import type { ManagerDeps } from './deps.js';

// The manager roster (S07 task 1). One query for the whole list: the view
// academy.v_trainee_overview supplies identity, online-now and last activity,
// and four LATERAL blocks add what it does not carry — where the trainee is in
// THEIR track, and their attempt totals. No per-trainee round trip, ever.
//
// The unlock rule is not re-implemented here. The roster only needs "the first
// visible stage they have not passed"; the trainee detail below asks the real
// gate (stageStates) for the state of every stage.

type Db = Pool | PoolClient;

/** Hard ceiling on one roster page. The academy is tens of people, not tens of thousands. */
export const ROSTER_LIMIT = 2000;

export interface RosterFilters {
  track?: string | null;
  q?: string | null;
  includeDisabled?: boolean;
  /** One trainee only (the detail route). */
  id?: number | null;
}

interface RosterRow {
  id: string;
  full_name: string;
  email: string;
  track: string | null;
  status: string;
  is_disabled: boolean;
  online_now: boolean;
  last_seen_at: Date | null;
  last_activity: Date | null;
  started_at: Date;
  stages_total: number;
  stages_done: number;
  current_code: string | null;
  current_title: string | null;
  attempts: number;
  fails: number;
  best_average: string | null;
}

const ROSTER_SQL = `
  SELECT o.id,
         o.full_name,
         o.email::text                                   AS email,
         o.track,
         o.status,
         o.is_disabled,
         o.online_now,
         o.last_seen_at,
         o.last_activity,
         o.started_at,
         st.stages_total,
         st.stages_done,
         st.current_code,
         st.current_title,
         qa.attempts,
         qa.fails,
         ba.best_average
    FROM academy.v_trainee_overview o
    CROSS JOIN LATERAL (
      SELECT count(*)::int                                            AS stages_total,
             count(c.trainee_id)::int                                 AS stages_done,
             (array_agg(s.code ORDER BY v.position)
                FILTER (WHERE c.trainee_id IS NULL))[1]               AS current_code,
             (array_agg(s.title ORDER BY v.position)
                FILTER (WHERE c.trainee_id IS NULL))[1]               AS current_title
        FROM academy.track_visibility v
        JOIN academy.stages s ON s.id = v.stage_id AND s.is_active
        LEFT JOIN academy.stage_completions c
               ON c.stage_id = v.stage_id AND c.trainee_id = o.id
       WHERE v.track_code = o.track
    ) st
    CROSS JOIN LATERAL (
      SELECT count(*)::int                                            AS attempts,
             count(*) FILTER (WHERE NOT a.passed)::int                AS fails
        FROM academy.quiz_attempts a
       WHERE a.trainee_id = o.id
    ) qa
    CROSS JOIN LATERAL (
      SELECT round(avg(b.best), 1) AS best_average
        FROM (SELECT max(a.score_pct) AS best
                FROM academy.quiz_attempts a
                JOIN academy.quizzes q ON q.id = a.quiz_id
               WHERE a.trainee_id = o.id
               GROUP BY q.stage_id) b
    ) ba
   WHERE ($1::text IS NULL OR o.track = $1)
     AND ($2::text IS NULL OR o.full_name ILIKE $2 OR o.email::text ILIKE $2)
     AND ($3::boolean OR NOT o.is_disabled)
     AND ($4::bigint IS NULL OR o.id = $4)
   ORDER BY o.full_name, o.id
   LIMIT $5`;

/** `%term%`, with LIKE's own wildcards in the term made literal. */
function likePattern(term: string): string {
  return `%${term.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
}

/** The column has a CHECK, so this only guards against a future value. */
function toStatus(value: string): TraineeStatus {
  const parsed = TraineeStatusSchema.safeParse(value);
  return parsed.success ? parsed.data : 'ACTIVE';
}

function toRosterTrainee(r: RosterRow): RosterTrainee {
  return {
    id: Number(r.id),
    fullName: r.full_name,
    email: r.email,
    track: toTrackCode(r.track),
    status: toStatus(r.status),
    isDisabled: r.is_disabled,
    onlineNow: r.online_now,
    lastSeenAt: toIso(r.last_seen_at),
    lastActivityAt: toIso(r.last_activity),
    stagesTotal: r.stages_total,
    stagesDone: r.stages_done,
    currentStageCode: r.current_code,
    currentStageTitle: r.current_title,
    attempts: r.attempts,
    fails: r.fails,
    bestAverage: toNumber(r.best_average),
    startedAt: toIso(r.started_at) ?? '',
  };
}

export function rosterCounts(trainees: readonly RosterTrainee[]): RosterCounts {
  return {
    total: trainees.length,
    active: trainees.filter((t) => t.status === 'ACTIVE' && !t.isDisabled).length,
    disabled: trainees.filter((t) => t.isDisabled).length,
    onlineNow: trainees.filter((t) => t.onlineNow).length,
    waitingForTrack: trainees.filter((t) => t.track === null).length,
  };
}

export async function loadRoster(db: Db, filters: RosterFilters = {}): Promise<RosterTrainee[]> {
  const q = filters.q?.trim() ?? '';
  const { rows } = await db.query<RosterRow>(ROSTER_SQL, [
    filters.track ?? null,
    q === '' ? null : likePattern(q),
    filters.includeDisabled ?? true,
    filters.id ?? null,
    ROSTER_LIMIT,
  ]);
  return rows.map(toRosterTrainee);
}

export async function buildRoster(db: Db, filters: RosterFilters = {}): Promise<RosterResponse> {
  const trainees = await loadRoster(db, filters);
  return { trainees, counts: rosterCounts(trainees) };
}

// ---------------------------------------------------------------------------
// One trainee, stage by stage
// ---------------------------------------------------------------------------

interface StageStatRow {
  stage_id: string;
  attempts: number;
  fails: number;
  best: string | null;
  last_attempt_at: Date | null;
}

/** Attempts, fails, best and last attempt per stage, for one trainee. */
async function loadStageStats(
  db: Db,
  traineeId: number,
  stageIds: number[],
): Promise<Map<number, StageStatRow>> {
  const out = new Map<number, StageStatRow>();
  if (stageIds.length === 0) return out;
  const { rows } = await db.query<StageStatRow>(
    `SELECT q.stage_id,
            count(*)::int                             AS attempts,
            count(*) FILTER (WHERE NOT a.passed)::int AS fails,
            max(a.score_pct)                          AS best,
            max(a.submitted_at)                       AS last_attempt_at
       FROM academy.quiz_attempts a
       JOIN academy.quizzes q ON q.id = a.quiz_id
      WHERE a.trainee_id = $1 AND q.stage_id = ANY($2::bigint[])
      GROUP BY q.stage_id`,
    [traineeId, stageIds],
  );
  for (const r of rows) out.set(Number(r.stage_id), r);
  return out;
}

export interface TraineeDetailResult {
  trainee: RosterTrainee;
  stages: TraineeStage[];
}

/**
 * The detail a manager opens from the roster: the trainee's own row plus the
 * state of every stage in their track. `state` comes from the one gate rule
 * (stageStates), so the manager sees exactly what the trainee sees.
 * Returns null when there is no such trainee.
 */
export async function loadTraineeDetail(
  deps: ManagerDeps,
  traineeId: number,
): Promise<TraineeDetailResult | null> {
  const { db } = deps;
  const stage1AuthRequired = deps.stage1AuthRequired ?? false;
  const trainee = (await loadRoster(db, { id: traineeId, includeDisabled: true }))[0];
  if (trainee === undefined) return null;

  const visible = await visibleStages(db, traineeId);
  const progression = await loadProgression(db, traineeId, visible.stages, stage1AuthRequired);
  const states = stageStates(visible.stages, progression, stage1AuthRequired);
  const stats = await loadStageStats(
    db,
    traineeId,
    visible.stages.map((s) => s.id),
  );

  const stages: TraineeStage[] = visible.stages.map((stage, i) => {
    const stat = stats.get(stage.id);
    return {
      code: stage.code,
      title: stage.title,
      displayNum: stage.displayNum,
      level: stage.level,
      dept: stage.dept,
      state: states[i] ?? 'locked',
      attempts: stat?.attempts ?? 0,
      fails: stat?.fails ?? 0,
      best: toNumber(stat?.best ?? null),
      lastAttemptAt: toIso(stat?.last_attempt_at ?? null),
    };
  });

  return { trainee, stages };
}
