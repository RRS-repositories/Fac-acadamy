// The one saved summary of what was said on a recording (migration 0009):
// GET and POST /api/media/:recordingId/summary, against the real local test
// database (MIGRATION_TEST_DB_NAME), through the real app, the real sign-in and
// the real gate().
//
// NO MODEL IS EVER CALLED HERE. The model is a stub that counts its calls and
// can be told to be slow or to fail, which is the whole point: the thing under
// test is that the model is asked ONCE per recording and never for a trainee who
// may not play the recording.
//
// Everything is invented. The stages, lessons and recordings are fixtures made
// in beforeAll and removed in afterAll, and the "transcript" is a few lines of
// made-up dialogue between made-up people — no real client, no real call, and
// nothing out of the prototype.
import { randomBytes } from 'node:crypto';
import type pg from 'pg';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { RecordingSummaryResponse } from '@fac-academy/shared';
import { SummaryModelError } from '../../src/media/summaryModel.js';
import type { SummaryModel, SummaryRequest } from '../../src/media/summaryModel.js';
import { TEST_DB, openTestDb, signIn } from './helpers/authHarness.js';
import type { Db, Harness, SignedIn } from './helpers/authHarness.js';

/** A real track code: only the nine exist (shared/constants). */
const TRACK = 'PAY';
/** Fixture stages sit after every seeded stage of that track. */
const FIRST_POSITION = 920;

/**
 * The invented transcript. Two invented names, a made-up matter, and nothing
 * that resembles a real client's affairs. It is deliberately long enough to be
 * recognisable if it ever showed up somewhere it should not — a log line, an
 * audit payload — and short enough to read in a diff.
 */
const TRANSCRIPT = [
  'Agent: Good morning, this is Dana from the claims team. Am I speaking to Mr Okonkwo?',
  'Client: Yes, speaking.',
  'Agent: Thank you. I am calling about the questionnaire we sent over last week.',
  'Client: I started it but I could not find the account number for the second loan.',
  'Agent: That is the most common one. It is on the top right of any statement.',
  'Client: I can look tonight. Do you need anything else?',
  'Agent: Just the two bank statements, and then we can submit.',
  'Client: Understood. I will send them this evening.',
  'Agent: Thank you. I will note that down and we will be in touch once it is in.',
].join('\n');

/** The summary the stub "writes". Recognisable, and clearly not a real summary. */
const STUB_SUMMARY = [
  'The agent called the client about an outstanding questionnaire.',
  '- The client had started the questionnaire but was missing an account number.',
  '- The agent explained where to find it on a statement.',
  '- Two bank statements are still needed before the claim can be submitted.',
  '- The client agreed to send everything the same evening.',
].join('\n');

const db: Db | null = TEST_DB ? await openTestDb() : null;
if (db === null) {
  console.warn('[media-summary] MIGRATION_TEST_DB_NAME is not set: skipping the summary tests.');
}

/**
 * The stand-in for the model. It counts every call, so "one model call per
 * recording, ever" is a number a test can assert on rather than a hope.
 *
 * `hold` lets a test freeze a call mid-flight, which is how the two-people-at-
 * once case is made deterministic instead of a race against a timer.
 */
class StubModel implements SummaryModel {
  readonly name = 'stub-model-v0';
  readonly calls: SummaryRequest[] = [];
  /** When set, every call fails with this reason and nothing is saved. */
  failWith: SummaryModelError['reason'] | null = null;
  /** When set, a call waits on this before answering. */
  hold: Promise<void> | null = null;

  async summarise(req: SummaryRequest): Promise<string> {
    this.calls.push(req);
    if (this.hold !== null) await this.hold;
    if (this.failWith !== null) {
      throw new SummaryModelError(this.failWith, 'stub');
    }
    return STUB_SUMMARY;
  }
}

interface Fixture {
  levelId: number;
  openStageId: number;
  lockedStageId: number;
  openCode: string;
  lockedCode: string;
  /** On the open stage: a transcript to work from, and one with none. */
  withTranscriptId: number;
  noTranscriptId: number;
  /** A "coming soon" slot: no media, so nothing was ever said on it (D4). */
  comingSoonId: number;
  /** On the locked stage, transcript and all: nobody may read it yet. */
  lockedRecordingId: number;
  tag: string;
}

describe.skipIf(db === null)('recording summaries', () => {
  let pool: pg.Pool;
  /** The app with a model configured (ACADEMY_CALL_SUMMARY on). */
  let h: Harness;
  let model: StubModel;
  /** The same app with no model at all (the flag off). */
  let hOff: Harness;
  let fx: Fixture;

  beforeAll(async () => {
    pool = db!.pool;
    model = new StubModel();
    h = db!.harness({ summaryModel: model });
    hOff = db!.harness();
    fx = await createFixture(pool);
  });

  afterAll(async () => {
    if (db === null) return;
    await dropFixture(db.pool, fx);
    await db.cleanup();
  });

  afterEach(async () => {
    model.calls.length = 0;
    model.failWith = null;
    model.hold = null;
    // Each test starts from "no summary yet" unless it makes one itself.
    await pool.query(
      `UPDATE academy.call_recordings
          SET summary = NULL, summary_model = NULL, summary_at = NULL
        WHERE stage_id IN ($1, $2)`,
      [fx.openStageId, fx.lockedStageId],
    );
  });

  // -------------------------------------------------------------------------
  // Helpers
  // -------------------------------------------------------------------------

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

  function summaryPath(recordingId: number): string {
    return `/api/media/${String(recordingId)}/summary`;
  }

  function getSummary(harness: Harness, session: SignedIn | null, recordingId: number) {
    const req = request(harness.app).get(summaryPath(recordingId));
    if (session !== null) req.set('Cookie', session.cookie);
    return req;
  }

  function press(harness: Harness, session: SignedIn | null, recordingId: number) {
    const req = request(harness.app).post(summaryPath(recordingId));
    if (session !== null) req.set('Cookie', session.cookie);
    return req.send();
  }

  async function storedSummary(recordingId: number): Promise<{
    summary: string | null;
    summary_model: string | null;
    summary_at: Date | null;
  }> {
    const { rows } = await pool.query<{
      summary: string | null;
      summary_model: string | null;
      summary_at: Date | null;
    }>('SELECT summary, summary_model, summary_at FROM academy.call_recordings WHERE id = $1', [
      recordingId,
    ]);
    return rows[0]!;
  }

  async function summaryAudits(traineeId: number): Promise<Record<string, unknown>[]> {
    const { rows } = await pool.query<{ payload: Record<string, unknown> }>(
      `SELECT payload FROM academy.audit_events
        WHERE trainee_id = $1 AND event_type = 'RECORDING_SUMMARISED' ORDER BY id`,
      [traineeId],
    );
    return rows.map((r) => r.payload);
  }

  /** Waits for a condition the other request in flight will make true. */
  async function until(predicate: () => boolean, what: string): Promise<void> {
    for (let i = 0; i < 200; i++) {
      if (predicate()) return;
      await new Promise((r) => setTimeout(r, 10));
    }
    throw new Error(`timed out waiting for ${what}`);
  }

  // -------------------------------------------------------------------------
  // Who may read one
  // -------------------------------------------------------------------------

  it('refuses a request with no session', async () => {
    for (const res of [
      await getSummary(h, null, fx.withTranscriptId),
      await press(h, null, fx.withTranscriptId),
    ]) {
      expect(res.status).toBe(401);
      expect(res.body).toEqual({ error: 'not_signed_in' });
    }
    expect(model.calls).toHaveLength(0);
  });

  it('refuses the summary of a locked stage, and never asks the model', async () => {
    const session = await trainee();

    const read = await getSummary(h, session, fx.lockedRecordingId);
    expect(read.status).toBe(403);
    expect(read.body).toEqual({ error: 'locked', requires: fx.openCode });

    const pressed = await press(h, session, fx.lockedRecordingId);
    expect(pressed.status).toBe(403);
    expect(pressed.body).toEqual({ error: 'locked', requires: fx.openCode });

    // The whole point of the gate here: a trainee who cannot play the recording
    // cannot read what was said on it either, and the model is never troubled.
    expect(model.calls).toHaveLength(0);
    expect((await storedSummary(fx.lockedRecordingId)).summary).toBeNull();
    expect(JSON.stringify(pressed.body)).not.toContain('Okonkwo');
  });

  it('serves it once the stage before it has been passed', async () => {
    const session = await trainee();
    await pool.query(
      `INSERT INTO academy.stage_completions (trainee_id, stage_id, completed_at, best_score)
       VALUES ($1, $2, now(), 100) ON CONFLICT DO NOTHING`,
      [session.me.id, fx.openStageId],
    );
    const res = await press(h, session, fx.lockedRecordingId);
    expect(res.status).toBe(200);
    expect((res.body as RecordingSummaryResponse).state).toBe('done');
  });

  it('answers 404 for a "coming soon" slot and for an id that does not exist', async () => {
    const session = await trainee();
    for (const id of [fx.comingSoonId, 999_999_999]) {
      const res = await press(h, session, id);
      expect(res.status, `id ${String(id)}`).toBe(404);
      expect(res.body).toEqual({ error: 'not_found' });
    }
    // An id that is not a number at all is a bad request, not a missing row.
    const bad = await request(h.app)
      .post('/api/media/not-a-number/summary')
      .set('Cookie', session.cookie)
      .send();
    expect(bad.status).toBe(400);
    expect(bad.body).toEqual({ error: 'invalid_request' });
    expect(model.calls).toHaveLength(0);
  });

  // -------------------------------------------------------------------------
  // No transcript: the state every recording is in today
  // -------------------------------------------------------------------------

  it('says the summary is not available yet when there is no transcript, and calls nothing', async () => {
    const session = await trainee();

    const read = await getSummary(h, session, fx.noTranscriptId);
    expect(read.status).toBe(200);
    expect(read.body).toEqual({
      recordingId: fx.noTranscriptId,
      state: 'no_transcript',
      summary: null,
      model: null,
      generatedAt: null,
    });

    // Pressing anyway must not invent one, and must not call the model.
    const pressed = await press(h, session, fx.noTranscriptId);
    expect(pressed.status).toBe(200);
    expect((pressed.body as RecordingSummaryResponse).state).toBe('no_transcript');
    expect(model.calls).toHaveLength(0);
    expect((await storedSummary(fx.noTranscriptId)).summary).toBeNull();
  });

  it('treats a blank transcript as no transcript at all', async () => {
    const session = await trainee();
    await pool.query('UPDATE academy.call_recordings SET transcript = $2 WHERE id = $1', [
      fx.noTranscriptId,
      '   \n  \t ',
    ]);
    try {
      const res = await press(h, session, fx.noTranscriptId);
      expect((res.body as RecordingSummaryResponse).state).toBe('no_transcript');
      expect(model.calls).toHaveLength(0);
    } finally {
      await pool.query('UPDATE academy.call_recordings SET transcript = NULL WHERE id = $1', [
        fx.noTranscriptId,
      ]);
    }
  });

  // -------------------------------------------------------------------------
  // One model call per recording, ever
  // -------------------------------------------------------------------------

  it('reports ready before the first press, without calling the model', async () => {
    const session = await trainee();
    const res = await getSummary(h, session, fx.withTranscriptId);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      recordingId: fx.withTranscriptId,
      state: 'ready',
      summary: null,
      model: null,
      generatedAt: null,
    });
    expect(model.calls).toHaveLength(0);
  });

  it('generates, saves and returns the summary on the first press', async () => {
    const session = await trainee();
    const res = await press(h, session, fx.withTranscriptId);

    expect(res.status).toBe(200);
    const body = res.body as RecordingSummaryResponse;
    expect(body.state).toBe('done');
    expect(body.summary).toBe(STUB_SUMMARY);
    expect(body.model).toBe(model.name);
    expect(body.generatedAt).not.toBeNull();
    expect(res.headers['cache-control']).toBe('no-store');

    // The model saw the transcript, and only the transcript.
    expect(model.calls).toHaveLength(1);
    expect(model.calls[0]!.transcript).toBe(TRANSCRIPT);
    expect(model.calls[0]!.recordingId).toBe(fx.withTranscriptId);

    // And it is on the recording, all three columns together (0009's CHECK).
    const stored = await storedSummary(fx.withTranscriptId);
    expect(stored.summary).toBe(STUB_SUMMARY);
    expect(stored.summary_model).toBe(model.name);
    expect(stored.summary_at).not.toBeNull();
  });

  it('serves the SAVED summary to everyone afterwards without asking the model again', async () => {
    const first = await trainee();
    await press(h, first, fx.withTranscriptId);
    expect(model.calls).toHaveLength(1);

    // The same person pressing again.
    const again = await press(h, first, fx.withTranscriptId);
    expect((again.body as RecordingSummaryResponse).summary).toBe(STUB_SUMMARY);

    // A different trainee entirely — this is the case that would otherwise cost
    // one model call per person.
    const second = await trainee();
    const theirs = await press(h, second, fx.withTranscriptId);
    expect((theirs.body as RecordingSummaryResponse).state).toBe('done');
    expect((theirs.body as RecordingSummaryResponse).summary).toBe(STUB_SUMMARY);

    // A plain read, too.
    const read = await getSummary(h, second, fx.withTranscriptId);
    expect((read.body as RecordingSummaryResponse).state).toBe('done');

    expect(model.calls).toHaveLength(1);
  });

  it('makes ONE model call when two trainees press at the same moment', async () => {
    const one = await trainee();
    const two = await trainee();

    // Freeze the model mid-answer, so the second press really does arrive while
    // the first is still waiting — no timers, no flakiness.
    let release = (): void => undefined;
    model.hold = new Promise<void>((resolve) => {
      release = resolve;
    });

    // .then() starts the request: a supertest Test does not send until it is
    // awaited, and this one has to be in flight while the second is made.
    const firstPress = press(h, one, fx.withTranscriptId).then((res) => res);
    await until(() => model.calls.length === 1, 'the first press to reach the model');

    const secondPress = await press(h, two, fx.withTranscriptId);
    // The second press did NOT start a second model call.
    expect(model.calls).toHaveLength(1);
    expect((secondPress.body as RecordingSummaryResponse).state).toBe('working');
    expect((secondPress.body as RecordingSummaryResponse).summary).toBeNull();

    release();
    const done = await firstPress;
    expect((done.body as RecordingSummaryResponse).summary).toBe(STUB_SUMMARY);
    expect(model.calls).toHaveLength(1);

    // And now the second person's next press is served the stored text.
    const retry = await press(h, two, fx.withTranscriptId);
    expect((retry.body as RecordingSummaryResponse).state).toBe('done');
    expect(model.calls).toHaveLength(1);
  });

  it('audits the press that made the summary, once, with no transcript in the payload', async () => {
    const session = await trainee();
    await press(h, session, fx.withTranscriptId);
    await press(h, session, fx.withTranscriptId);

    const rows = await summaryAudits(session.me.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      recordingId: fx.withTranscriptId,
      stage: fx.openCode,
      model: model.name,
      summaryChars: STUB_SUMMARY.length,
      transcriptChars: TRANSCRIPT.length,
    });
    const asText = JSON.stringify(rows[0]);
    expect(asText).not.toContain('Okonkwo');
    expect(asText).not.toContain('questionnaire');

    // Somebody served the stored text earns no audit row of their own.
    const other = await trainee();
    await press(h, other, fx.withTranscriptId);
    expect(await summaryAudits(other.me.id)).toHaveLength(0);
  });

  // -------------------------------------------------------------------------
  // When the model lets us down
  // -------------------------------------------------------------------------

  it('saves nothing and says so when the model fails, and the next press works', async () => {
    const session = await trainee();
    model.failWith = 'refused';

    const failed = await press(h, session, fx.withTranscriptId);
    expect(failed.status).toBe(502);
    expect(failed.body).toEqual({ error: 'summary_failed' });
    expect((await storedSummary(fx.withTranscriptId)).summary).toBeNull();

    // Still 'ready', not stuck in some half state: the button can be pressed again.
    const read = await getSummary(h, session, fx.withTranscriptId);
    expect((read.body as RecordingSummaryResponse).state).toBe('ready');

    model.failWith = null;
    const second = await press(h, session, fx.withTranscriptId);
    expect(second.status).toBe(200);
    expect((second.body as RecordingSummaryResponse).summary).toBe(STUB_SUMMARY);
    expect(model.calls).toHaveLength(2);
  });

  it('answers the same way on a timeout, and leaves nothing claimed behind it', async () => {
    const session = await trainee();
    model.failWith = 'timeout';

    const first = await press(h, session, fx.withTranscriptId);
    expect(first.status).toBe(502);

    // The proof that the claim was released: a second press reaches the model
    // instead of being told somebody else is working on it.
    const second = await press(h, session, fx.withTranscriptId);
    expect(second.status).toBe(502);
    expect(model.calls).toHaveLength(2);
  });

  // -------------------------------------------------------------------------
  // Switched off
  // -------------------------------------------------------------------------

  it('reports the feature as disabled when no model is configured', async () => {
    const account = hOff.crm.add(db!.newAccount());
    const session = await signIn(hOff, account);
    await pool.query('UPDATE academy.trainees SET track = $2 WHERE id = $1', [
      session.me.id,
      TRACK,
    ]);

    for (const res of [
      await getSummary(hOff, session, fx.withTranscriptId),
      await press(hOff, session, fx.withTranscriptId),
    ]) {
      expect(res.status).toBe(200);
      expect(res.body).toEqual({
        recordingId: fx.withTranscriptId,
        state: 'disabled',
        summary: null,
        model: null,
        generatedAt: null,
      });
    }
    expect(model.calls).toHaveLength(0);
    expect((await storedSummary(fx.withTranscriptId)).summary).toBeNull();
  });

  it('answers 503 for both verbs while the ACADEMY_V2 flag is off', async () => {
    const off = db!.harness({ flagEnabled: false, summaryModel: model });
    for (const res of [
      await request(off.app).get(summaryPath(fx.withTranscriptId)),
      await request(off.app).post(summaryPath(fx.withTranscriptId)).send(),
    ]) {
      expect(res.status).toBe(503);
      expect(res.body).toMatchObject({ flag: 'off' });
    }
    expect(model.calls).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Fixture
// ---------------------------------------------------------------------------

async function createFixture(pool: pg.Pool): Promise<Fixture> {
  await clearLeftovers(pool);
  const tag = randomBytes(3).toString('hex');
  const openCode = `sy-${tag}-open`;
  const lockedCode = `sy-${tag}-locked`;

  const level = await pool.query<{ id: number }>(
    `INSERT INTO academy.levels (level_number, name, accomplishment, default_pass_mark)
     VALUES (92, 'Summary test level', 'Nothing: this level is a test fixture.', 100)
     RETURNING id`,
  );
  const levelId = level.rows[0]!.id;

  async function stage(code: string, title: string, position: number): Promise<number> {
    const res = await pool.query<{ id: string }>(
      `INSERT INTO academy.stages (level_id, position, title, blurb, track, display_num, pass_mark, code)
       VALUES ($1, $2, $3, 'A fixture stage. No real training content.', $4, $5, 100, $6)
       RETURNING id`,
      [levelId, position, title, TRACK, `S${String(position)}`, code],
    );
    const id = Number(res.rows[0]!.id);
    await pool.query(
      `INSERT INTO academy.track_visibility (track_code, stage_id, position)
       VALUES ($1, $2, $3)`,
      [TRACK, id, FIRST_POSITION + position],
    );
    await pool.query(
      `INSERT INTO academy.lessons (stage_id, position, title, body_html)
       VALUES ($1, 1, 'Fixture lesson', '<p>Fixture text.</p>')`,
      [id],
    );
    return id;
  }

  const openStageId = await stage(openCode, 'Summary fixture (open)', 1);
  const lockedStageId = await stage(lockedCode, 'Summary fixture (locked)', 2);

  async function recording(
    stageId: number,
    title: string,
    position: number,
    opts: { mediaKey: string | null; transcript: string | null },
  ): Promise<number> {
    const res = await pool.query<{ id: string }>(
      `INSERT INTO academy.call_recordings
         (stage_id, category, title, description, media_key, duration_secs, media_type,
          position, content_type, transcript, transcript_status)
       VALUES ($1, 'COACHING', $2, 'An invented recording.', $3, 10, 'AUDIO', $4,
               CASE WHEN $3::text IS NULL THEN NULL ELSE 'audio/mpeg' END, $5,
               CASE WHEN $5::text IS NULL THEN 'PENDING' ELSE 'DONE' END)
       RETURNING id`,
      [stageId, title, opts.mediaKey, position, opts.transcript],
    );
    return Number(res.rows[0]!.id);
  }

  const key = `academy/media/fixture-summary-${tag}.mp3`;
  return {
    levelId,
    openStageId,
    lockedStageId,
    openCode,
    lockedCode,
    withTranscriptId: await recording(openStageId, 'Fixture call with a transcript', 1, {
      mediaKey: key,
      transcript: TRANSCRIPT,
    }),
    noTranscriptId: await recording(openStageId, 'Fixture call with no transcript', 2, {
      mediaKey: key,
      transcript: null,
    }),
    comingSoonId: await recording(openStageId, 'Fixture slot', 3, {
      mediaKey: null,
      transcript: null,
    }),
    lockedRecordingId: await recording(lockedStageId, 'Fixture call behind a lock', 1, {
      mediaKey: key,
      transcript: TRANSCRIPT,
    }),
    tag,
  };
}

async function clearLeftovers(pool: pg.Pool): Promise<void> {
  await dropStagesWhere(pool, `s.code LIKE 'sy-%'`);
  await pool.query('DELETE FROM academy.levels WHERE level_number = 92');
}

async function dropFixture(pool: pg.Pool, fx: Fixture | undefined): Promise<void> {
  if (fx === undefined) return;
  await dropStagesWhere(pool, `s.code LIKE 'sy-%'`);
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
