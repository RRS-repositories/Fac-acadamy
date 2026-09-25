import type { Pool, PoolClient } from 'pg';
import type { CompletedProgramme, PreviousTrack, TraineeHistory } from '@fac-academy/shared';
import { toIso } from './deps.js';

// What a trainee did BEFORE the track they are on now.
//
// The trainee detail screen used to show the current track and nothing else, so
// somebody who finished the IT department academy and was then moved onto
// Management looked, to their manager, like a person four stages into Management
// with no past at all. Nothing had been deleted — progress is keyed to the
// STAGE, never to the track — it simply had nowhere to be shown.
//
// Two queries, whatever the trainee's history looks like. Never one per track.
//
//  1. loadCompletedProgrammes — the FACTS, from academy.level_completions and
//     academy.dept_completions. A level and a department academy are the only
//     things this system completes; a track is just the stage list an account
//     can see, which is why moving somebody costs them nothing.
//  2. loadPreviousTracks — reconstructed from the audit trail, because nothing
//     else records it. academy.trainees.track holds the current value only.
//
// Neither carries a lesson, a question or an answer. Names, dates and counts.

type Db = Pool | PoolClient;

interface CompletionRow {
  kind: 'LEVEL' | 'DEPT';
  ref: string;
  name: string;
  completed_at: Date;
  has_certificate: boolean;
}

/**
 * Every level and every department academy this trainee has finished, newest
 * first. The wording comes from academy.levels.name and
 * academy.departments.label at request time — the same rule the certificates
 * follow, so no programme name is ever written into this repo.
 *
 * The certificate is a yes/no. `certificate_ref` is the certificate's public
 * id, which is a bearer token for the public verification endpoint, so it stays
 * out of a response that has no use for it.
 */
async function loadCompletedProgrammes(db: Db, traineeId: number): Promise<CompletedProgramme[]> {
  const { rows } = await db.query<CompletionRow>(
    `SELECT 'LEVEL'::text                      AS kind,
            l.level_number::text               AS ref,
            l.name                             AS name,
            lc.completed_at                    AS completed_at,
            (lc.certificate_ref IS NOT NULL)   AS has_certificate
       FROM academy.level_completions lc
       JOIN academy.levels l ON l.id = lc.level_id
      WHERE lc.trainee_id = $1
      UNION ALL
     SELECT 'DEPT'::text,
            d.code,
            d.label,
            dc.completed_at,
            (dc.certificate_ref IS NOT NULL)
       FROM academy.dept_completions dc
       JOIN academy.departments d ON d.code = dc.dept
      WHERE dc.trainee_id = $1
      ORDER BY completed_at DESC, name`,
    [traineeId],
  );
  return rows.map((r) => ({
    kind: r.kind,
    ref: r.ref,
    name: r.name,
    completedAt: toIso(r.completed_at) ?? '',
    hasCertificate: r.has_certificate,
  }));
}

interface PreviousTrackRow {
  track_code: string;
  track_label: string;
  held_from: Date | null;
  held_until: Date;
  stages_passed: number;
  stages_total: number;
}

/**
 * The tracks this trainee used to be on, most recently left first.
 *
 * There is no history table, so the trail is rebuilt from the append-only
 * academy.audit_events rows the reassignment code writes: TRACK_ASSIGNED with
 * `{ from, to }` and TRACK_CLEARED with `{ from }` (modules/manager/accounts.ts
 * and ops/admin/set-track.ts write both).
 *
 * Each event is read as a moment when the held track CHANGED, so `from` on the
 * very first recorded event matters as much as `to` on the rest: it is the only
 * trace of a track somebody was put on before anybody was auditing it, and
 * dropping it would hide exactly the history this is here to show. That span's
 * start date is unknown, and is reported as null rather than guessed.
 *
 * Three things the SQL has to survive, all of them present in real data:
 *
 *  * the same track assigned twice in a row (the API audits every PUT, even one
 *    that changes nothing) — consecutive repeats collapse into one span;
 *  * a cleared track, which is a span with no track at all — dropped;
 *  * the still-open final span, which IS the current track — dropped, because
 *    the "Currently on" section above already shows it.
 *
 * A track held twice with a break in between keeps one row, spanning both: the
 * stage counts are the same either way, so two identical rows would only make
 * the screen harder to read.
 *
 * The one thing it cannot see: a track changed in the database WITHOUT writing
 * an audit row. Everything that changes a track writes one (this module and
 * ops/admin/set-track.ts), so the only way to get there is hand-edited SQL, and
 * the cost is that the last programme they were on would still read as current.
 */
async function loadPreviousTracks(db: Db, traineeId: number): Promise<PreviousTrack[]> {
  const { rows } = await db.query<PreviousTrackRow>(
    `WITH ev AS (
       SELECT e.id,
              e.created_at,
              NULLIF(e.payload->>'from', '')                       AS from_code,
              CASE WHEN e.event_type = 'TRACK_ASSIGNED'
                   THEN NULLIF(e.payload->>'to', '') END           AS to_code,
              row_number() OVER (ORDER BY e.created_at, e.id)      AS seq
         FROM academy.audit_events e
        WHERE e.trainee_id = $1
          AND e.event_type IN ('TRACK_ASSIGNED', 'TRACK_CLEARED')
     ),
     points AS (
       -- What they were on BEFORE the first recorded change. Start unknown.
       SELECT 0 AS seq, NULL::timestamptz AS held_from, from_code AS code
         FROM ev WHERE seq = 1
        UNION ALL
       -- ...and what each recorded change put them on ('to', null on a clear).
       SELECT seq, created_at, to_code FROM ev
     ),
     runs AS (
       SELECT seq, held_from, code, lag(code) OVER (ORDER BY seq) AS prev_code
         FROM points
     ),
     spans AS (
       -- One row per CHANGE of held track; the next change closes it.
       SELECT code,
              held_from,
              lead(held_from) OVER (ORDER BY seq) AS held_until
         FROM runs
        WHERE prev_code IS DISTINCT FROM code
     )
     SELECT sp.code                                        AS track_code,
            tr.label                                       AS track_label,
            -- Only the pre-audit span has an unknown start, and it is always
            -- the earliest, so a null in the group means "we do not know".
            CASE WHEN bool_or(sp.held_from IS NULL) THEN NULL
                 ELSE min(sp.held_from) END                AS held_from,
            max(sp.held_until)                             AS held_until,
            max(cnt.stages_total)                          AS stages_total,
            max(cnt.stages_passed)                         AS stages_passed
       FROM spans sp
       -- An inner join: a code that is not a track (or a null span) drops out.
       JOIN academy.tracks tr ON tr.code = sp.code
       CROSS JOIN LATERAL (
         SELECT count(*)::int                 AS stages_total,
                count(c.trainee_id)::int      AS stages_passed
           FROM academy.track_visibility v
           JOIN academy.stages s ON s.id = v.stage_id AND s.is_active
           LEFT JOIN academy.stage_completions c
                  ON c.stage_id = v.stage_id AND c.trainee_id = $1
          WHERE v.track_code = sp.code
       ) cnt
      WHERE sp.held_until IS NOT NULL
      GROUP BY sp.code, tr.label, tr.sort
      ORDER BY max(sp.held_until) DESC, tr.sort`,
    [traineeId],
  );
  return rows.map((r) => ({
    trackCode: r.track_code,
    trackLabel: r.track_label,
    heldFrom: toIso(r.held_from),
    heldUntil: toIso(r.held_until) ?? '',
    stagesPassed: r.stages_passed,
    stagesTotal: r.stages_total,
  }));
}

/**
 * Both halves of the history, in two queries. Sequential on purpose: `db` may
 * be a single PoolClient, and a client cannot carry two queries at once.
 */
export async function loadTraineeHistory(db: Db, traineeId: number): Promise<TraineeHistory> {
  const completedProgrammes = await loadCompletedProgrammes(db, traineeId);
  const previousTracks = await loadPreviousTracks(db, traineeId);
  return { completedProgrammes, previousTracks };
}
