// S06 streaming: GET /api/media/:recordingId/stream, against the real local
// test database (MIGRATION_TEST_DB_NAME), through the real app, the real
// sign-in and the real gate().
//
// Decision D15: there is no S3. The file the tests stream is INVENTED — a few
// kilobytes of a counting pattern this file writes into a throw-away MEDIA_ROOT
// under the system temp folder. No real recording, no prototype media, and
// nothing is left on disk afterwards. The stages, lessons and quizzes are
// fixtures too, created in beforeAll and removed in afterAll.
import { randomBytes } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type pg from 'pg';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createLocalMediaStore } from '../../src/media/store.js';
import { TEST_DB, openTestDb, signIn } from './helpers/authHarness.js';
import type { Db, Harness, SignedIn } from './helpers/authHarness.js';

/** A real track code: only the nine exist (shared/constants). */
const TRACK = 'PAY';
/** Fixture stages sit after every seeded stage of that track. */
const FIRST_POSITION = 910;
/** Invented bytes: a counting pattern, so every assertion can name them. */
const PAYLOAD = Buffer.from(Uint8Array.from({ length: 4096 }, (_, i) => i % 251));
const CONTENT_TYPE = 'audio/mpeg';

const db: Db | null = TEST_DB ? await openTestDb() : null;
if (db === null) {
  console.warn('[media-stream] MIGRATION_TEST_DB_NAME is not set: skipping the streaming tests.');
}

interface Fixture {
  levelId: number;
  /** The open stage, and the one locked behind it. */
  openStageId: number;
  lockedStageId: number;
  openCode: string;
  lockedCode: string;
  /** On the open stage: a real file, and a "coming soon" slot (D4). */
  playableId: number;
  comingSoonId: number;
  /** On the locked stage: a real file nobody may reach yet. */
  lockedRecordingId: number;
  mediaKey: string;
  tag: string;
}

/** Collects the raw body: supertest has no parser for audio/mpeg. */
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

describe.skipIf(db === null)('S06 media streaming', () => {
  let pool: pg.Pool;
  let h: Harness;
  let fx: Fixture;
  let mediaRoot: string;

  beforeAll(async () => {
    pool = db!.pool;
    mediaRoot = await mkdtemp(join(tmpdir(), 'academy-stream-'));
    const store = createLocalMediaStore(mediaRoot);
    h = db!.harness({ mediaStore: store });
    fx = await createFixture(pool);
    await store.put(fx.mediaKey, PAYLOAD, { contentType: CONTENT_TYPE });
  });

  afterAll(async () => {
    if (db === null) return;
    await restoreKeyConstraint(db.pool);
    await dropFixture(db.pool, fx);
    await db.cleanup();
    await rm(mediaRoot, { recursive: true, force: true });
  });

  // -------------------------------------------------------------------------
  // Helpers
  // -------------------------------------------------------------------------

  /**
   * A signed-in trainee on the fixture track with every seeded stage of that
   * track already passed, so their journey starts at the fixture open stage
   * whether or not the real content has been seeded into this database.
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

  function stream(session: SignedIn | null, recordingId: number) {
    const req = request(h.app).get(`/api/media/${String(recordingId)}/stream`);
    if (session !== null) req.set('Cookie', session.cookie);
    return req;
  }

  function streamBytes(session: SignedIn, recordingId: number, range?: string) {
    const req = stream(session, recordingId);
    if (range !== undefined) req.set('Range', range);
    return req.buffer(true).parse(binaryParser as never);
  }

  async function auditCount(traineeId: number): Promise<number> {
    const { rows } = await pool.query<{ n: string }>(
      `SELECT count(*) AS n FROM academy.audit_events
        WHERE trainee_id = $1 AND event_type = 'MEDIA_STREAM'`,
      [traineeId],
    );
    return Number(rows[0]?.n ?? 0);
  }

  // -------------------------------------------------------------------------
  // Who may not have it
  // -------------------------------------------------------------------------

  it('refuses a request with no session', async () => {
    const res = await stream(null, fx.playableId);
    expect(res.status).toBe(401);
    expect(res.body).toEqual({ error: 'not_signed_in' });
  });

  it('refuses a session cookie that was never issued', async () => {
    const res = await request(h.app)
      .get(`/api/media/${String(fx.playableId)}/stream`)
      .set('Cookie', `academy_sid=${randomBytes(32).toString('base64url')}`);
    expect(res.status).toBe(401);
  });

  it('refuses a recording whose stage is still locked, and says what unlocks it', async () => {
    const session = await trainee();
    const res = await stream(session, fx.lockedRecordingId);
    expect(res.status).toBe(403);
    expect(res.body).toEqual({ error: 'locked', requires: fx.openCode });
    // Nothing about the file leaked on the way out.
    expect(res.headers['content-range']).toBeUndefined();
    expect(res.headers['content-type']).not.toContain('audio');
  });

  it('serves it once the stage before it has been passed', async () => {
    const session = await trainee();
    await pool.query(
      `INSERT INTO academy.stage_completions (trainee_id, stage_id, completed_at, best_score)
       VALUES ($1, $2, now(), 100) ON CONFLICT DO NOTHING`,
      [session.me.id, fx.openStageId],
    );
    const res = await streamBytes(session, fx.lockedRecordingId);
    expect(res.status).toBe(200);
  });

  it('answers 404 for a "coming soon" slot, and for an id that does not exist', async () => {
    const session = await trainee();
    const soon = await stream(session, fx.comingSoonId);
    expect(soon.status).toBe(404);
    expect(soon.body).toEqual({ error: 'not_found' });

    for (const id of [999_999_999, 0, -1]) {
      const res = await stream(session, id);
      expect(res.status, `id ${String(id)}`).toBe(404);
    }
  });

  // -------------------------------------------------------------------------
  // The bytes
  // -------------------------------------------------------------------------

  it('streams the whole file with the right headers and the right bytes', async () => {
    const session = await trainee();
    const res = await streamBytes(session, fx.playableId);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toBe(CONTENT_TYPE);
    expect(res.headers['content-length']).toBe(String(PAYLOAD.length));
    expect(res.headers['accept-ranges']).toBe('bytes');
    expect(res.headers['cache-control']).toBe('private, no-store');
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['content-range']).toBeUndefined();
    expect(Buffer.compare(res.body as Buffer, PAYLOAD)).toBe(0);
  });

  it('answers a Range request with 206 and exactly the bytes asked for', async () => {
    const session = await trainee();
    const res = await streamBytes(session, fx.playableId, 'bytes=10-19');
    expect(res.status).toBe(206);
    expect(res.headers['content-range']).toBe(`bytes 10-19/${String(PAYLOAD.length)}`);
    expect(res.headers['content-length']).toBe('10');
    expect(res.headers['accept-ranges']).toBe('bytes');
    expect(Buffer.compare(res.body as Buffer, PAYLOAD.subarray(10, 20))).toBe(0);
  });

  it('handles an open-ended range and a suffix range', async () => {
    const session = await trainee();
    const last = PAYLOAD.length - 1;

    const open = await streamBytes(session, fx.playableId, 'bytes=4000-');
    expect(open.status).toBe(206);
    expect(open.headers['content-range']).toBe(
      `bytes 4000-${String(last)}/${String(PAYLOAD.length)}`,
    );
    expect(Buffer.compare(open.body as Buffer, PAYLOAD.subarray(4000))).toBe(0);

    const suffix = await streamBytes(session, fx.playableId, 'bytes=-16');
    expect(suffix.status).toBe(206);
    expect(suffix.headers['content-range']).toBe(
      `bytes ${String(PAYLOAD.length - 16)}-${String(last)}/${String(PAYLOAD.length)}`,
    );
    expect(Buffer.compare(suffix.body as Buffer, PAYLOAD.subarray(PAYLOAD.length - 16))).toBe(0);
  });

  it('clamps a range that runs past the end rather than inventing bytes', async () => {
    const session = await trainee();
    const res = await streamBytes(session, fx.playableId, 'bytes=4090-99999');
    expect(res.status).toBe(206);
    expect(res.headers['content-range']).toBe(
      `bytes 4090-${String(PAYLOAD.length - 1)}/${String(PAYLOAD.length)}`,
    );
    expect(Buffer.compare(res.body as Buffer, PAYLOAD.subarray(4090))).toBe(0);
  });

  it('answers 416 for a range that cannot be satisfied', async () => {
    const session = await trainee();
    for (const range of ['bytes=99999-', 'bytes=99999-100000', 'bytes=-0', 'bytes=20-10']) {
      const res = await stream(session, fx.playableId).set('Range', range);
      expect(res.status, range).toBe(416);
      expect(res.headers['content-range'], range).toBe(`bytes */${String(PAYLOAD.length)}`);
    }
  });

  it('ignores a Range header it cannot make sense of and sends the whole file', async () => {
    const session = await trainee();
    for (const range of ['seconds=0-10', 'bytes=abc', 'bytes=0-1, 5-6', 'nonsense']) {
      const res = await streamBytes(session, fx.playableId, range);
      expect(res.status, range).toBe(200);
      expect(Buffer.compare(res.body as Buffer, PAYLOAD), range).toBe(0);
    }
  });

  it('answers HEAD with the size and type and no body', async () => {
    const session = await trainee();
    const res = await request(h.app)
      .head(`/api/media/${String(fx.playableId)}/stream`)
      .set('Cookie', session.cookie);
    expect(res.status).toBe(200);
    expect(res.headers['content-length']).toBe(String(PAYLOAD.length));
    expect(res.headers['content-type']).toBe(CONTENT_TYPE);
    expect(res.headers['accept-ranges']).toBe('bytes');
    expect(res.text === undefined || res.text === '').toBe(true);
  });

  // -------------------------------------------------------------------------
  // Path safety
  // -------------------------------------------------------------------------

  it('refuses a crafted media_key before it opens any file', async () => {
    // A file planted NEXT TO the media root: if the traversal worked, this is
    // what would come back. Migration 0005 will not let such a key into the
    // table, so the constraint is lifted for the length of this one test — the
    // point is that the endpoint refuses the key even when the database did not.
    const outsideName = `academy-secret-${fx.tag}.txt`;
    const outside = join(dirname(mediaRoot), outsideName);
    await writeFile(outside, 'not for the academy');

    const session = await trainee();
    let craftedId: number | null = null;
    try {
      await pool.query(
        'ALTER TABLE academy.call_recordings DROP CONSTRAINT call_recordings_media_key_format',
      );
      const { rows } = await pool.query<{ id: string }>(
        `INSERT INTO academy.call_recordings
           (stage_id, category, title, description, media_key, duration_secs, media_type, position)
         VALUES ($1, 'COACHING', 'Crafted key', 'A fixture with a hostile key.',
                 $2, 10, 'AUDIO', 9)
         RETURNING id`,
        [fx.openStageId, `../${outsideName}`],
      );
      craftedId = Number(rows[0]!.id);

      const res = await stream(session, craftedId);
      expect(res.status).toBe(404);
      expect(res.body).toEqual({ error: 'not_found' });
      expect(res.text ?? '').not.toContain('not for the academy');
      // Untouched, and still where it was: nothing opened it.
      expect(await readFile(outside, 'utf8')).toBe('not for the academy');
    } finally {
      if (craftedId !== null) {
        await pool.query('DELETE FROM academy.call_recordings WHERE id = $1', [craftedId]);
      }
      await restoreKeyConstraint(pool);
      await rm(outside, { force: true });
    }
  });

  it('answers 404 when the row names a file that is not on disk', async () => {
    const session = await trainee();
    const { rows } = await pool.query<{ id: string }>(
      `INSERT INTO academy.call_recordings
         (stage_id, category, title, description, media_key, duration_secs, media_type, position)
       VALUES ($1, 'COACHING', 'Missing file', 'The row says yes, the disk says no.',
               $2, 10, 'AUDIO', 8)
       RETURNING id`,
      [fx.openStageId, `academy/media/absent-${fx.tag}.mp3`],
    );
    const id = Number(rows[0]!.id);
    try {
      const res = await stream(session, id);
      expect(res.status).toBe(404);
      expect(res.body).toEqual({ error: 'not_found' });
    } finally {
      await pool.query('DELETE FROM academy.call_recordings WHERE id = $1', [id]);
    }
  });

  // -------------------------------------------------------------------------
  // Audit
  // -------------------------------------------------------------------------

  it('audits the first stream of a recording in a session, and not every Range after it', async () => {
    const session = await trainee();
    expect(await auditCount(session.me.id)).toBe(0);

    await streamBytes(session, fx.playableId);
    await streamBytes(session, fx.playableId, 'bytes=0-99');
    await streamBytes(session, fx.playableId, 'bytes=100-199');
    expect(await auditCount(session.me.id)).toBe(1);

    const { rows } = await pool.query<{ payload: Record<string, unknown> }>(
      `SELECT payload FROM academy.audit_events
        WHERE trainee_id = $1 AND event_type = 'MEDIA_STREAM'`,
      [session.me.id],
    );
    expect(rows[0]?.payload).toMatchObject({
      recordingId: fx.playableId,
      stage: fx.openCode,
      mediaType: 'AUDIO',
      bytes: PAYLOAD.length,
    });

    // A different person, a different session: their own row.
    const other = await trainee();
    await streamBytes(other, fx.playableId);
    expect(await auditCount(other.me.id)).toBe(1);
    expect(await auditCount(session.me.id)).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Fixture
// ---------------------------------------------------------------------------

/** Puts back the 0005 CHECK, whatever a test did to it. */
async function restoreKeyConstraint(pool: pg.Pool): Promise<void> {
  await pool.query(`
    ALTER TABLE academy.call_recordings DROP CONSTRAINT IF EXISTS call_recordings_media_key_format;
    ALTER TABLE academy.call_recordings
      ADD CONSTRAINT call_recordings_media_key_format CHECK (
          media_key IS NULL
          OR (    media_key ~ '^[A-Za-z0-9][A-Za-z0-9/_.-]*$'
              AND media_key NOT LIKE '%..%'
              AND media_key NOT LIKE '%/'
              AND length(media_key) <= 512)
      )`);
}

async function createFixture(pool: pg.Pool): Promise<Fixture> {
  await clearLeftovers(pool);
  const tag = randomBytes(3).toString('hex');
  const openCode = `sm-${tag}-open`;
  const lockedCode = `sm-${tag}-locked`;

  const level = await pool.query<{ id: number }>(
    `INSERT INTO academy.levels (level_number, name, accomplishment, default_pass_mark)
     VALUES (91, 'Streaming test level', 'Nothing: this level is a test fixture.', 100)
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

  const openStageId = await stage(openCode, 'Streaming fixture (open)', 1);
  const lockedStageId = await stage(lockedCode, 'Streaming fixture (locked)', 2);

  const mediaKey = `academy/media/fixture-stream-${tag}.mp3`;
  const playable = await pool.query<{ id: string }>(
    `INSERT INTO academy.call_recordings
       (stage_id, category, title, description, media_key, duration_secs, media_type,
        position, content_type, byte_size)
     VALUES ($1, 'COACHING', 'Fixture call', 'An invented recording.',
             $2, 10, 'AUDIO', 1, $3, $4)
     RETURNING id`,
    [openStageId, mediaKey, CONTENT_TYPE, PAYLOAD.length],
  );
  const soon = await pool.query<{ id: string }>(
    `INSERT INTO academy.call_recordings
       (stage_id, category, title, description, media_key, duration_secs, media_type, position)
     VALUES ($1, 'COACHING', 'Fixture slot', 'Not recorded yet.', NULL, NULL, 'AUDIO', 2)
     RETURNING id`,
    [openStageId],
  );
  const behindLock = await pool.query<{ id: string }>(
    `INSERT INTO academy.call_recordings
       (stage_id, category, title, description, media_key, duration_secs, media_type,
        position, content_type)
     VALUES ($1, 'COACHING', 'Fixture call behind a lock', 'An invented recording.',
             $2, 10, 'AUDIO', 1, $3)
     RETURNING id`,
    [lockedStageId, mediaKey, CONTENT_TYPE],
  );

  return {
    levelId,
    openStageId,
    lockedStageId,
    openCode,
    lockedCode,
    playableId: Number(playable.rows[0]!.id),
    comingSoonId: Number(soon.rows[0]!.id),
    lockedRecordingId: Number(behindLock.rows[0]!.id),
    mediaKey,
    tag,
  };
}

async function clearLeftovers(pool: pg.Pool): Promise<void> {
  await dropStagesWhere(pool, `s.code LIKE 'sm-%'`);
  await pool.query('DELETE FROM academy.levels WHERE level_number = 91');
}

async function dropFixture(pool: pg.Pool, fx: Fixture | undefined): Promise<void> {
  if (fx === undefined) return;
  await dropStagesWhere(pool, `s.code LIKE 'sm-%'`);
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
