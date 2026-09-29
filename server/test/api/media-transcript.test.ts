// GET /api/media/:recordingId/transcript (migration 0010), against the real
// local test database (MIGRATION_TEST_DB_NAME), through the real app, the real
// sign-in and the real gate().
//
// A transcript is THE CONTENT OF A REAL CLIENT CALL written down, which makes it
// exactly as sensitive as the audio. So the thing under test is mostly WHO MAY
// READ ONE: a trainee who could play the recording, and nobody else. A transcript
// of a locked stage's call is the locked stage's content, verbatim.
//
// Everything is invented. The stages and recordings are fixtures made in
// beforeAll and removed in afterAll, and the "transcript" is three made-up lines
// between two made-up people — no real client, no real call, nothing out of the
// prototype.
import { randomBytes } from 'node:crypto';
import type pg from 'pg';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { RecordingTranscriptResponse } from '@fac-academy/shared';
import { TEST_DB, openTestDb, signIn } from './helpers/authHarness.js';
import type { Db, Harness, SignedIn } from './helpers/authHarness.js';

const TRACK = 'PAY';
const FIRST_POSITION = 930;

/** Invented lines between invented people, with invented timings. */
const SEGMENTS = [
  { start: 0, end: 4.25, text: 'Good morning, this is Dana from the claims team.' },
  { start: 4.25, end: 6, text: 'Yes, speaking.' },
  { start: 6.5, end: 11.75, text: 'I am calling about the questionnaire we sent last week.' },
];
const TRANSCRIPT = SEGMENTS.map((s) => s.text).join(String.fromCharCode(10));

const db: Db | null = TEST_DB ? await openTestDb() : null;
if (db === null) {
  console.warn('[media-transcript] MIGRATION_TEST_DB_NAME is not set: skipping these tests.');
}

interface Fixture {
  levelId: number;
  openStageId: number;
  lockedStageId: number;
  /** On the open stage: timed, text with no timings, none at all, failed. */
  timedId: number;
  textOnlyId: number;
  noneId: number;
  failedId: number;
  /** A "coming soon" slot: no media, so nothing was ever said on it (D4). */
  comingSoonId: number;
  /** On the locked stage, transcript and all: nobody may read it yet. */
  lockedRecordingId: number;
}

describe.skipIf(db === null)('the transcript endpoint', () => {
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

  /** A signed-in trainee whose journey starts at the fixture's open stage. */
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

  function path(recordingId: number): string {
    return `/api/media/${String(recordingId)}/transcript`;
  }

  function fetchTranscript(session: SignedIn | null, recordingId: number) {
    const req = request(h.app).get(path(recordingId));
    if (session !== null) req.set('Cookie', session.cookie);
    return req;
  }

  it('serves the transcript and its timings to a trainee who may play the recording', async () => {
    const session = await trainee();
    const res = await fetchTranscript(session, fx.timedId);

    expect(res.status).toBe(200);
    const body = res.body as RecordingTranscriptResponse;
    expect(body).toEqual({
      recordingId: fx.timedId,
      status: 'DONE',
      text: TRANSCRIPT,
      segments: SEGMENTS,
    });
    // Per-person and access-checked on every request, like the bytes themselves:
    // no shared cache and no disk copy may keep a transcript.
    expect(res.headers['cache-control']).toBe('private, no-store');
  });

  it('serves text with no timings as text with no timings', async () => {
    // What a transcript typed in by a person looks like. The panel says it cannot
    // follow along; nothing here invents times so that something can be
    // highlighted.
    const session = await trainee();
    const res = await fetchTranscript(session, fx.textOnlyId);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ text: TRANSCRIPT, segments: [] });
  });

  it('says plainly that there is no transcript, rather than pretending', async () => {
    const session = await trainee();
    for (const [id, status] of [
      [fx.noneId, 'PENDING'],
      [fx.failedId, 'FAILED'],
    ] as const) {
      const res = await fetchTranscript(session, id);
      expect(res.status).toBe(200);
      // The status is passed through so the panel can tell "not done yet" from
      // "tried and failed" — different things to say to somebody waiting.
      expect(res.body).toEqual({ recordingId: id, status, text: null, segments: [] });
    }
  });

  it('REFUSES the transcript of a locked stage, with the same 403 as the bytes', async () => {
    // The one that matters. A transcript of a locked stage's call is the locked
    // stage's content in full, so being able to read it would be a way past the
    // gate that the streaming endpoint closes.
    const session = await trainee();
    const res = await fetchTranscript(session, fx.lockedRecordingId);
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ error: 'locked' });
    expect(JSON.stringify(res.body)).not.toContain('Dana');
  });

  it('refuses a visitor with no session', async () => {
    const res = await fetchTranscript(null, fx.timedId);
    expect(res.status).toBe(401);
    expect(JSON.stringify(res.body)).not.toContain('Dana');
  });

  it('answers 404 for a "coming soon" slot, an unknown id and a malformed one', async () => {
    const session = await trainee();
    // A slot with no media has nothing that was said on it, and answers exactly
    // like a recording that does not exist (D4).
    expect((await fetchTranscript(session, fx.comingSoonId)).status).toBe(404);
    expect((await fetchTranscript(session, 987_654_321)).status).toBe(404);
    const bad = await request(h.app).get('/api/media/not-a-number/transcript').set({
      Cookie: session.cookie,
    });
    expect(bad.status).toBe(400);
  });

  it('answers 503 while the ACADEMY_V2 flag is off', async () => {
    const off = db!.harness({ flagEnabled: false });
    const res = await request(off.app).get(path(fx.timedId));
    expect(res.status).toBe(503);
    expect(res.body).toMatchObject({ flag: 'off' });
  });

  it('has no verb that writes a transcript', async () => {
    // Transcripts are written by the worker and by ops/media/transcribe.ts, away
    // from any request. A trainee can neither cause one nor correct one.
    const session = await trainee();
    for (const method of ['post', 'put', 'patch', 'delete'] as const) {
      const res = await request(h.app)[method](path(fx.timedId)).set('Cookie', session.cookie);
      expect(res.status, method).not.toBe(200);
    }
    const { rows } = await pool.query<{ transcript: string | null }>(
      'SELECT transcript FROM academy.call_recordings WHERE id = $1',
      [fx.timedId],
    );
    expect(rows[0]!.transcript).toBe(TRANSCRIPT);
  });
});

// ---------------------------------------------------------------------------
// Fixture
// ---------------------------------------------------------------------------

async function createFixture(pool: pg.Pool): Promise<Fixture> {
  await clearLeftovers(pool);
  const tag = randomBytes(3).toString('hex');

  const level = await pool.query<{ id: number }>(
    `INSERT INTO academy.levels (level_number, name, accomplishment, default_pass_mark)
     VALUES (93, 'Transcript test level', 'Nothing: this level is a test fixture.', 100)
     RETURNING id`,
  );
  const levelId = level.rows[0]!.id;

  async function stage(code: string, title: string, position: number): Promise<number> {
    const res = await pool.query<{ id: string }>(
      `INSERT INTO academy.stages (level_id, position, title, blurb, track, display_num, pass_mark, code)
       VALUES ($1, $2, $3, 'A fixture stage. No real training content.', $4, $5, 100, $6)
       RETURNING id`,
      [levelId, position, title, TRACK, `T${String(position)}`, code],
    );
    const id = Number(res.rows[0]!.id);
    await pool.query(
      `INSERT INTO academy.track_visibility (track_code, stage_id, position) VALUES ($1, $2, $3)`,
      [TRACK, id, FIRST_POSITION + position],
    );
    await pool.query(
      `INSERT INTO academy.lessons (stage_id, position, title, body_html)
       VALUES ($1, 1, 'Fixture lesson', '<p>Fixture text.</p>')`,
      [id],
    );
    return id;
  }

  const openStageId = await stage(`tx-${tag}-open`, 'Transcript fixture (open)', 1);
  const lockedStageId = await stage(`tx-${tag}-locked`, 'Transcript fixture (locked)', 2);

  async function recording(
    stageId: number,
    title: string,
    position: number,
    opts: {
      mediaKey: string | null;
      transcript: string | null;
      segments: typeof SEGMENTS | null;
      status: 'PENDING' | 'DONE' | 'FAILED';
    },
  ): Promise<number> {
    const res = await pool.query<{ id: string }>(
      `INSERT INTO academy.call_recordings
         (stage_id, category, title, description, media_key, duration_secs, media_type,
          position, content_type, transcript, transcript_segments, transcript_engine,
          transcript_at, transcript_status)
       VALUES ($1, 'COACHING', $2, 'An invented recording.', $3, 12, 'AUDIO', $4,
               CASE WHEN $3::text IS NULL THEN NULL ELSE 'audio/mpeg' END,
               $5, $6::jsonb,
               CASE WHEN $6::text IS NULL THEN NULL ELSE 'fixture-engine' END,
               CASE WHEN $6::text IS NULL THEN NULL ELSE now() END,
               $7)
       RETURNING id`,
      [
        stageId,
        title,
        opts.mediaKey,
        position,
        opts.transcript,
        opts.segments === null ? null : JSON.stringify(opts.segments),
        opts.status,
      ],
    );
    return Number(res.rows[0]!.id);
  }

  const key = `academy/media/fixture-transcript-${tag}.mp3`;
  return {
    levelId,
    openStageId,
    lockedStageId,
    timedId: await recording(openStageId, 'Fixture call, timed transcript', 1, {
      mediaKey: key,
      transcript: TRANSCRIPT,
      segments: SEGMENTS,
      status: 'DONE',
    }),
    textOnlyId: await recording(openStageId, 'Fixture call, transcript typed in', 2, {
      mediaKey: key,
      transcript: TRANSCRIPT,
      segments: null,
      status: 'DONE',
    }),
    noneId: await recording(openStageId, 'Fixture call, not transcribed', 3, {
      mediaKey: key,
      transcript: null,
      segments: null,
      status: 'PENDING',
    }),
    failedId: await recording(openStageId, 'Fixture call, transcription failed', 4, {
      mediaKey: key,
      transcript: null,
      segments: null,
      status: 'FAILED',
    }),
    comingSoonId: await recording(openStageId, 'Fixture slot', 5, {
      mediaKey: null,
      transcript: null,
      segments: null,
      status: 'PENDING',
    }),
    lockedRecordingId: await recording(lockedStageId, 'Fixture call behind a lock', 1, {
      mediaKey: key,
      transcript: TRANSCRIPT,
      segments: SEGMENTS,
      status: 'DONE',
    }),
  };
}

async function clearLeftovers(pool: pg.Pool): Promise<void> {
  await dropStagesWhere(pool, `s.code LIKE 'tx-%'`);
  await pool.query('DELETE FROM academy.levels WHERE level_number = 93');
}

async function dropFixture(pool: pg.Pool, fx: Fixture | undefined): Promise<void> {
  if (fx === undefined) return;
  await dropStagesWhere(pool, `s.code LIKE 'tx-%'`);
  await pool.query('DELETE FROM academy.levels WHERE id = $1', [fx.levelId]);
}

async function dropStagesWhere(pool: pg.Pool, predicate: string): Promise<void> {
  const ids = `SELECT s.id FROM academy.stages s WHERE ${predicate}`;
  await pool.query(`DELETE FROM academy.listen_progress WHERE recording_id IN
      (SELECT r.id FROM academy.call_recordings r WHERE r.stage_id IN (${ids}))`);
  await pool.query(`DELETE FROM academy.call_recordings WHERE stage_id IN (${ids})`);
  await pool.query(`DELETE FROM academy.lesson_progress WHERE lesson_id IN
      (SELECT l.id FROM academy.lessons l WHERE l.stage_id IN (${ids}))`);
  await pool.query(`DELETE FROM academy.lessons WHERE stage_id IN (${ids})`);
  await pool.query(`DELETE FROM academy.stage_completions WHERE stage_id IN (${ids})`);
  await pool.query(`DELETE FROM academy.track_visibility WHERE stage_id IN (${ids})`);
  await pool.query(`DELETE FROM academy.stages s WHERE ${predicate}`);
}
