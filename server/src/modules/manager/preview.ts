import type { Pool, PoolClient } from 'pg';
import { DEFAULT_PASS_MARK } from '@fac-academy/shared';
import type { PreviewStage, PreviewTrackResponse, TrackCode } from '@fac-academy/shared';

// "Preview as track" (build spec, manager-only). A manager picks a track and
// sees the journey that track gets: which stages, in what order, how much is
// in each one. It is READ ONLY in the strongest sense — no lesson_progress, no
// listen_progress, no attempt, no completion row is written for anybody, and
// the manager's own progress is untouched. It is one SELECT.
//
// What it must NEVER return: lesson bodies, question text, options or the
// `correct` flag. Counts only. A manager who wants to read the training signs
// in and takes it; the answers stay on the server (D3).

type Db = Pool | PoolClient;

interface PreviewRow {
  code: string;
  title: string;
  display_num: string;
  level_number: number | null;
  dept: string | null;
  position: number;
  lesson_count: number;
  recording_count: number;
  question_count: number;
  pass_mark: number;
}

/**
 * The same visibility and pass-mark rules as the trainee's own track list
 * (training/repo.ts VISIBLE_STAGES_SQL), plus the content counts. Deliberately
 * NOT a join through call_recordings' media column: what a manager needs here
 * is how many recording slots the stage has, which is the S06 media work's
 * business to fill.
 */
const PREVIEW_SQL = `
  SELECT s.code,
         s.title,
         COALESCE(s.display_num, '')                                      AS display_num,
         l.level_number,
         s.dept,
         v.position::int                                                  AS position,
         (SELECT count(*) FROM academy.lessons le
           WHERE le.stage_id = s.id)::int                                 AS lesson_count,
         (SELECT count(*) FROM academy.call_recordings r
           WHERE r.stage_id = s.id AND r.is_active)::int                  AS recording_count,
         (SELECT count(*) FROM academy.questions qq
            JOIN academy.quizzes zz ON zz.id = qq.quiz_id
           WHERE zz.stage_id = s.id AND qq.is_active
             AND qq.approval_state = 'APPROVED')::int                     AS question_count,
         COALESCE(q.pass_mark, s.pass_mark, l.default_pass_mark, $2)::int AS pass_mark
    FROM academy.track_visibility v
    JOIN academy.stages s ON s.id = v.stage_id AND s.is_active
    LEFT JOIN academy.levels l  ON l.id = s.level_id
    LEFT JOIN academy.quizzes q ON q.stage_id = s.id
   WHERE v.track_code = $1
   ORDER BY v.position`;

export async function previewTrack(db: Db, track: TrackCode): Promise<PreviewTrackResponse> {
  const { rows } = await db.query<PreviewRow>(PREVIEW_SQL, [track, DEFAULT_PASS_MARK]);
  const stages: PreviewStage[] = rows.map((r) => ({
    code: r.code,
    title: r.title,
    displayNum: r.display_num,
    level: r.level_number,
    dept: r.dept,
    position: r.position,
    lessonCount: r.lesson_count,
    recordingCount: r.recording_count,
    questionCount: r.question_count,
    passMark: r.pass_mark,
  }));
  return { track, stages };
}
