// SECTION 10 go-live gate item 3: "Load sanity: 50 concurrent trainees
// browsing/submitting — p95 API <500ms, no errors".
//
//   npx tsx ops/load/load-test.ts --expect-db academy_dev
//   npx tsx ops/load/load-test.ts --expect-db academy_dev --users 50 --duration 60 --think 0
//
// It drives the RUNNING local API over HTTP. Every virtual trainee signs in
// for real — the mock CRM account, then a TOTP code generated here from the
// enrolment secret the server hands back — and then loops through what a
// trainee actually does:
//
//   GET  /api/track                     the dashboard
//   GET  /api/stage/:code               open the available stage
//   POST /api/lesson/:id/read           mark a lesson read
//   GET  /api/stage/:code/quiz          fetch the quiz
//   POST /api/stage/:code/quiz          submit an attempt (graded server-side)
//   GET  /api/media/:id/stream          a 64 KB byte-range read of a recording
//   POST /api/auth/heartbeat            the session beacon
//
// Honest limits, stated here because they shape the numbers:
//   * the local mock CRM has a FIXED list of accounts (server/src/integrations/
//     crm/mockCrm.ts), so N virtual trainees share those identities. Row-level
//     contention (the same lesson_progress row, the same per-trainee advisory
//     lock on quiz submit) is therefore HIGHER than it would be with N real
//     people. The report says how many identities were used.
//   * each virtual trainee gets its own X-Forwarded-For address. The API trusts
//     the loopback proxy (app.ts sets trust proxy 'loopback'), so that is what
//     nginx does in production; without it the per-IP sign-in limit would stop
//     the run at five.
//   * `--think` is the pause between iterations. The default models trainees
//     doing something every second; `--think 0` turns the run into a saturation
//     test. Both are reported the same way; neither is tuned to pass.
//
// LOCAL / DEV ONLY. --base-url must resolve to this machine and --expect-db
// must be a local database that equals DB_NAME and current_database().
// Nothing here can be pointed at a real installation by accident.

import { setTimeout as sleep } from 'node:timers/promises';
import { authenticator } from 'otplib';
import { MOCK_CRM_ACCOUNTS } from '../../server/src/integrations/crm/mockCrm.js';
import { DevError, type Queryable, connectDev, runIfMain, table } from '../dev/lib.js';
import {
  type EndpointStats,
  type HttpClient,
  CookieJar,
  LOAD_TEST_USAGE,
  Recorder,
  type Sample,
  createHttpClient,
  ms,
  parseLoadArgs,
} from './lib.js';

/** Local mock CRM accounts all use this password (mockCrm.ts). Never a real one. */
const MOCK_PASSWORD = 'dev-password';

/**
 * Tracks whose fifth stage holds real recordings (CS: cscalls, SALES:
 * s6calls). Each virtual trainee is put on one of these and walked up to that
 * stage, so the media byte-range request has something to read and the stage
 * after it is a plain lessons-and-quiz stage.
 */
const LOAD_TRACKS = ['CS', 'SALES'] as const;

const TOTP = authenticator.clone({ step: 30, digits: 6 });

/** One 64 KB read, the size a browser asks for when it seeks in a recording. */
const RANGE_BYTES = 64 * 1024;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface MediaRef {
  recordingId: number;
  byteSize: number;
}

interface AccountPlan {
  email: string;
  track: string;
  traineeId: number;
  /** The `done` stage whose recordings the media step reads. */
  mediaStageCode: string;
  /** The `available` stage the lessons and the quiz belong to. */
  workStageCode: string;
  /** Recordings on the media stage. */
  media: MediaRef[];
  /** (trainee, stage) rows this run inserted, so it can take them out again. */
  inserted: { traineeId: number; stageId: number }[];
}

interface VirtualUser {
  index: number;
  email: string;
  jar: CookieJar;
  forwardedFor: string;
  traineeId: number;
  stageCode: string;
  lessonIds: number[];
  /** Every recording on the done media stage, tried in turn during warm-up. */
  mediaCandidates: MediaRef[];
  media: MediaRef | null;
  answers: { questionId: number; optionId: number }[];
}

// ---------------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------------

interface Step {
  name: string;
  method: string;
  path: string;
  body?: unknown;
  expect: number[];
  /** Media bodies are large; count the bytes but do not keep them. */
  keepBody?: boolean;
  extraHeaders?: Record<string, string>;
}

async function call(
  http: HttpClient,
  user: VirtualUser,
  step: Step,
  recorder: Recorder,
  startedAt: number,
): Promise<{ ok: boolean; status: number; body: string; bytes: number }> {
  const headers: Record<string, string> = {
    accept: 'application/json',
    'x-forwarded-for': user.forwardedFor,
    ...step.extraHeaders,
  };
  const cookie = user.jar.header();
  if (cookie !== '') headers['cookie'] = cookie;

  try {
    const res = await http.request({
      method: step.method,
      path: step.path,
      headers,
      ...(step.body === undefined ? {} : { body: JSON.stringify(step.body) }),
      keepBody: step.keepBody ?? true,
    });
    user.jar.accept(res.headers);
    const ok = step.expect.includes(res.status);
    recorder.add({
      endpoint: step.name,
      ms: res.ms,
      status: res.status,
      ok,
      at: Date.now() - startedAt,
    });
    return { ok, status: res.status, body: res.body, bytes: res.bytes };
  } catch (err) {
    recorder.add({
      endpoint: step.name,
      ms: 0,
      status: 0,
      ok: false,
      at: Date.now() - startedAt,
    });
    console.error(
      `  user ${String(user.index)}: ${step.method} ${step.path} failed: ` +
        (err instanceof Error ? err.message : String(err)),
    );
    return { ok: false, status: 0, body: '', bytes: 0 };
  }
}

function parseJson<T>(body: string): T | null {
  try {
    return JSON.parse(body) as T;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Database preparation
// ---------------------------------------------------------------------------

interface VisibleStage {
  stageId: number;
  code: string;
  withMedia: number;
  lessons: number;
  questions: number;
}

async function visibleStagesFor(db: Queryable, track: string): Promise<VisibleStage[]> {
  const { rows } = await db.query<{
    stage_id: string;
    code: string;
    with_media: string;
    lessons: string;
    questions: string;
  }>(
    `SELECT s.id::text AS stage_id, s.code,
            (SELECT count(*) FROM academy.call_recordings r
              WHERE r.stage_id = s.id AND r.media_key IS NOT NULL AND r.is_active)::text
              AS with_media,
            (SELECT count(*) FROM academy.lessons l WHERE l.stage_id = s.id)::text AS lessons,
            (SELECT count(*) FROM academy.quizzes z
               JOIN academy.questions q ON q.quiz_id = z.id
              WHERE z.stage_id = s.id AND q.is_active AND q.approval_state = 'APPROVED')::text
              AS questions
       FROM academy.track_visibility tv
       JOIN academy.stages s ON s.id = tv.stage_id
      WHERE tv.track_code = $1
      ORDER BY tv.position`,
    [track],
  );
  return rows.map((r) => ({
    stageId: Number(r.stage_id),
    code: r.code,
    withMedia: Number(r.with_media),
    lessons: Number(r.lessons),
    questions: Number(r.questions),
  }));
}

/**
 * One pg Client cannot run two queries at once, and the sign-in lanes run in
 * parallel. Everything that touches the database goes through this queue.
 */
function createDbQueue(): <T>(fn: () => Promise<T>) => Promise<T> {
  let tail: Promise<unknown> = Promise.resolve();
  return <T>(fn: () => Promise<T>): Promise<T> => {
    const next = tail.then(fn, fn);
    tail = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  };
}

async function resetMfa(
  db: Queryable,
  queue: <T>(fn: () => Promise<T>) => Promise<T>,
  email: string,
): Promise<void> {
  await queue(() =>
    db.query(
      `DELETE FROM academy.trainee_mfa
        WHERE trainee_id IN (SELECT id FROM academy.trainees WHERE lower(email) = lower($1))`,
      [email],
    ),
  );
}

/**
 * Puts the account on `track` and walks it forward to a sensible working
 * position: every stage before the "work stage" is marked passed, so that
 *
 *   * the work stage is `available` — it has lessons and questions and NO real
 *     recordings, so reading its lessons is enough for its quiz to open
 *     (loadQuizPrerequisite also demands that every real recording be heard);
 *   * an earlier stage that DOES have real recordings is `done`, and a passed
 *     stage stays open, so its recordings can be streamed all run long.
 *
 * Only rows this run inserts are recorded, so cleanup never removes progress
 * that was already there.
 */
async function prepareAccount(
  db: Queryable,
  email: string,
  track: string,
  traineeId: number,
): Promise<AccountPlan> {
  await db.query('UPDATE academy.trainees SET track = $2 WHERE id = $1', [traineeId, track]);

  const stages = await visibleStagesFor(db, track);
  const mediaIndex = stages.findIndex((s) => s.withMedia > 0);
  if (mediaIndex < 0) {
    throw new DevError(`Track ${track} has no stage with real recordings; cannot drive media.`);
  }
  const workIndex = stages.findIndex(
    (s, i) => i > mediaIndex && s.withMedia === 0 && s.lessons > 0 && s.questions > 0,
  );
  if (workIndex < 0) {
    throw new DevError(
      `Track ${track} has no lessons-and-quiz stage after its first stage with recordings ` +
        `(${stages[mediaIndex]?.code ?? '?'}); the loop has nothing to drive.`,
    );
  }
  const upTo = stages.slice(0, workIndex);
  const { rows: insertedRows } = await db.query<{ stage_id: string }>(
    `INSERT INTO academy.stage_completions (trainee_id, stage_id)
     SELECT $1, s FROM unnest($2::bigint[]) AS s
     ON CONFLICT (trainee_id, stage_id) DO NOTHING
     RETURNING stage_id::text AS stage_id`,
    [traineeId, upTo.map((s) => s.stageId)],
  );

  // Every recording on every completed stage is a candidate, not just the
  // first stage's: a slot whose file has gone (a fixture another suite
  // installed and then removed) must not leave the trainee with nothing to
  // stream. Warm-up proves which of them actually answers.
  const { rows: mediaRows } = await db.query<{ id: string; byte_size: string | null }>(
    `SELECT id::text AS id, byte_size::text AS byte_size
       FROM academy.call_recordings
      WHERE stage_id = ANY($1::bigint[]) AND media_key IS NOT NULL AND is_active
      ORDER BY stage_id, position NULLS LAST, id`,
    [upTo.map((s) => s.stageId)],
  );

  return {
    email,
    track,
    traineeId,
    mediaStageCode: upTo
      .filter((s) => s.withMedia > 0)
      .map((s) => s.code)
      .join('+'),
    workStageCode: stages[workIndex]!.code,
    media: mediaRows.map((r) => ({
      recordingId: Number(r.id),
      byteSize: Number(r.byte_size ?? '0'),
    })),
    inserted: insertedRows.map((r) => ({ traineeId, stageId: Number(r.stage_id) })),
  };
}

// ---------------------------------------------------------------------------
// Sign-in
// ---------------------------------------------------------------------------

interface LoginBody {
  next: 'enrol' | 'challenge';
  enrol?: { secret?: string };
}

interface MeBody {
  me?: { id?: number };
}

/**
 * The real two-step sign-in. The authenticator enrolment is cleared first, so
 * the login response carries the secret and the code can be generated here —
 * the same trick ops/dev/screenshots.ts uses, and the reason sign-ins for one
 * account must not overlap.
 */
async function signIn(
  http: HttpClient,
  db: Queryable,
  queue: <T>(fn: () => Promise<T>) => Promise<T>,
  user: VirtualUser,
  recorder: Recorder,
  startedAt: number,
): Promise<boolean> {
  await resetMfa(db, queue, user.email);

  const login = await call(
    http,
    user,
    {
      name: 'POST /api/auth/login',
      method: 'POST',
      path: '/api/auth/login',
      body: { email: user.email, password: MOCK_PASSWORD },
      expect: [200],
    },
    recorder,
    startedAt,
  );
  if (!login.ok) {
    console.error(`  user ${String(user.index)}: sign-in refused (${String(login.status)}).`);
    return false;
  }
  const body = parseJson<LoginBody>(login.body);
  const secret = body?.enrol?.secret;
  if (secret === undefined) {
    console.error(`  user ${String(user.index)}: no enrolment secret in the sign-in response.`);
    return false;
  }

  const mfa = await call(
    http,
    user,
    {
      name: 'POST /api/auth/mfa',
      method: 'POST',
      path: '/api/auth/mfa',
      body: { code: TOTP.generate(secret) },
      expect: [200],
    },
    recorder,
    startedAt,
  );
  if (!mfa.ok) {
    console.error(`  user ${String(user.index)}: the code was refused (${String(mfa.status)}).`);
    return false;
  }
  const id = parseJson<MeBody>(mfa.body)?.me?.id;
  if (id === undefined) return false;
  user.traineeId = id;
  return true;
}

// ---------------------------------------------------------------------------
// Warm-up and the loop
// ---------------------------------------------------------------------------

interface TrackBody {
  stages: { code: string; state: string }[];
}
interface StageBody {
  lessons: { id: number }[];
}
interface QuizBody {
  questions: { id: number; options: { id: number }[] }[];
}

/**
 * Discovers what this trainee can reach and reads every lesson of the open
 * stage, so the quiz opens. Not measured: it is setup, not load.
 */
async function warmUp(
  http: HttpClient,
  user: VirtualUser,
  scratch: Recorder,
  startedAt: number,
): Promise<boolean> {
  const track = await call(
    http,
    user,
    { name: 'warmup GET /api/track', method: 'GET', path: '/api/track', expect: [200] },
    scratch,
    startedAt,
  );
  const stages = parseJson<TrackBody>(track.body)?.stages ?? [];
  // The API is the authority: the stage the preparation aimed at must really
  // be open, or the run would be measuring something else. `done` counts —
  // a passed stage stays open for re-reading and retakes, and one of the
  // shared accounts may already have passed it.
  const shown = stages.find((s) => s.code === user.stageCode);
  if (shown === undefined || (shown.state !== 'available' && shown.state !== 'done')) {
    console.error(
      `  user ${String(user.index)}: stage "${user.stageCode}" is ` +
        `${shown?.state ?? 'not in the track list'}, not open.`,
    );
    return false;
  }

  const stage = await call(
    http,
    user,
    {
      name: 'warmup GET /api/stage',
      method: 'GET',
      path: `/api/stage/${encodeURIComponent(user.stageCode)}`,
      expect: [200],
    },
    scratch,
    startedAt,
  );
  user.lessonIds = parseJson<StageBody>(stage.body)?.lessons.map((l) => l.id) ?? [];
  for (const id of user.lessonIds) {
    await call(
      http,
      user,
      {
        name: 'warmup POST /api/lesson/:id/read',
        method: 'POST',
        path: `/api/lesson/${String(id)}/read`,
        expect: [204],
      },
      scratch,
      startedAt,
    );
  }

  const quiz = await call(
    http,
    user,
    {
      name: 'warmup GET /api/stage/:code/quiz',
      method: 'GET',
      path: `/api/stage/${encodeURIComponent(user.stageCode)}/quiz`,
      expect: [200],
    },
    scratch,
    startedAt,
  );
  if (!quiz.ok) {
    console.error(
      `  user ${String(user.index)}: the quiz for "${user.stageCode}" answered ` +
        `${String(quiz.status)} ${quiz.body.slice(0, 120)}`,
    );
    return false;
  }
  const questions = parseJson<QuizBody>(quiz.body)?.questions ?? [];
  // The first option of every question: a deterministic, almost-certain FAIL,
  // so no stage ever completes and the trainee's state stays put for the
  // whole run. A pass would move the goalposts mid-measurement.
  user.answers = questions.flatMap((q) =>
    q.options[0] === undefined ? [] : [{ questionId: q.id, optionId: q.options[0].id }],
  );

  // The media step is part of the gate, so the recording is proved to stream
  // here rather than discovered to be missing 400 measured requests later. A
  // slot whose file has gone (a fixture another suite installed and removed,
  // say) is skipped; if none of them answers, this trainee is not ready and
  // says so, instead of quietly contributing 404s to the error count.
  for (let i = 0; i < user.mediaCandidates.length; i += 1) {
    const candidate = user.mediaCandidates[(user.index + i) % user.mediaCandidates.length];
    if (candidate === undefined || candidate.byteSize <= 0) continue;
    const probe = await call(
      http,
      user,
      {
        name: 'warmup GET /api/media/:id/stream',
        method: 'GET',
        path: `/api/media/${String(candidate.recordingId)}/stream`,
        expect: [206],
        keepBody: false,
        extraHeaders: { range: 'bytes=0-1023' },
      },
      scratch,
      startedAt,
    );
    if (probe.ok) {
      user.media = candidate;
      break;
    }
  }
  if (user.media === null) {
    console.error(
      `  user ${String(user.index)}: none of the ${String(user.mediaCandidates.length)} ` +
        'recordings on the completed stage would stream.',
    );
    return false;
  }
  return user.lessonIds.length > 0 && user.answers.length > 0;
}

async function iterate(
  http: HttpClient,
  user: VirtualUser,
  recorder: Recorder,
  startedAt: number,
  iteration: number,
): Promise<void> {
  await call(
    http,
    user,
    { name: 'GET /api/track', method: 'GET', path: '/api/track', expect: [200] },
    recorder,
    startedAt,
  );
  await call(
    http,
    user,
    {
      name: 'GET /api/stage/:code',
      method: 'GET',
      path: `/api/stage/${encodeURIComponent(user.stageCode)}`,
      expect: [200],
    },
    recorder,
    startedAt,
  );

  const lessonId = user.lessonIds[iteration % user.lessonIds.length];
  if (lessonId !== undefined) {
    await call(
      http,
      user,
      {
        name: 'POST /api/lesson/:id/read',
        method: 'POST',
        path: `/api/lesson/${String(lessonId)}/read`,
        expect: [204],
      },
      recorder,
      startedAt,
    );
  }

  const quiz = await call(
    http,
    user,
    {
      name: 'GET /api/stage/:code/quiz',
      method: 'GET',
      path: `/api/stage/${encodeURIComponent(user.stageCode)}/quiz`,
      expect: [200],
    },
    recorder,
    startedAt,
  );
  const fresh = parseJson<QuizBody>(quiz.body)?.questions;
  const answers =
    fresh === undefined
      ? user.answers
      : fresh.flatMap((q) =>
          q.options[0] === undefined ? [] : [{ questionId: q.id, optionId: q.options[0].id }],
        );
  if (answers.length > 0) {
    await call(
      http,
      user,
      {
        name: 'POST /api/stage/:code/quiz',
        method: 'POST',
        path: `/api/stage/${encodeURIComponent(user.stageCode)}/quiz`,
        body: { answers },
        expect: [200],
      },
      recorder,
      startedAt,
    );
  }

  if (user.media !== null && user.media.byteSize > 0) {
    const span = Math.max(1, user.media.byteSize - RANGE_BYTES);
    const start = Math.floor(Math.random() * span);
    await call(
      http,
      user,
      {
        name: 'GET /api/media/:id/stream (range)',
        method: 'GET',
        path: `/api/media/${String(user.media.recordingId)}/stream`,
        expect: [206],
        keepBody: false,
        extraHeaders: { range: `bytes=${String(start)}-${String(start + RANGE_BYTES - 1)}` },
      },
      recorder,
      startedAt,
    );
  }

  await call(
    http,
    user,
    {
      name: 'POST /api/auth/heartbeat',
      method: 'POST',
      path: '/api/auth/heartbeat',
      expect: [204],
    },
    recorder,
    startedAt,
  );
}

// ---------------------------------------------------------------------------
// Reporting
// ---------------------------------------------------------------------------

function statsTable(rows: readonly EndpointStats[]): string {
  return table(
    ['endpoint', 'calls', 'errors', 'mean ms', 'p50', 'p95', 'p99', 'max'],
    rows.map((s) => [
      s.endpoint,
      s.count,
      s.errors,
      ms(s.mean),
      ms(s.p50),
      ms(s.p95),
      ms(s.p99),
      ms(s.max),
    ]),
  );
}

function overall(samples: readonly Sample[]): EndpointStats {
  const times = samples.map((s) => s.ms).sort((a, b) => a - b);
  return {
    endpoint: 'ALL',
    count: samples.length,
    errors: samples.filter((s) => !s.ok).length,
    mean: times.length === 0 ? 0 : times.reduce((n, v) => n + v, 0) / times.length,
    p50: percentileOf(times, 50),
    p95: percentileOf(times, 95),
    p99: percentileOf(times, 99),
    max: times.at(-1) ?? 0,
  };
}

function percentileOf(sorted: readonly number[], p: number): number {
  if (sorted.length === 0) return 0;
  const rank = Math.ceil((p / 100) * sorted.length);
  return sorted[Math.min(sorted.length - 1, Math.max(0, rank - 1))] ?? 0;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<number> {
  const parsed = parseLoadArgs(process.argv.slice(2));
  if (parsed === 'help') {
    console.log(LOAD_TEST_USAGE);
    return 0;
  }
  const args = parsed;

  const db = await connectDev(args.expectDb, 'academy-load-test');
  const dbQueue = createDbQueue();
  const http = createHttpClient(args.baseUrl, args.users + 8);
  const signInRec = new Recorder();
  const loadRec = new Recorder();
  const scratch = new Recorder();
  const startedAt = Date.now();
  const plans: AccountPlan[] = [];
  let attemptBaseline = 0;

  try {
    // ---- 0. the app has to be up, flagged on, and talking to this database ----
    const health = await http.request({ method: 'GET', path: '/api/health' });
    const healthBody = parseJson<{ ok?: boolean; flag?: boolean; redis?: boolean }>(health.body);
    if (health.status !== 200 || healthBody?.ok !== true) {
      throw new DevError(
        `The API at ${args.baseUrl} is not healthy (${String(health.status)}). Start it first: ` +
          'npm run dev:server.',
      );
    }
    if (healthBody.flag !== true) {
      throw new DevError('ACADEMY_V2 is off on the running API, so every route answers 503.');
    }

    const usable = MOCK_CRM_ACCOUNTS.filter((a) => a.isApproved && !a.locked);
    if (usable.length === 0) throw new DevError('The mock CRM has no usable account.');

    console.log(`API:       ${args.baseUrl}  (redis: ${String(healthBody.redis === true)})`);
    console.log(
      `Plan:      ${String(args.users)} virtual trainees over ${String(usable.length)} mock CRM ` +
        `identities, ramp ${String(args.rampSec)}s, measure ${String(args.durationSec)}s, ` +
        `think ${String(args.thinkMs)}ms between iterations`,
    );
    console.log(`Budget:    p95 < ${String(args.p95BudgetMs)} ms and zero errors\n`);

    const users: VirtualUser[] = Array.from({ length: args.users }, (_, i) => ({
      index: i + 1,
      email: usable[i % usable.length]!.email,
      jar: new CookieJar(),
      // One address per virtual trainee. app.ts trusts loopback proxies, so
      // this is what nginx would pass; it keeps the per-IP sign-in limit from
      // rejecting everyone after the fifth.
      forwardedFor: `10.99.${String(Math.floor(i / 250) + 1)}.${String((i % 250) + 1)}`,
      traineeId: 0,
      stageCode: '',
      lessonIds: [],
      mediaCandidates: [],
      media: null,
      answers: [],
    }));

    // ---- 1. sign in, one lane per identity (a TOTP enrolment cannot overlap) --
    console.log('Signing in...');
    const lanes = new Map<string, VirtualUser[]>();
    for (const u of users) {
      const lane = lanes.get(u.email);
      if (lane) lane.push(u);
      else lanes.set(u.email, [u]);
    }
    const signedIn: VirtualUser[] = [];
    await Promise.all(
      [...lanes.values()].map(async (lane) => {
        for (const user of lane) {
          if (await signIn(http, db, dbQueue, user, signInRec, startedAt)) signedIn.push(user);
        }
      }),
    );
    if (signedIn.length === 0) throw new DevError('No virtual trainee could sign in.');
    console.log(`  ${String(signedIn.length)}/${String(users.length)} signed in.`);

    // ---- 2. put each identity on a track and walk it up to a media stage -----
    const baseline = await db.query<{ id: string }>(
      'SELECT COALESCE(MAX(id), 0)::text AS id FROM academy.quiz_attempts',
    );
    attemptBaseline = Number(baseline.rows[0]?.id ?? '0');

    const emails = [...new Set(signedIn.map((u) => u.email))];
    for (const [i, email] of emails.entries()) {
      const user = signedIn.find((u) => u.email === email)!;
      plans.push(
        await prepareAccount(db, email, LOAD_TRACKS[i % LOAD_TRACKS.length]!, user.traineeId),
      );
    }
    const planByEmail = new Map(plans.map((p) => [p.email, p]));
    for (const user of signedIn) {
      const plan = planByEmail.get(user.email);
      if (plan === undefined) continue;
      user.stageCode = plan.workStageCode;
      user.mediaCandidates = plan.media;
    }
    console.log(
      '  prepared: ' +
        plans
          .map(
            (p) =>
              `${p.email} -> ${p.track}: work stage ${p.workStageCode}, media stage ` +
              `${p.mediaStageCode} (${String(p.media.length)} recording(s))`,
          )
          .join('; '),
    );

    // ---- 3. warm up: read the lessons so the quiz opens ----------------------
    console.log('Warming up (reading lessons so the quiz opens)...');
    const ready: VirtualUser[] = [];
    for (const user of signedIn) {
      if (await warmUp(http, user, scratch, startedAt)) ready.push(user);
    }
    if (ready.length === 0) throw new DevError('No virtual trainee reached a quiz.');
    console.log(`  ${String(ready.length)}/${String(signedIn.length)} ready.\n`);

    // ---- 4. the load itself --------------------------------------------------
    const loadStart = Date.now();
    const rampMs = args.rampSec * 1000;
    const endAt = loadStart + rampMs + args.durationSec * 1000;
    console.log(
      `Load: ramping ${String(ready.length)} trainees over ${String(args.rampSec)}s, then ` +
        `${String(args.durationSec)}s of measurement...`,
    );
    await Promise.all(
      ready.map(async (user, i) => {
        // Ramp: start evenly across the ramp window rather than all at once.
        await sleep((i / ready.length) * rampMs);
        let iteration = 0;
        while (Date.now() < endAt) {
          await iterate(http, user, loadRec, loadStart, iteration);
          iteration += 1;
          if (args.thinkMs > 0) await sleep(args.thinkMs);
        }
      }),
    );

    // ---- 5. tidy the sessions up ---------------------------------------------
    for (const user of ready) {
      await call(
        http,
        user,
        { name: 'logout', method: 'POST', path: '/api/auth/logout', expect: [204] },
        scratch,
        startedAt,
      );
    }

    // ---- 6. the report -------------------------------------------------------
    const signInSamples = signInRec.all();
    console.log(
      `\nSign-in phase (${String(signedIn.length)} sessions, one lane per mock identity)\n` +
        statsTable(Recorder.byEndpoint(signInSamples)),
    );

    const rampSamples = loadRec.all().filter((s) => s.at < rampMs);
    const steady = loadRec.since(rampMs);
    const perEndpoint = Recorder.byEndpoint(steady);
    const all = overall(steady);
    console.log(
      `\nLoad phase — steady state only (${String(rampSamples.length)} ramp-up calls excluded)\n` +
        statsTable([...perEndpoint, all]),
    );

    const slow = Recorder.slowest(steady, 10);
    console.log(
      '\nSlowest 10 calls in the steady state\n' +
        table(
          ['#', 'endpoint', 'ms', 'status', 'at (s into the run)'],
          slow.map((s, i) => [
            i + 1,
            s.endpoint,
            ms(s.ms),
            s.status === 0 ? 'no response' : s.status,
            ((s.at - rampMs) / 1000).toFixed(1),
          ]),
        ),
    );

    const seconds = args.durationSec === 0 ? 1 : args.durationSec;
    const failures = steady.filter((s) => !s.ok);
    const p95Ok = all.p95 < args.p95BudgetMs;
    const errorsOk = all.errors === 0;
    console.log(
      '\nGo-live gate item 3 — load sanity\n' +
        table(
          ['#', 'item', 'result', 'evidence'],
          [
            [
              '1',
              `${String(ready.length)} concurrent trainees browsing and submitting`,
              ready.length >= args.users ? 'PASS' : 'PARTIAL',
              `${String(ready.length)}/${String(args.users)} virtual trainees over ` +
                `${String(plans.length)} mock CRM identities; ${String(all.count)} calls, ` +
                `${(all.count / seconds).toFixed(1)}/s`,
            ],
            [
              '2',
              `p95 API response under ${String(args.p95BudgetMs)} ms`,
              p95Ok ? 'PASS' : 'FAIL',
              `p95 ${ms(all.p95)} ms (p50 ${ms(all.p50)}, p99 ${ms(all.p99)}, max ${ms(all.max)})`,
            ],
            [
              '3',
              'No errors',
              errorsOk ? 'PASS' : 'FAIL',
              errorsOk
                ? `0 of ${String(all.count)} calls failed`
                : `${String(all.errors)} of ${String(all.count)} calls failed: ` +
                  [...new Set(failures.map((f) => `${f.endpoint} -> ${String(f.status)}`))]
                    .slice(0, 6)
                    .join(', '),
            ],
          ],
        ),
    );

    if (!p95Ok) {
      console.log(
        '\nSlowest endpoints by p95: ' +
          perEndpoint
            .slice(0, 3)
            .map((s) => `${s.endpoint} ${ms(s.p95)} ms`)
            .join(', '),
      );
    }
    console.log(
      p95Ok && errorsOk
        ? '\nload-test: PASS'
        : `\nload-test: FAIL (${!p95Ok ? `p95 ${ms(all.p95)} ms >= ${String(args.p95BudgetMs)} ms` : ''}` +
            `${!p95Ok && !errorsOk ? '; ' : ''}${!errorsOk ? `${String(all.errors)} error(s)` : ''})`,
    );
    return p95Ok && errorsOk ? 0 : 1;
  } finally {
    http.destroy();
    if (!args.keepData && plans.length > 0) {
      await cleanUp(db, plans, attemptBaseline).catch((err: unknown) => {
        console.warn(
          `load-test: could not clean up: ${err instanceof Error ? err.message : String(err)}`,
        );
      });
    }
    await db.end().catch(() => undefined);
  }
}

/**
 * Removes what the run created: the quiz attempts (and their answers) it
 * submitted, and the stage completions it inserted. Lesson reads are left
 * alone — they are the ordinary result of a trainee reading a lesson, and
 * ops/dev/seed-test-accounts.ts --reset clears them when that is wanted.
 */
async function cleanUp(
  db: Queryable,
  plans: readonly AccountPlan[],
  attemptBaseline: number,
): Promise<void> {
  const ids = plans.map((p) => p.traineeId);
  const answers = await db.query(
    `DELETE FROM academy.attempt_answers
      WHERE attempt_id IN (SELECT id FROM academy.quiz_attempts
                            WHERE id > $1 AND trainee_id = ANY($2::bigint[]))`,
    [attemptBaseline, ids],
  );
  const attempts = await db.query(
    'DELETE FROM academy.quiz_attempts WHERE id > $1 AND trainee_id = ANY($2::bigint[])',
    [attemptBaseline, ids],
  );
  const pairs = plans.flatMap((p) => p.inserted);
  const completions = await db.query(
    `DELETE FROM academy.stage_completions c
      USING unnest($1::bigint[], $2::bigint[]) AS t(tid, sid)
      WHERE c.trainee_id = t.tid AND c.stage_id = t.sid`,
    [pairs.map((p) => p.traineeId), pairs.map((p) => p.stageId)],
  );
  console.log(
    `\nCleaned up: ${String(attempts.rowCount ?? 0)} quiz attempt(s), ` +
      `${String(answers.rowCount ?? 0)} answer row(s), ` +
      `${String(completions.rowCount ?? 0)} stage completion(s) this run created. ` +
      'Lesson reads and audit rows are left in place.',
  );
}

runIfMain(import.meta.url, 'load-test', main);
