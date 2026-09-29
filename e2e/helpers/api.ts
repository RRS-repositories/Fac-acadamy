import type { APIRequestContext, Page } from '@playwright/test';
import { correctAnswersForStage, creditFullListen, lessonIdsForStage } from './db.js';
import type { Answer } from './db.js';

// Thin wrappers over the API, used from a signed-in page's own request context
// (`page.request`), so every call carries the session cookie the browser holds.
//
// Two uses:
//   * assertions a screen cannot make — the exact status and body the server
//     answers a locked stage with, what the quiz JSON does and does not carry;
//   * fast-forward — walking an account through stages the spec is not there
//     to watch. Those calls are the REAL endpoints with the REAL grading; the
//     only thing skipped is the clicking, and — since the core stages gained
//     real call recordings — the sitting through them (see
//     `fastForwardListening` below, and `creditFullListen` in db.ts).

export interface ApiResult<T = unknown> {
  status: number;
  body: T;
  text: string;
  headers: Record<string, string>;
}

async function result<T>(
  response: Awaited<ReturnType<APIRequestContext['get']>>,
): Promise<ApiResult<T>> {
  const text = await response.text();
  let body: unknown = null;
  try {
    body = JSON.parse(text) as unknown;
  } catch {
    body = null;
  }
  return { status: response.status(), body: body as T, text, headers: response.headers() };
}

export function api(page: Page): APIRequestContext {
  return page.request;
}

export async function getJson<T>(page: Page, path: string): Promise<ApiResult<T>> {
  return result<T>(await page.request.get(path, { failOnStatusCode: false }));
}

export async function postJson<T>(page: Page, path: string, data?: unknown): Promise<ApiResult<T>> {
  return result<T>(
    await page.request.post(path, {
      failOnStatusCode: false,
      ...(data === undefined ? {} : { data }),
    }),
  );
}

export async function putJson<T>(page: Page, path: string, data: unknown): Promise<ApiResult<T>> {
  return result<T>(await page.request.put(path, { failOnStatusCode: false, data }));
}

// ---------------------------------------------------------------------------
// Training
// ---------------------------------------------------------------------------

export interface TrackStage {
  code: string;
  state: 'locked' | 'available' | 'done';
  position: number;
  displayNum: string;
  title: string;
}

export interface TrackBody {
  track: string | null;
  waitingForTrack: boolean;
  stages: TrackStage[];
}

export async function getTrack(page: Page): Promise<TrackBody> {
  const res = await getJson<TrackBody>(page, '/api/track');
  if (res.status !== 200) throw new Error(`e2e: GET /api/track answered ${String(res.status)}`);
  return res.body;
}

export async function stageCodes(page: Page): Promise<string[]> {
  return (await getTrack(page)).stages.map((s) => s.code);
}

export interface StageBody {
  stage: TrackStage;
  lessons: { id: number; title: string; bodyHtml: string; read: boolean }[];
  recordings: {
    id: number;
    title: string;
    durationSecs: number | null;
    comingSoon: boolean;
    listened: boolean;
  }[];
  quiz: {
    questionCount: number;
    passMark: number;
    attempts: number;
    best: number | null;
    passed: boolean;
    unlocked: boolean;
    blockedBy: 'lessons' | 'recordings' | null;
  };
}

export async function getStage(page: Page, code: string): Promise<ApiResult<StageBody>> {
  return getJson<StageBody>(page, `/api/stage/${encodeURIComponent(code)}`);
}

export interface QuizBody {
  stageCode: string;
  passMark: number;
  questions: { id: number; prompt: string; options: { id: number; text: string }[] }[];
}

export async function getQuiz(page: Page, code: string): Promise<ApiResult<QuizBody>> {
  return getJson<QuizBody>(page, `/api/stage/${encodeURIComponent(code)}/quiz`);
}

export interface QuizResultBody {
  attemptId: number;
  pct: number;
  passed: boolean;
  correctCount: number;
  total: number;
  perQuestion: { questionId: number; correct: boolean; correctOptionId: number | null }[];
}

export async function submitQuiz(
  page: Page,
  code: string,
  answers: Answer[],
): Promise<ApiResult<QuizResultBody>> {
  return postJson<QuizResultBody>(page, `/api/stage/${encodeURIComponent(code)}/quiz`, {
    answers,
  });
}

export async function readLesson(page: Page, lessonId: number): Promise<number> {
  const res = await postJson(page, `/api/lesson/${String(lessonId)}/read`);
  return res.status;
}

export interface BeaconBody {
  listened: boolean;
  coveredSecs: number;
  durationSecs: number | null;
  requiredSecs: number;
  /** How far up the intervals just sent the server counted; null if none. */
  acceptedTo: number | null;
}

export async function beacon(
  page: Page,
  recordingId: number,
  intervals: [number, number][],
): Promise<ApiResult<BeaconBody>> {
  return postJson<BeaconBody>(page, `/api/media/${String(recordingId)}/progress`, { intervals });
}

// ---------------------------------------------------------------------------
// Fast-forward
// ---------------------------------------------------------------------------

/**
 * The trainee id of the session whose cookies this page holds, straight from
 * the app. Fast-forward reads it rather than taking one from the caller, so
 * the state it writes can only ever be the leased account's own.
 */
async function sessionTraineeId(page: Page): Promise<number> {
  const me = await getJson<{ me: { id: number } }>(page, '/api/me');
  const id = me.body?.me?.id;
  if (typeof id !== 'number' || !Number.isInteger(id) || id <= 0) {
    throw new Error(`e2e: GET /api/me did not name a trainee (${String(me.status)}).`);
  }
  return id;
}

/**
 * Credits a full listen of every playable recording on a stage to the signed-in
 * account, so a fast-forward can get past a gate it is not there to watch.
 *
 * This is a SKIP, and it is the same kind of skip the rest of this file makes.
 * Fast-forward already declines to click through lessons and quiz pages; what
 * it can never decline is the server's grading, and nothing here touches that.
 * The listening gate is different from the other two only in that it cannot be
 * paid quickly even through the API — it is bound to cumulative wall clock on
 * purpose, and the real recordings on the core stages run to seventeen minutes
 * — so the per-trainee state behind it is written directly instead. db.ts's
 * `creditFullListen` explains the shape, and why it is the shape a real listen
 * leaves behind.
 *
 * The rule itself is still proved, in full and through the real beacon
 * endpoint, by journey-cs.spec.ts against the 20-second fixture recording that
 * ops/dev/e2e-prepare.ts installs on s4. That spec passes the fixture's id in
 * `except`, so no pre-credit ever reaches the recording it listens to.
 *
 * It returns the recording ids it credited, so a spec that depends on one
 * being left alone can assert that rather than trust it.
 */
export async function fastForwardListening(
  page: Page,
  code: string,
  options: { except?: readonly number[] } = {},
): Promise<number[]> {
  return creditFullListen(await sessionTraineeId(page), code, options);
}

/**
 * Walks an account through whole stages using the real endpoints: every lesson
 * marked read, then the quiz answered correctly and graded by the server. Used
 * only to reach the stage a spec is actually about.
 *
 * The listening gate on the way is pre-credited rather than sat through — see
 * `fastForwardListening`. Only the stages named here are touched, so a stage a
 * spec means to listen to for real is never one of them.
 *
 * Throws with a useful message if anything refuses, so a broken fast-forward
 * can never be mistaken for a passing test.
 */
export async function fastForwardStages(page: Page, codes: readonly string[]): Promise<void> {
  const traineeId = await sessionTraineeId(page);
  for (const code of codes) {
    const stage = await getStage(page, code);
    if (stage.status !== 200) {
      throw new Error(`e2e: fast-forward could not open ${code}: ${String(stage.status)}`);
    }
    for (const lessonId of await lessonIdsForStage(code)) {
      const status = await readLesson(page, lessonId);
      if (status !== 204) {
        throw new Error(
          `e2e: fast-forward could not mark lesson ${String(lessonId)} of ${code} read ` +
            `(${String(status)})`,
        );
      }
    }
    await creditFullListen(traineeId, code);
    const answers = await correctAnswersForStage(code);
    const submitted = await submitQuiz(page, code, answers);
    if (submitted.status !== 200 || !submitted.body.passed) {
      throw new Error(
        `e2e: fast-forward did not pass ${code} (${String(submitted.status)}, ` +
          `${submitted.text.slice(0, 200)})`,
      );
    }
  }
}
