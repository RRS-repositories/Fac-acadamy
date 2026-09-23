// S06 listening beacons: POST /api/media/:recordingId/progress, and what it
// does to the quiz gate, against the real local test database
// (MIGRATION_TEST_DB_NAME) through the real app and the real sign-in.
//
// The content here is INVENTED. Three throw-away stages with one-line lessons,
// one-question quizzes and recordings that point at a media key no file backs
// — the beacon route never opens a file, it only counts seconds. Nothing from
// the prototype, no real call, no real name. Everything is created in
// beforeAll and removed in afterAll, and a leftover from a crashed run is
// cleared first.
import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type pg from 'pg';
import type { MediaProgressResponse, StageResponse } from '@fac-academy/shared';
import { TEST_DB, get, openTestDb, post, signIn } from './helpers/authHarness.js';
import type { Db, Harness, SignedIn } from './helpers/authHarness.js';

/** A real track code: the client contract only knows the nine (shared/constants). */
const TRACK = 'DEBT';
/** Fixture stages sit after every seeded stage of that track. */
const FIRST_POSITION = 900;
const DURATION = 15;

const db: Db | null = TEST_DB ? await openTestDb() : null;
if (db === null) {
  console.warn(
    '[media-progress] MIGRATION_TEST_DB_NAME is not set: skipping the beacon API tests.',
  );
}

interface Fixture {
  levelId: number;
  /** code → { stageId, lessonId } */
  stages: Map<string, { id: number; lessonId: number }>;
  /** The real recording on stage B, and the "coming soon" slot beside it. */
  realRecordingId: number;
  comingSoonRecordingId: number;
  codes: { a: string; b: string; c: string };
}

describe.skipIf(db === null)('S06 listening beacons', () => {
  let pool: pg.Pool;
  let h: Harness;
  let fx: Fixture;

  beforeAll(async () => {
    pool = db!.pool;
    h = db!.harness();
    fx = await createFixture(pool);
  });

  afterAll(async () => {
    if (db === null) return;
    await dropFixture(db.pool, fx);
    await db.cleanup();
  });

  // -------------------------------------------------------------------------
  // Helpers
  // -------------------------------------------------------------------------

  /**
   * A signed-in trainee on the fixture track, with every stage of that track
   * marked passed EXCEPT the fixture ones. Their journey therefore starts at
   * fixture stage A, whether or not the real content has been seeded.
   */
  async function trainee(): Promise<SignedIn> {
    const account = h.crm.add(db!.newAccount());
    const session = await signIn(h, account);
    await pool.query('UPDATE academy.trainees SET track = $2 WHERE id = $1', [
      session.me.id,
      TRACK,
    ]);
    await pool.query(
      `INSERT INTO academy.stage_completions (trainee_id, stage_id, completed_at, best_score)
       SELECT $1, v.stage_id, now(), 100
         FROM academy.track_visibility v
        WHERE v.track_code = $2 AND v.position < $3
       ON CONFLICT DO NOTHING`,
      [session.me.id, TRACK, FIRST_POSITION],
    );
    return session;
  }

  /** Mark a fixture stage passed, the way a quiz pass would. */
  async function passStage(traineeId: number, code: string): Promise<void> {
    await pool.query(
      `INSERT INTO academy.stage_completions (trainee_id, stage_id, completed_at, best_score)
       VALUES ($1, $2, now(), 100) ON CONFLICT DO NOTHING`,
      [traineeId, fx.stages.get(code)!.id],
    );
  }

  async function readLesson(traineeId: number, code: string): Promise<void> {
    await pool.query(
      `INSERT INTO academy.lesson_progress (trainee_id, lesson_id)
       VALUES ($1, $2) ON CONFLICT DO NOTHING`,
      [traineeId, fx.stages.get(code)!.lessonId],
    );
  }

  function beacon(session: SignedIn, recordingId: number, intervals: [number, number][]) {
    return post(h, `/api/media/${String(recordingId)}/progress`, session.cookie, { intervals });
  }

  /**
   * Listen right through, five seconds of media per beacon, with the clock
   * moving the same five seconds. This is what the player does.
   */
  async function listenInFull(
    session: SignedIn,
    recordingId: number,
  ): Promise<MediaProgressResponse> {
    let last: MediaProgressResponse | null = null;
    for (let at = 0; at < DURATION; at += 5) {
      const to = Math.min(at + 5, DURATION);
      h.clock.advance((to - at) * 1000);
      const res = await beacon(session, recordingId, [[at, to]]);
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      last = res.body as MediaProgressResponse;
    }
    return last!;
  }

  async function listenCompleteRows(traineeId: number): Promise<number> {
    const { rows } = await pool.query<{ n: string }>(
      `SELECT count(*) AS n FROM academy.audit_events
        WHERE trainee_id = $1 AND event_type = 'LISTEN_COMPLETE'`,
      [traineeId],
    );
    return Number(rows[0]?.n ?? 0);
  }

  async function getStagePayload(session: SignedIn, code: string): Promise<StageResponse> {
    const res = await get(h, `/api/stage/${code}`, session.cookie);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    return res.body as StageResponse;
  }

  function getQuiz(session: SignedIn, code: string) {
    return get(h, `/api/stage/${code}/quiz`, session.cookie);
  }

  // -------------------------------------------------------------------------
  // The route itself
  // -------------------------------------------------------------------------

  it('refuses a beacon for a recording on a locked stage', async () => {
    const session = await trainee();
    // Stage A has not been passed, so stage B is locked.
    const res = await beacon(session, fx.realRecordingId, [[0, 5]]);
    expect(res.status).toBe(403);
    expect((res.body as { error: string }).error).toBe('locked');

    const { rows } = await pool.query(
      'SELECT 1 FROM academy.listen_progress WHERE trainee_id = $1',
      [session.me.id],
    );
    expect(rows).toHaveLength(0);
  });

  it('refuses a beacon for a "coming soon" slot, which has no media', async () => {
    const session = await trainee();
    await passStage(session.me.id, fx.codes.a);
    const res = await beacon(session, fx.comingSoonRecordingId, [[0, 5]]);
    expect(res.status).toBe(404);
    expect((res.body as { error: string }).error).toBe('not_found');
  });

  it('rejects a malformed body', async () => {
    const session = await trainee();
    await passStage(session.me.id, fx.codes.a);
    for (const body of [
      {},
      { intervals: [] },
      { intervals: [[10, 5]] },
      { intervals: [['a', 'b']] },
    ]) {
      const res = await post(
        h,
        `/api/media/${String(fx.realRecordingId)}/progress`,
        session.cookie,
        body,
      );
      expect(res.status, JSON.stringify(body)).toBe(400);
      expect((res.body as { error: string }).error).toBe('invalid_request');
    }
  });

  it('marks a full listen, and writes exactly one LISTEN_COMPLETE row', async () => {
    const session = await trainee();
    await passStage(session.me.id, fx.codes.a);

    const result = await listenInFull(session, fx.realRecordingId);
    expect(result.listened).toBe(true);
    expect(result.durationSecs).toBe(DURATION);
    expect(result.coveredSecs).toBeGreaterThanOrEqual(result.requiredSecs);
    expect(await listenCompleteRows(session.me.id)).toBe(1);

    // Playing it again is not a second completion.
    h.clock.advance(5_000);
    const again = await beacon(session, fx.realRecordingId, [[0, 5]]);
    expect(again.status).toBe(200);
    expect((again.body as MediaProgressResponse).listened).toBe(true);
    expect(await listenCompleteRows(session.me.id)).toBe(1);

    const { rows } = await pool.query<{ seconds_heard: number; completed_at: Date | null }>(
      `SELECT seconds_heard, completed_at FROM academy.listen_progress
        WHERE trainee_id = $1 AND recording_id = $2`,
      [session.me.id, fx.realRecordingId],
    );
    expect(rows[0]?.completed_at).not.toBeNull();
    expect(rows[0]?.seconds_heard).toBe(DURATION);
  });

  it('does not mark a listen with a skip in it', async () => {
    const session = await trainee();
    await passStage(session.me.id, fx.codes.a);

    // Play the first five seconds, then jump to the last five.
    h.clock.advance(5_000);
    await beacon(session, fx.realRecordingId, [[0, 5]]);
    h.clock.advance(5_000);
    const res = await beacon(session, fx.realRecordingId, [[10, 15]]);
    expect(res.status).toBe(200);
    const body = res.body as MediaProgressResponse;
    expect(body.listened).toBe(false);
    expect(body.coveredSecs).toBeLessThan(DURATION);
    expect(await listenCompleteRows(session.me.id)).toBe(0);
  });

  it('refuses the whole recording claimed in one beacon', async () => {
    const session = await trainee();
    await passStage(session.me.id, fx.codes.a);
    h.clock.advance(1_000);
    const res = await beacon(session, fx.realRecordingId, [[0, DURATION]]);
    expect(res.status).toBe(200);
    expect((res.body as MediaProgressResponse).listened).toBe(false);
  });

  it('answers 429 to a flood of beacons', async () => {
    const session = await trainee();
    await passStage(session.me.id, fx.codes.a);
    let limited = false;
    for (let i = 0; i < 30 && !limited; i++) {
      const res = await beacon(session, fx.realRecordingId, [[0, 1]]);
      if (res.status === 429) {
        expect((res.body as { error: string }).error).toBe('rate_limited');
        limited = true;
      }
    }
    expect(limited).toBe(true);
  });

  // -------------------------------------------------------------------------
  // The quiz gate
  // -------------------------------------------------------------------------

  it('holds the quiz shut until the recording has been heard, then serves it', async () => {
    const session = await trainee();
    await passStage(session.me.id, fx.codes.a);
    await readLesson(session.me.id, fx.codes.b);

    const before = await post(h, `/api/stage/${fx.codes.b}/quiz`, session.cookie, {
      answers: [{ questionId: 1, optionId: 1 }],
    });
    expect(before.status).toBe(403);
    expect((before.body as { error: string }).error).toBe('recordings_incomplete');

    const stageBefore = await getStagePayload(session, fx.codes.b);
    expect(stageBefore.quiz.unlocked).toBe(false);
    expect(stageBefore.quiz.blockedBy).toBe('recordings');
    expect(stageBefore.recordings.find((r) => r.id === fx.realRecordingId)?.listened).toBe(false);
    expect(stageBefore.recordings.find((r) => r.id === fx.comingSoonRecordingId)?.comingSoon).toBe(
      true,
    );

    await listenInFull(session, fx.realRecordingId);

    const after = await getStagePayload(session, fx.codes.b);
    expect(after.quiz.unlocked).toBe(true);
    expect(after.quiz.blockedBy).toBeNull();
    expect(after.recordings.find((r) => r.id === fx.realRecordingId)?.listened).toBe(true);

    const quiz = await getQuiz(session, fx.codes.b);
    expect(quiz.status).toBe(200);
  });

  it('never blocks a quiz on a stage whose recordings are all "coming soon"', async () => {
    const session = await trainee();
    await passStage(session.me.id, fx.codes.a);
    await passStage(session.me.id, fx.codes.b);
    await readLesson(session.me.id, fx.codes.c);

    const payload = await getStagePayload(session, fx.codes.c);
    expect(payload.recordings).toHaveLength(2);
    expect(payload.recordings.every((r) => r.comingSoon)).toBe(true);
    expect(payload.quiz.blockedBy).toBeNull();
    expect(payload.quiz.unlocked).toBe(true);

    const quiz = await getQuiz(session, fx.codes.c);
    expect(quiz.status).toBe(200);
  });
});

// ---------------------------------------------------------------------------
// The fixture
// ---------------------------------------------------------------------------

async function createFixture(pool: pg.Pool): Promise<Fixture> {
  await clearLeftovers(pool);
  const tag = randomBytes(3).toString('hex');
  const codes = { a: `mt-${tag}-a`, b: `mt-${tag}-b`, c: `mt-${tag}-c` };

  const level = await pool.query<{ id: number }>(
    `INSERT INTO academy.levels (level_number, name, accomplishment, default_pass_mark)
     VALUES (90, 'Media test level', 'Nothing: this level is a test fixture.', 100)
     RETURNING id`,
  );
  const levelId = level.rows[0]!.id;

  const stages = new Map<string, { id: number; lessonId: number }>();
  let position = 1;
  for (const [code, title] of [
    [codes.a, 'Media fixture A'],
    [codes.b, 'Media fixture B'],
    [codes.c, 'Media fixture C'],
  ] as [string, string][]) {
    const stage = await pool.query<{ id: string }>(
      `INSERT INTO academy.stages
         (level_id, position, code, title, blurb, track, display_num, pass_mark)
       VALUES ($1, $2, $3, $4, 'A fixture stage. No real training content.', $5, $6, 100)
       RETURNING id`,
      [levelId, position, code, title, TRACK, `T${String(position)}`],
    );
    const stageId = Number(stage.rows[0]!.id);
    await pool.query(
      `INSERT INTO academy.track_visibility (track_code, stage_id, position)
       VALUES ($1, $2, $3)`,
      [TRACK, stageId, FIRST_POSITION + position],
    );
    const lesson = await pool.query<{ id: string }>(
      `INSERT INTO academy.lessons (stage_id, position, title, body_html)
       VALUES ($1, 1, 'Fixture lesson', '<p>Fixture text.</p>') RETURNING id`,
      [stageId],
    );
    const quiz = await pool.query<{ id: string }>(
      `INSERT INTO academy.quizzes (stage_id, pass_mark, shuffle)
       VALUES ($1, 100, FALSE) RETURNING id`,
      [stageId],
    );
    const question = await pool.query<{ id: string }>(
      `INSERT INTO academy.questions (quiz_id, position, prompt, source, approval_state)
       VALUES ($1, 1, 'Is this a fixture question?', 'HUMAN', 'APPROVED') RETURNING id`,
      [quiz.rows[0]!.id],
    );
    await pool.query(
      `INSERT INTO academy.question_options (question_id, position, body, is_correct)
       VALUES ($1, 1, 'Yes', TRUE), ($1, 2, 'No', FALSE)`,
      [question.rows[0]!.id],
    );
    stages.set(code, { id: stageId, lessonId: Number(lesson.rows[0]!.id) });
    position++;
  }

  const stageB = stages.get(codes.b)!.id;
  const stageC = stages.get(codes.c)!.id;

  // Stage B: one recording with media, one empty slot beside it (D4).
  const real = await pool.query<{ id: string }>(
    `INSERT INTO academy.call_recordings
       (stage_id, category, title, description, media_key, duration_secs, media_type, position)
     VALUES ($1, 'COACHING', 'Fixture call', 'An invented recording.',
             $2, $3, 'AUDIO', 1)
     RETURNING id`,
    [stageB, `academy/media/fixture-${tag}.mp3`, DURATION],
  );
  const soon = await pool.query<{ id: string }>(
    `INSERT INTO academy.call_recordings
       (stage_id, category, title, description, media_key, duration_secs, media_type, position)
     VALUES ($1, 'COACHING', 'Fixture slot', 'Not recorded yet.', NULL, NULL, 'AUDIO', 2)
     RETURNING id`,
    [stageB],
  );
  // Stage C: nothing but empty slots.
  await pool.query(
    `INSERT INTO academy.call_recordings
       (stage_id, category, title, description, media_key, duration_secs, media_type, position)
     VALUES ($1, 'COACHING', 'Fixture slot one', 'Not recorded yet.', NULL, NULL, 'AUDIO', 1),
            ($1, 'COACHING', 'Fixture slot two', 'Not recorded yet.', NULL, NULL, 'AUDIO', 2)`,
    [stageC],
  );

  return {
    levelId,
    stages,
    realRecordingId: Number(real.rows[0]!.id),
    comingSoonRecordingId: Number(soon.rows[0]!.id),
    codes,
  };
}

/** Anything a crashed earlier run left behind. Fixture rows only. */
async function clearLeftovers(pool: pg.Pool): Promise<void> {
  await dropStagesWhere(pool, `s.code LIKE 'mt-%'`);
  await pool.query('DELETE FROM academy.levels WHERE level_number = 90');
}

async function dropFixture(pool: pg.Pool, fx: Fixture | undefined): Promise<void> {
  if (fx === undefined) return;
  await dropStagesWhere(pool, `s.code LIKE 'mt-%'`);
  await pool.query('DELETE FROM academy.levels WHERE id = $1', [fx.levelId]);
}

/** Remove fixture stages and everything hanging off them, children first. */
async function dropStagesWhere(pool: pg.Pool, predicate: string): Promise<void> {
  const ids = `SELECT s.id FROM academy.stages s WHERE ${predicate}`;
  await pool.query(`DELETE FROM academy.listen_progress WHERE recording_id IN
      (SELECT r.id FROM academy.call_recordings r WHERE r.stage_id IN (${ids}))`);
  await pool.query(`DELETE FROM academy.attempt_answers WHERE attempt_id IN
      (SELECT a.id FROM academy.quiz_attempts a
        JOIN academy.quizzes z ON z.id = a.quiz_id WHERE z.stage_id IN (${ids}))`);
  await pool.query(`DELETE FROM academy.quiz_attempts WHERE quiz_id IN
      (SELECT z.id FROM academy.quizzes z WHERE z.stage_id IN (${ids}))`);
  await pool.query(`DELETE FROM academy.question_options WHERE question_id IN
      (SELECT q.id FROM academy.questions q
        JOIN academy.quizzes z ON z.id = q.quiz_id WHERE z.stage_id IN (${ids}))`);
  await pool.query(`DELETE FROM academy.questions WHERE quiz_id IN
      (SELECT z.id FROM academy.quizzes z WHERE z.stage_id IN (${ids}))`);
  await pool.query(`DELETE FROM academy.quizzes WHERE stage_id IN (${ids})`);
  await pool.query(`DELETE FROM academy.call_recordings WHERE stage_id IN (${ids})`);
  await pool.query(`DELETE FROM academy.lesson_progress WHERE lesson_id IN
      (SELECT l.id FROM academy.lessons l WHERE l.stage_id IN (${ids}))`);
  await pool.query(`DELETE FROM academy.lessons WHERE stage_id IN (${ids})`);
  await pool.query(`DELETE FROM academy.stage_completions WHERE stage_id IN (${ids})`);
  await pool.query(`DELETE FROM academy.track_visibility WHERE stage_id IN (${ids})`);
  await pool.query(`DELETE FROM academy.stages s WHERE ${predicate}`);
}
