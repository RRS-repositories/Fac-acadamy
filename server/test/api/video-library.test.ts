// The video library (19 Oct): GET /api/videos and
// GET /api/videos/:videoId/stream, against the real local test database
// (MIGRATION_TEST_DB_NAME), through the real app and the real sign-in.
//
// A video is on the shelf exactly when its call_recordings row has no stage.
// Nothing here is gated, because there is no stage to be locked behind — so the
// tests that matter most are the NEGATIVE ones, and most of this file is them:
//
//   * what the list leaves out: a stage-attached video, a stage-less AUDIO row,
//     an empty "coming soon" slot and a withdrawn row;
//   * that the library route cannot serve a recording which belongs to a stage,
//     proved with the id of a real recording on a LOCKED stage;
//   * that the gated route is exactly as it was: a stage-less row still 404s
//     there, and a locked stage's recording is still refused there.
//
// Decision D15: there is no S3. The file the tests stream is INVENTED — a few
// kilobytes of a counting pattern this file writes into a throw-away MEDIA_ROOT
// under the system temp folder. No real recording, no prototype media. The
// stages, the library rows and the accounts are all fixtures, created in
// beforeAll and removed in afterAll.
import { randomBytes } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type pg from 'pg';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { LibraryVideoSchema, VideoLibraryResponseSchema } from '@fac-academy/shared';
import { createLocalMediaStore } from '../../src/media/store.js';
import type { MediaStore } from '../../src/media/store.js';
import { TEST_DB, openTestDb, signIn } from './helpers/authHarness.js';
import type { Db, Harness, SignedIn } from './helpers/authHarness.js';

/** A real track code: only the nine exist (shared/constants). */
const TRACK = 'PAY';
/** Fixture stages sit after every seeded stage of that track. */
const FIRST_POSITION = 930;
/** Invented bytes: a counting pattern, so every assertion can name them. */
const PAYLOAD = Buffer.from(Uint8Array.from({ length: 4096 }, (_, i) => i % 251));
const VIDEO_TYPE = 'video/mp4';

const db: Db | null = TEST_DB ? await openTestDb() : null;
if (db === null) {
  console.warn('[video-library] MIGRATION_TEST_DB_NAME is not set: skipping the library tests.');
}

interface Fixture {
  levelId: number;
  /** The open stage, and the one locked behind it. */
  openStageId: number;
  lockedStageId: number;
  openCode: string;
  /** A VIDEO on the LOCKED stage: the id an attacker would try on the shelf. */
  lockedVideoId: number;
  /** On the shelf, in the order the list must put them. */
  firstId: number;
  secondId: number;
  /** On the shelf but with no `position`: it belongs at the end. */
  unorderedId: number;
  /** Stage-less, and each one a reason to be left off the shelf. */
  audioId: number;
  slotId: number;
  inactiveId: number;
  mediaKey: string;
  tag: string;
}

/** Collects the raw body: supertest has no parser for video/mp4. */
function binaryParser(
  res: NodeJS.ReadableStream & { setEncoding: (enc: string) => void },
  cb: (err: Error | null, body: Buffer) => void,
): void {
  res.setEncoding('binary');
  let data = '';
  res.on('data', (chunk: string) => {
    data += chunk;
  });
  res.on('end', () => {
    cb(null, Buffer.from(data, 'binary'));
  });
}

describe.skipIf(db === null)('the video library', () => {
  let pool: pg.Pool;
  let h: Harness;
  let fx: Fixture;
  let mediaRoot: string;
  let store: MediaStore;

  beforeAll(async () => {
    pool = db!.pool;
    mediaRoot = await mkdtemp(join(tmpdir(), 'academy-library-'));
    store = createLocalMediaStore(mediaRoot);
    h = db!.harness({ mediaStore: store });
    fx = await createFixture(pool);
    await store.put(fx.mediaKey, PAYLOAD, { contentType: VIDEO_TYPE });
  });

  afterAll(async () => {
    if (db === null) return;
    await dropFixture(db.pool);
    await db.cleanup();
    await rm(mediaRoot, { recursive: true, force: true });
  });

  // -------------------------------------------------------------------------
  // Helpers
  // -------------------------------------------------------------------------

  /**
   * A signed-in trainee on the fixture track with every seeded stage of that
   * track already passed, so their journey starts at the fixture open stage and
   * the fixture locked stage really is locked for them.
   */
  async function trainee(harness: Harness = h): Promise<SignedIn> {
    const account = harness.crm.add(db!.newAccount());
    const session = await signIn(harness, account);
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

  function list(session: SignedIn | null, harness: Harness = h) {
    const req = request(harness.app).get('/api/videos');
    if (session !== null) req.set('Cookie', session.cookie);
    return req;
  }

  function play(session: SignedIn | null, videoId: number, harness: Harness = h) {
    const req = request(harness.app).get(`/api/videos/${String(videoId)}/stream`);
    if (session !== null) req.set('Cookie', session.cookie);
    return req;
  }

  function playBytes(session: SignedIn, videoId: number, range?: string) {
    const req = play(session, videoId);
    if (range !== undefined) req.set('Range', range);
    return req.buffer(true).parse(binaryParser as never);
  }

  /** The gated route, for the regression tests. */
  function gatedStream(session: SignedIn, recordingId: number) {
    return request(h.app)
      .get(`/api/media/${String(recordingId)}/stream`)
      .set('Cookie', session.cookie);
  }

  async function ids(session: SignedIn): Promise<number[]> {
    const res = await list(session);
    expect(res.status).toBe(200);
    const body = VideoLibraryResponseSchema.parse(res.body);
    return body.videos.map((v) => v.id);
  }

  // -------------------------------------------------------------------------
  // Who may see the shelf at all
  // -------------------------------------------------------------------------

  it('refuses the list and the stream with no session', async () => {
    const listed = await list(null);
    expect(listed.status).toBe(401);
    expect(listed.body).toEqual({ error: 'not_signed_in' });

    const played = await play(null, fx.firstId);
    expect(played.status).toBe(401);
    expect(played.body).toEqual({ error: 'not_signed_in' });
  });

  it('refuses a session cookie that was never issued', async () => {
    const cookie = `academy_sid=${randomBytes(32).toString('base64url')}`;
    for (const path of ['/api/videos', `/api/videos/${String(fx.firstId)}/stream`]) {
      const res = await request(h.app).get(path).set('Cookie', cookie);
      expect(res.status, path).toBe(401);
    }
  });

  it('answers 503 { flag: "off" } on both routes while ACADEMY_V2 is off', async () => {
    // The flag gate sits on /api before every router, so it answers before
    // requireAuth does: a switched-off academy has no library, signed in or not.
    const off = db!.harness({ mediaStore: store, flagEnabled: false });
    for (const path of ['/api/videos', `/api/videos/${String(fx.firstId)}/stream`]) {
      const res = await request(off.app).get(path);
      expect(res.status, path).toBe(503);
      expect(res.body, path).toEqual({ flag: 'off' });
    }
  });

  // -------------------------------------------------------------------------
  // What the list holds, and — the point — what it does not
  // -------------------------------------------------------------------------

  it('lists the stage-less, active, media-bearing videos and nothing else', async () => {
    const session = await trainee();
    const listed = await ids(session);

    expect(listed).toContain(fx.firstId);
    expect(listed).toContain(fx.secondId);
    expect(listed).toContain(fx.unorderedId);

    // Every negative, one at a time, so a failure names the rule that broke.
    expect(listed, 'a video that belongs to a stage').not.toContain(fx.lockedVideoId);
    expect(listed, 'a stage-less AUDIO recording').not.toContain(fx.audioId);
    expect(listed, 'an empty "coming soon" slot').not.toContain(fx.slotId);
    expect(listed, 'a withdrawn (is_active = false) row').not.toContain(fx.inactiveId);
  });

  it('orders the shelf by position, then by id, and puts an unordered row last', async () => {
    const session = await trainee();
    const listed = (await ids(session)).filter((id) =>
      [fx.firstId, fx.secondId, fx.unorderedId].includes(id),
    );
    // first has position 1, second has position 2, unordered has none.
    expect(listed).toEqual([fx.firstId, fx.secondId, fx.unorderedId]);

    // Stable: the same order on a second call, which is what the id tiebreak
    // buys. Without it Postgres may return rows that tie in either order.
    expect(await ids(session)).toEqual(await ids(session));
  });

  it('returns exactly the contract, with no media key, path, type or size in it', async () => {
    const session = await trainee();
    const res = await list(session);
    expect(res.status).toBe(200);
    expect(res.headers['cache-control']).toBe('private, no-store');

    const body = res.body as { videos: Record<string, unknown>[] };
    const video = body.videos.find((v) => v.id === fx.firstId);
    expect(video).toBeDefined();
    // The keys ARE the contract's keys — no extras, whatever the table grows.
    expect(Object.keys(video!).sort()).toEqual(['description', 'durationSecs', 'id', 'title']);
    expect(LibraryVideoSchema.safeParse(video).success).toBe(true);
    expect(JSON.stringify(res.body)).not.toContain(fx.mediaKey);
    expect(JSON.stringify(res.body)).not.toContain('academy/media');
    expect(JSON.stringify(res.body)).not.toContain(mediaRoot);
  });

  it('carries a null description and a null duration through honestly', async () => {
    const session = await trainee();
    const res = await list(session);
    const body = VideoLibraryResponseSchema.parse(res.body);
    const unordered = body.videos.find((v) => v.id === fx.unorderedId);
    expect(unordered).toMatchObject({ description: null, durationSecs: null });
  });

  // -------------------------------------------------------------------------
  // The library route cannot be a second door into stage content
  // -------------------------------------------------------------------------

  it('will not stream a recording that belongs to a LOCKED stage', async () => {
    // The whole security question in one test: somebody who knows the id of a
    // recording on a stage they have not unlocked asks for it through the
    // library route, where there is no gate() to stop them. loadLibraryRecording
    // requires stage_id IS NULL, so the row is simply not there to be served.
    const session = await trainee();

    // Proof the id really is a locked stage's recording: the gated route — the
    // only route that may serve it — refuses it with a lock.
    const gated = await gatedStream(session, fx.lockedVideoId);
    expect(gated.status).toBe(403);
    expect(gated.body).toEqual({ error: 'locked', requires: fx.openCode });

    const res = await play(session, fx.lockedVideoId);
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: 'not_found' });
    // Nothing about the file leaked on the way out.
    expect(res.headers['content-range']).toBeUndefined();
    expect(res.headers['content-type']).not.toContain('video');
    expect(res.headers['accept-ranges']).toBeUndefined();
  });

  it('will not stream a recording on an UNLOCKED stage either', async () => {
    // Same rule, and worth pinning separately: the library route refuses stage
    // content because it HAS a stage, not because that stage happens to be
    // locked. Unlock it and the library still says no; only /api/media serves it.
    const session = await trainee();
    await pool.query(
      `INSERT INTO academy.stage_completions (trainee_id, stage_id, completed_at, best_score)
       VALUES ($1, $2, now(), 100) ON CONFLICT DO NOTHING`,
      [session.me.id, fx.openStageId],
    );
    const gated = await gatedStream(session, fx.lockedVideoId);
    expect(gated.status).toBe(200);

    const res = await play(session, fx.lockedVideoId);
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: 'not_found' });
  });

  it('answers 404 for a stage-less AUDIO row, an empty slot, a withdrawn row and nonsense ids', async () => {
    const session = await trainee();
    for (const id of [fx.audioId, fx.slotId, fx.inactiveId, 999_999_999, 0, -1]) {
      const res = await play(session, id);
      expect(res.status, `id ${String(id)}`).toBe(404);
      expect(res.body, `id ${String(id)}`).toEqual({ error: 'not_found' });
    }
  });

  // -------------------------------------------------------------------------
  // The gated path is unchanged. This is the regression that would matter.
  // -------------------------------------------------------------------------

  it('still 404s a stage-less recording on /api/media/:id/stream', async () => {
    // loadGatedRecording inner-joins academy.stages, so a library video has
    // never been reachable there and must stay unreachable: the gated route is
    // the one that grades listening, and a video with no stage has no gate to
    // pay. If this ever starts answering 200, the library has been bolted on to
    // the gated path and the separation above is gone.
    const session = await trainee();
    for (const id of [fx.firstId, fx.secondId, fx.unorderedId, fx.audioId]) {
      const res = await gatedStream(session, id);
      expect(res.status, `id ${String(id)}`).toBe(404);
      expect(res.body, `id ${String(id)}`).toEqual({ error: 'not_found' });
    }
  });

  it('still refuses a LOCKED stage recording on /api/media/:id/stream', async () => {
    const session = await trainee();
    const res = await gatedStream(session, fx.lockedVideoId);
    expect(res.status).toBe(403);
    expect(res.body).toEqual({ error: 'locked', requires: fx.openCode });
  });

  it('writes no listen_progress row for a library video, so it pays no gate', async () => {
    // Nothing in the library earns credit. There is no beacon route under
    // /api/videos, and the beacon that does exist runs gate() on a stage this
    // row has not got — so watching the shelf cannot move any stage forward.
    const session = await trainee();
    await playBytes(session, fx.firstId);
    await playBytes(session, fx.firstId, 'bytes=0-99');

    const { rows } = await pool.query<{ n: string }>(
      'SELECT count(*) AS n FROM academy.listen_progress WHERE trainee_id = $1',
      [session.me.id],
    );
    expect(Number(rows[0]!.n)).toBe(0);

    // And the beacon route itself does not accept it: no stage, no gate, 404.
    const beacon = await request(h.app)
      .post(`/api/media/${String(fx.firstId)}/progress`)
      .set('Cookie', session.cookie)
      .send({ intervals: [[0, 10]] });
    expect(beacon.status).toBe(404);
    expect(Number(rows[0]!.n)).toBe(0);
  });

  // -------------------------------------------------------------------------
  // The bytes
  // -------------------------------------------------------------------------

  it('streams the whole file with the right headers and the right bytes', async () => {
    const session = await trainee();
    const res = await playBytes(session, fx.firstId);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toBe(VIDEO_TYPE);
    expect(res.headers['content-length']).toBe(String(PAYLOAD.length));
    expect(res.headers['accept-ranges']).toBe('bytes');
    expect(res.headers['cache-control']).toBe('private, no-store');
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['content-range']).toBeUndefined();
    expect(Buffer.compare(res.body as Buffer, PAYLOAD)).toBe(0);
  });

  it('answers a Range request with 206, the right Content-Range and exactly those bytes', async () => {
    // These are 20-27 MB files: the browser WILL ask for ranges, and a player
    // cannot seek without them.
    const session = await trainee();
    const res = await playBytes(session, fx.firstId, 'bytes=10-19');
    expect(res.status).toBe(206);
    expect(res.headers['content-range']).toBe(`bytes 10-19/${String(PAYLOAD.length)}`);
    expect(res.headers['content-length']).toBe('10');
    expect(res.headers['accept-ranges']).toBe('bytes');
    expect(Buffer.compare(res.body as Buffer, PAYLOAD.subarray(10, 20))).toBe(0);
  });

  it('handles an open-ended range, a suffix range and one that runs past the end', async () => {
    const session = await trainee();
    const last = PAYLOAD.length - 1;

    const open = await playBytes(session, fx.firstId, 'bytes=4000-');
    expect(open.status).toBe(206);
    expect(open.headers['content-range']).toBe(
      `bytes 4000-${String(last)}/${String(PAYLOAD.length)}`,
    );
    expect(Buffer.compare(open.body as Buffer, PAYLOAD.subarray(4000))).toBe(0);

    const suffix = await playBytes(session, fx.firstId, 'bytes=-16');
    expect(suffix.status).toBe(206);
    expect(suffix.headers['content-range']).toBe(
      `bytes ${String(PAYLOAD.length - 16)}-${String(last)}/${String(PAYLOAD.length)}`,
    );
    expect(Buffer.compare(suffix.body as Buffer, PAYLOAD.subarray(PAYLOAD.length - 16))).toBe(0);

    const clamped = await playBytes(session, fx.firstId, 'bytes=4090-99999');
    expect(clamped.status).toBe(206);
    expect(clamped.headers['content-range']).toBe(
      `bytes 4090-${String(last)}/${String(PAYLOAD.length)}`,
    );
    expect(Buffer.compare(clamped.body as Buffer, PAYLOAD.subarray(4090))).toBe(0);
  });

  it('answers 416 for a range that cannot be satisfied', async () => {
    const session = await trainee();
    for (const range of ['bytes=99999-', 'bytes=99999-100000', 'bytes=-0', 'bytes=20-10']) {
      const res = await play(session, fx.firstId).set('Range', range);
      expect(res.status, range).toBe(416);
      expect(res.headers['content-range'], range).toBe(`bytes */${String(PAYLOAD.length)}`);
    }
  });

  it('answers HEAD with the size and type and no body', async () => {
    const session = await trainee();
    const res = await request(h.app)
      .head(`/api/videos/${String(fx.firstId)}/stream`)
      .set('Cookie', session.cookie);
    expect(res.status).toBe(200);
    expect(res.headers['content-length']).toBe(String(PAYLOAD.length));
    expect(res.headers['content-type']).toBe(VIDEO_TYPE);
    expect(res.headers['accept-ranges']).toBe('bytes');
    expect(res.text === undefined || res.text === '').toBe(true);
  });

  it('answers 404 when the row names a file that is not on disk', async () => {
    const session = await trainee();
    const { rows } = await pool.query<{ id: string }>(
      `INSERT INTO academy.call_recordings
         (stage_id, code, category, title, description, media_key, duration_secs, media_type,
          position, content_type)
       VALUES (NULL, $1, 'INDUCTION', 'Missing library file', 'The row says yes, the disk says no.',
               $2, 10, 'VIDEO', 90, $3)
       RETURNING id`,
      [`vl-${fx.tag}-absent`, `academy/media/absent-${fx.tag}.mp4`, VIDEO_TYPE],
    );
    const id = Number(rows[0]!.id);
    try {
      const res = await play(session, id);
      expect(res.status).toBe(404);
      expect(res.body).toEqual({ error: 'not_found' });
    } finally {
      await pool.query('DELETE FROM academy.call_recordings WHERE id = $1', [id]);
    }
  });

  // -------------------------------------------------------------------------
  // Audit — the same one row per session per video the stream route writes
  // -------------------------------------------------------------------------

  it('audits the first play of a video in a session, and not every Range after it', async () => {
    const session = await trainee();
    await playBytes(session, fx.firstId);
    await playBytes(session, fx.firstId, 'bytes=0-99');
    await playBytes(session, fx.firstId, 'bytes=100-199');

    const { rows } = await pool.query<{ payload: Record<string, unknown> }>(
      `SELECT payload FROM academy.audit_events
        WHERE trainee_id = $1 AND event_type = 'MEDIA_STREAM' ORDER BY id`,
      [session.me.id],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.payload).toMatchObject({
      recordingId: fx.firstId,
      stage: null,
      library: true,
      mediaType: 'VIDEO',
      bytes: PAYLOAD.length,
    });
    // The audit row is a record of what was watched, not of where the file is.
    expect(JSON.stringify(rows[0]?.payload)).not.toContain(fx.mediaKey);
  });
});

// ---------------------------------------------------------------------------
// Fixture
// ---------------------------------------------------------------------------

async function createFixture(pool: pg.Pool): Promise<Fixture> {
  await dropFixture(pool);
  const tag = randomBytes(3).toString('hex');
  const openCode = `vl-${tag}-open`;
  const lockedCode = `vl-${tag}-locked`;
  const mediaKey = `academy/media/fixture-library-${tag}.mp4`;

  const level = await pool.query<{ id: number }>(
    `INSERT INTO academy.levels (level_number, name, accomplishment, default_pass_mark)
     VALUES (93, 'Video library test level', 'Nothing: this level is a test fixture.', 100)
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

  const openStageId = await stage(openCode, 'Library fixture (open)', 1);
  const lockedStageId = await stage(lockedCode, 'Library fixture (locked)', 2);

  /**
   * One call_recordings row. Every argument is a condition some test turns on,
   * so they are all spelled out rather than defaulted.
   */
  async function recording(opts: {
    suffix: string;
    stageId: number | null;
    title: string;
    description: string | null;
    mediaType: 'AUDIO' | 'VIDEO';
    mediaKey: string | null;
    durationSecs: number | null;
    position: number | null;
    isActive: boolean;
  }): Promise<number> {
    const res = await pool.query<{ id: string }>(
      `INSERT INTO academy.call_recordings
         (stage_id, code, category, title, description, media_key, duration_secs, media_type,
          position, content_type, is_active)
       VALUES ($1, $2, 'INDUCTION', $3, $4, $5, $6, $7, $8, $9, $10)
       RETURNING id`,
      [
        opts.stageId,
        `vl-${tag}-${opts.suffix}`,
        opts.title,
        opts.description,
        opts.mediaKey,
        opts.durationSecs,
        opts.mediaType,
        opts.position,
        opts.mediaKey === null ? null : opts.mediaType === 'VIDEO' ? VIDEO_TYPE : 'audio/mpeg',
        opts.isActive,
      ],
    );
    return Number(res.rows[0]!.id);
  }

  // On the shelf. `second` is inserted FIRST and given the later position, so
  // the ordering test cannot pass by accident on insertion order.
  const secondId = await recording({
    suffix: 'second',
    stageId: null,
    title: 'Library video, second on the shelf',
    description: 'An invented training video.',
    mediaType: 'VIDEO',
    mediaKey,
    durationSecs: 120,
    position: 2,
    isActive: true,
  });
  const firstId = await recording({
    suffix: 'first',
    stageId: null,
    title: 'Library video, first on the shelf',
    description: 'An invented training video.',
    mediaType: 'VIDEO',
    mediaKey,
    durationSecs: 90,
    position: 1,
    isActive: true,
  });
  const unorderedId = await recording({
    suffix: 'unordered',
    stageId: null,
    title: 'Library video nobody has ordered',
    description: null,
    mediaType: 'VIDEO',
    mediaKey,
    durationSecs: null,
    position: null,
    isActive: true,
  });

  // Stage-less, and each one off the shelf for its own reason.
  const audioId = await recording({
    suffix: 'audio',
    stageId: null,
    title: 'Unfiled call recording',
    description: 'Stage-less AUDIO: not a library video.',
    mediaType: 'AUDIO',
    mediaKey,
    durationSecs: 60,
    position: 3,
    isActive: true,
  });
  const slotId = await recording({
    suffix: 'slot',
    stageId: null,
    title: 'Library video, coming soon',
    description: 'No media yet: nothing to play.',
    mediaType: 'VIDEO',
    mediaKey: null,
    durationSecs: null,
    position: 4,
    isActive: true,
  });
  const inactiveId = await recording({
    suffix: 'inactive',
    stageId: null,
    title: 'Withdrawn library video',
    description: 'is_active = false: off the shelf.',
    mediaType: 'VIDEO',
    mediaKey,
    durationSecs: 100,
    position: 5,
    isActive: false,
  });

  // A VIDEO on the LOCKED stage, with the SAME file behind it: if the library
  // route ever served it the bytes would come back, so a 404 is a real refusal
  // and not a missing file.
  const lockedVideoId = await recording({
    suffix: 'onstage',
    stageId: lockedStageId,
    title: 'Stage video behind a lock',
    description: 'An invented recording that belongs to a stage.',
    mediaType: 'VIDEO',
    mediaKey,
    durationSecs: 110,
    position: 1,
    isActive: true,
  });

  return {
    levelId,
    openStageId,
    lockedStageId,
    openCode,
    lockedVideoId,
    firstId,
    secondId,
    unorderedId,
    audioId,
    slotId,
    inactiveId,
    mediaKey,
    tag,
  };
}

/**
 * Removes this suite's rows, whatever a run left behind. The library rows have
 * no stage, so they cannot be found through the stages: they are matched on the
 * `vl-` code prefix this fixture gives every row it makes.
 */
async function dropFixture(pool: pg.Pool): Promise<void> {
  const stageIds = `SELECT s.id FROM academy.stages s WHERE s.code LIKE 'vl-%'`;
  const recordingIds = `SELECT r.id FROM academy.call_recordings r
                         WHERE r.code LIKE 'vl-%' OR r.stage_id IN (${stageIds})`;
  await pool.query(`DELETE FROM academy.listen_progress WHERE recording_id IN (${recordingIds})`);
  await pool.query(`DELETE FROM academy.call_recordings WHERE id IN (${recordingIds})`);
  await pool.query(`DELETE FROM academy.lesson_progress WHERE lesson_id IN
      (SELECT l.id FROM academy.lessons l WHERE l.stage_id IN (${stageIds}))`);
  await pool.query(`DELETE FROM academy.lessons WHERE stage_id IN (${stageIds})`);
  await pool.query(`DELETE FROM academy.stage_completions WHERE stage_id IN (${stageIds})`);
  await pool.query(`DELETE FROM academy.track_visibility WHERE stage_id IN (${stageIds})`);
  await pool.query(`DELETE FROM academy.stages s WHERE s.code LIKE 'vl-%'`);
  await pool.query('DELETE FROM academy.levels WHERE level_number = 93');
}
