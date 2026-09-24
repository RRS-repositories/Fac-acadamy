// CHECKLIST 05 item 1 — the screenshot pairs for Brad. LOCAL / DEV ONLY.
//
//   npx playwright install chromium        (once)
//   npx tsx ops/dev/screenshots.ts         (the local app must be running)
//
// It captures the SAME eight views twice: once from the running local app
// (http://localhost:5173) and once from the prototype opened from a file://
// URL, and writes them side by side as <view>-app.png and <view>-prototype.png
// so the two can be put next to each other.
//
// DATA HYGIENE
//   * The images go OUTSIDE this repo, next to the build pack (the prototype
//     screens show the firm's real training content and real staff details).
//     The default folder is derived from PROTOTYPE_PATH; the script refuses to
//     write anywhere inside the repo.
//   * No real person appears in this file. The app signs in with the local
//     mock CRM accounts (all @example.com) and the prototype's demo form is
//     filled with an invented name and an @example.com address.
//   * Nothing is read out of the prototype into the repo: the screenshots are
//     images, and they never come back here.
//
// LOCAL ONLY. The same two guards as every ops/dev script: the database name
// must look local (contains 'dev' or 'test', never 'prod'/'live') and must
// match DB_NAME and current_database(). The script sets a track and, through
// the API, marks lessons read; it never touches production.
//
// A view that cannot be reached (a page that is not built yet, a stage with no
// quiz) is SKIPPED with a message. The run still produces every other pair and
// prints a table of what it got.
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { authenticator } from 'otplib';
import { chromium } from 'playwright';
import type { Browser, BrowserContext, Page } from 'playwright';
import { loadDotenvIfPresent } from '../../server/src/config/dotenv.js';
import { resolvePrototypePath } from '../lib/prototype-path.js';
import {
  DevError,
  type Queryable,
  connectDev,
  parseBaseUrl,
  parseExpectDb,
  runIfMain,
  table,
} from './lib.js';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

export const SCREENSHOTS_USAGE =
  'Usage: screenshots [--expect-db <database name>] [--base-url http://localhost:5173] ' +
  '[--out <folder outside the repo>] [--only app|prototype]';

export const DEFAULT_BASE_URL = 'http://localhost:5173';
const VIEWPORT = { width: 1440, height: 900 };
/** Per-view budget: a missing page should skip quickly, not hang the run. */
const VIEW_TIMEOUT_MS = 15_000;
/** What is typed into both search boxes for the status guide pair. */
const SEARCH_TERM = 'dsar';

/** The eight views of CHECKLIST 05 item 1, in the order they are captured. */
export const VIEWS = [
  'login',
  'dashboard-agent',
  'dashboard-dept',
  'stage',
  'lesson',
  'quiz-question',
  'quiz-result',
  'status-guide-search',
] as const;
export type View = (typeof VIEWS)[number];

// ---------------------------------------------------------------------------
// The two sign-ins. Local mock CRM accounts only (server/src/integrations/crm/
// mockCrm.ts): invented people, all @example.com, password 'dev-password'.
// ---------------------------------------------------------------------------
const MOCK_PASSWORD = 'dev-password';

interface Subject {
  /** Mock CRM account used to sign in to the app. */
  email: string;
  /** academy.trainees.track set before the dashboard is captured. */
  track: string;
  /** The prototype's "Training track" option with the same shape. */
  prototypeTrack: string;
  /** Invented sign-in details for the prototype's demo form. */
  prototypeName: string;
  prototypeEmail: string;
}

/** An agent track (levels) and a department track: the two dashboard shapes. */
const AGENT: Subject = {
  email: 'shot.agent@example.com',
  track: 'CS',
  prototypeTrack: 'Customer Service',
  prototypeName: 'Jordan Avery',
  prototypeEmail: 'jordan.avery@example.com',
};
const DEPARTMENT: Subject = {
  email: 'shot.dept@example.com',
  track: 'ADMIN',
  prototypeTrack: 'Admin',
  prototypeName: 'Morgan Ellis',
  prototypeEmail: 'morgan.ellis@example.com',
};

// ---------------------------------------------------------------------------
// Arguments
// ---------------------------------------------------------------------------

export interface ScreenshotArgs {
  expectDb: string;
  baseUrl: string;
  /** Absolute, and never inside the repo. */
  outDir: string;
  only: 'app' | 'prototype' | 'both';
}

/**
 * Where the pairs are written: `--out`, else the build pack's sibling
 * `screenshots` folder (…/T-22-09/screenshots), derived from PROTOTYPE_PATH so
 * no local path is written into this repo.
 */
export function defaultOutDir(prototypePath: string): string {
  return path.resolve(path.dirname(prototypePath), '..', 'screenshots');
}

function normCase(p: string): string {
  return process.platform === 'win32' ? p.toLowerCase() : p;
}

/** Images must never land in the repo (they show real content and real names). */
export function assertOutsideRepo(dir: string, repoRoot = REPO_ROOT): string {
  const abs = path.resolve(dir);
  const rel = path.relative(normCase(repoRoot), normCase(abs));
  if (rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel))) {
    throw new DevError(
      `Refusing to write screenshots inside the repo (${abs}). The prototype screens show ` +
        'real staff details: keep the images in the build pack folder, outside this repo.',
    );
  }
  return abs;
}

export function parseScreenshotArgs(argv: string[], env: NodeJS.ProcessEnv): ScreenshotArgs {
  const { values } = parseArgs({
    args: argv,
    strict: true,
    allowPositionals: false,
    options: {
      'expect-db': { type: 'string' },
      'base-url': { type: 'string' },
      out: { type: 'string' },
      only: { type: 'string' },
      help: { type: 'boolean', short: 'h', default: false },
    },
  });
  if (values.help) throw new DevError(SCREENSHOTS_USAGE);

  const only = values.only ?? 'both';
  if (only !== 'app' && only !== 'prototype' && only !== 'both') {
    throw new DevError('--only must be "app" or "prototype".');
  }
  const prototype = resolvePrototypePath(env);
  return {
    expectDb: parseExpectDb(values['expect-db'] ?? env['DB_NAME']),
    baseUrl: parseBaseUrl(values['base-url'], DEFAULT_BASE_URL),
    outDir: assertOutsideRepo(values.out ?? defaultOutDir(prototype)),
    only,
  };
}

// ---------------------------------------------------------------------------
// Results
// ---------------------------------------------------------------------------

type Outcome = { ok: true; file: string } | { ok: false; why: string };

class Results {
  private readonly rows = new Map<string, Outcome>();

  record(view: View, side: 'app' | 'prototype', outcome: Outcome): void {
    this.rows.set(`${view}:${side}`, outcome);
    const what = `${view} (${side})`;
    console.log(
      outcome.ok ? `  saved   ${what} -> ${outcome.file}` : `  SKIPPED ${what}: ${outcome.why}`,
    );
  }

  private cell(view: View, side: 'app' | 'prototype'): string {
    const row = this.rows.get(`${view}:${side}`);
    if (row === undefined) return 'not run';
    return row.ok ? 'PASS' : 'SKIPPED';
  }

  print(outDir: string): number {
    console.log(
      `\nCHECKLIST 05 item 1 — screenshot pairs\n` +
        table(
          ['view', 'app', 'prototype'],
          VIEWS.map((v) => [v, this.cell(v, 'app'), this.cell(v, 'prototype')]),
        ),
    );
    const pairs = VIEWS.filter(
      (v) => this.cell(v, 'app') === 'PASS' && this.cell(v, 'prototype') === 'PASS',
    );
    console.log(`\nComplete pairs: ${pairs.length}/${VIEWS.length}`);
    console.log(`Folder: ${outDir}`);
    // A skipped view is reported, not a failure: the run still delivers the
    // pairs it could reach.
    return 0;
  }
}

async function shoot(
  page: Page,
  view: View,
  side: 'app' | 'prototype',
  outDir: string,
  results: Results,
  navigate: () => Promise<void>,
): Promise<boolean> {
  const file = path.join(outDir, `${view}-${side}.png`);
  try {
    await navigate();
    // Back to the top first: a full-page shot taken while the page is scrolled
    // leaves the sticky rail halfway down the image.
    await page.evaluate('window.scrollTo(0, 0)');
    await page.screenshot({ path: file, fullPage: true });
    results.record(view, side, { ok: true, file });
    return true;
  } catch (err) {
    results.record(view, side, {
      ok: false,
      why: (err as Error).message.split('\n')[0] ?? 'failed',
    });
    return false;
  }
}

// ---------------------------------------------------------------------------
// The app side
// ---------------------------------------------------------------------------

interface TrackStageLite {
  code: string;
  state: string;
}

/** Runs fetch INSIDE the page, so the session cookie goes with it. */
async function apiGet<T>(page: Page, apiPath: string): Promise<T> {
  const body = await page.evaluate(async (p: string) => {
    const res = await fetch(p, {
      credentials: 'same-origin',
      headers: { Accept: 'application/json' },
    });
    return { status: res.status, text: await res.text() };
  }, apiPath);
  if (body.status !== 200) throw new DevError(`GET ${apiPath} answered ${body.status}`);
  return JSON.parse(body.text) as T;
}

async function apiPost(page: Page, apiPath: string): Promise<number> {
  return page.evaluate(
    async (p: string) => (await fetch(p, { method: 'POST', credentials: 'same-origin' })).status,
    apiPath,
  );
}

/**
 * Sign in through the real UI. A fresh authenticator enrolment is forced
 * first (the MFA row is deleted), so the login response carries the secret and
 * the code can be generated here with otplib.
 */
async function signInOnce(page: Page, baseUrl: string, subject: Subject): Promise<void> {
  await page.goto(`${baseUrl}/login`, { waitUntil: 'networkidle' });
  await page.getByLabel('Work email').fill(subject.email);
  await page.getByLabel('Password').fill(MOCK_PASSWORD);

  const loginResponse = page
    .waitForResponse(
      (res) => res.url().endsWith('/api/auth/login') && res.request().method() === 'POST',
      { timeout: VIEW_TIMEOUT_MS },
    )
    .then(async (res) => {
      const body = (await res.json()) as { enrol?: { secret?: string } };
      return body.enrol?.secret ?? null;
    })
    .catch(() => null);

  await page.getByRole('button', { name: 'Sign in' }).click();
  const code = page.getByLabel('6-digit code');
  await code.waitFor({ timeout: VIEW_TIMEOUT_MS });

  // The secret comes from the login response, or — when a dev-server reload
  // swallows that body — from the key the enrolment step prints on screen.
  let secret = await loginResponse;
  if (secret === null) {
    const printed = (await page.locator('details code').first().textContent()) ?? '';
    const cleaned = printed.replace(/\s+/g, '');
    if (/^[A-Z2-7]{16,}$/.test(cleaned)) secret = cleaned;
  }
  if (secret === null) {
    throw new DevError('no enrolment secret in the sign-in response or on the enrolment step');
  }

  await code.fill(authenticator.clone({ step: 30, digits: 6 }).generate(secret));
  await page.getByRole('button', { name: /sign in/i }).click();
  await page.waitForURL((url) => !url.pathname.startsWith('/login'), { timeout: VIEW_TIMEOUT_MS });
}

/** Signs in, with one retry: the dev server reloads while other work lands. */
async function signIn(page: Page, baseUrl: string, subject: Subject): Promise<void> {
  try {
    await signInOnce(page, baseUrl, subject);
  } catch (err) {
    console.log(`  (first sign-in attempt failed: ${(err as Error).message}; retrying)`);
    await signInOnce(page, baseUrl, subject);
  }
}

/** Deletes the authenticator enrolment so the next sign-in returns a secret. */
async function resetMfa(db: Queryable, email: string): Promise<void> {
  await db.query(
    `DELETE FROM academy.trainee_mfa
      WHERE trainee_id IN (SELECT id FROM academy.trainees WHERE lower(email) = lower($1))`,
    [email],
  );
}

async function setTrack(db: Queryable, email: string, track: string): Promise<void> {
  await db.query('UPDATE academy.trainees SET track = $2 WHERE lower(email) = lower($1)', [
    email,
    track,
  ]);
}

/** The correct option ids for a stage's quiz, read locally to drive the result view. */
async function correctOptions(db: Queryable, stageCode: string): Promise<Map<number, number>> {
  const { rows } = await db.query<{ question_id: string; option_id: string }>(
    `SELECT q.id AS question_id, o.id AS option_id
       FROM academy.questions q
       JOIN academy.question_options o ON o.question_id = q.id
       JOIN academy.quizzes z ON z.id = q.quiz_id
       JOIN academy.stages s ON s.id = z.stage_id
      WHERE s.code = $1 AND o.is_correct AND q.is_active AND q.approval_state = 'APPROVED'`,
    [stageCode],
  );
  return new Map(rows.map((r) => [Number(r.question_id), Number(r.option_id)]));
}

/** The dashboard: whatever the app serves at "/" for this trainee. */
async function appDashboard(page: Page, baseUrl: string): Promise<void> {
  await page.goto(`${baseUrl}/`, { waitUntil: 'networkidle' });
  await page.getByRole('main').waitFor({ timeout: VIEW_TIMEOUT_MS });
}

interface AppCapture {
  /** The trainee's first available stage, if the API gives one. */
  stageCode: string | null;
  lessonIds: number[];
}

async function appStageContext(page: Page): Promise<AppCapture> {
  const track = await apiGet<{ stages: TrackStageLite[] }>(page, '/api/track');
  const first = track.stages.find((s) => s.state !== 'locked') ?? track.stages[0];
  if (first === undefined) return { stageCode: null, lessonIds: [] };
  const stage = await apiGet<{ lessons: { id: number }[] }>(
    page,
    `/api/stage/${encodeURIComponent(first.code)}`,
  );
  return { stageCode: first.code, lessonIds: stage.lessons.map((l) => l.id) };
}

async function captureApp(
  context: BrowserContext,
  args: ScreenshotArgs,
  db: Queryable,
  results: Results,
): Promise<void> {
  const page = await context.newPage();
  page.setDefaultTimeout(VIEW_TIMEOUT_MS);

  // 1. Login, signed out.
  await shoot(page, 'login', 'app', args.outDir, results, async () => {
    await page.goto(`${args.baseUrl}/login`, { waitUntil: 'networkidle' });
    await page.getByLabel('Work email').waitFor();
  });

  // 2. Dashboard on a department track, in its own signed-out context.
  await resetMfa(db, DEPARTMENT.email);
  try {
    await signIn(page, args.baseUrl, DEPARTMENT);
    await setTrack(db, DEPARTMENT.email, DEPARTMENT.track);
    await shoot(page, 'dashboard-dept', 'app', args.outDir, results, () =>
      appDashboard(page, args.baseUrl),
    );
  } catch (err) {
    results.record('dashboard-dept', 'app', { ok: false, why: (err as Error).message });
  }
  await context.clearCookies();

  // 3. Everything else on the agent track: dashboard, stage, lesson, quiz.
  await resetMfa(db, AGENT.email);
  await setTrack(db, AGENT.email, AGENT.track);
  let signedIn = false;
  try {
    await signIn(page, args.baseUrl, AGENT);
    await setTrack(db, AGENT.email, AGENT.track);
    signedIn = true;
  } catch (err) {
    const why = `could not sign in as the agent-track account: ${(err as Error).message}`;
    for (const view of [
      'dashboard-agent',
      'stage',
      'lesson',
      'quiz-question',
      'quiz-result',
      'status-guide-search',
    ] as View[]) {
      results.record(view, 'app', { ok: false, why });
    }
  }
  if (!signedIn) {
    await page.close();
    return;
  }

  await shoot(page, 'dashboard-agent', 'app', args.outDir, results, () =>
    appDashboard(page, args.baseUrl),
  );

  const { stageCode, lessonIds } = await appStageContext(page);
  if (stageCode === null) {
    for (const view of ['stage', 'lesson', 'quiz-question', 'quiz-result'] as View[]) {
      results.record(view, 'app', { ok: false, why: 'the API served no stage for this account' });
    }
  } else {
    const stageUrl = `${args.baseUrl}/stage/${encodeURIComponent(stageCode)}`;
    await shoot(page, 'stage', 'app', args.outDir, results, async () => {
      await page.goto(stageUrl, { waitUntil: 'networkidle' });
      await page.getByRole('main').waitFor();
    });

    const firstLesson = lessonIds[0];
    if (firstLesson === undefined) {
      results.record('lesson', 'app', { ok: false, why: 'the stage has no lessons' });
    } else {
      await shoot(page, 'lesson', 'app', args.outDir, results, async () => {
        await page.goto(`${stageUrl}/lesson/${firstLesson}`, { waitUntil: 'networkidle' });
        await page.getByRole('main').waitFor();
      });
    }

    // The quiz needs every lesson read. That goes through the API, exactly as
    // the UI does it: the server still decides whether the quiz opens.
    for (const id of lessonIds) await apiPost(page, `/api/lesson/${id}/read`);

    const quizUrl = `${stageUrl}/quiz`;
    const gotQuiz = await shoot(page, 'quiz-question', 'app', args.outDir, results, async () => {
      await page.goto(quizUrl, { waitUntil: 'networkidle' });
      await page.getByRole('radio').first().waitFor();
    });

    if (!gotQuiz) {
      results.record('quiz-result', 'app', {
        ok: false,
        why: 'the quiz question view was not reached',
      });
    } else {
      await shoot(page, 'quiz-result', 'app', args.outDir, results, async () => {
        const quiz = await apiGet<{
          questions: { id: number; options: { id: number; text: string }[] }[];
        }>(page, `/api/stage/${encodeURIComponent(stageCode)}/quiz`);
        const correct = await correctOptions(db, stageCode);
        for (const question of quiz.questions) {
          const wanted = correct.get(question.id);
          const option = question.options.find((o) => o.id === wanted) ?? question.options[0];
          if (option === undefined) continue;
          await page.getByRole('radio', { name: option.text, exact: true }).first().check();
        }
        await page.getByRole('button', { name: /submit/i }).click();
        // The result view replaces the questions: wait for the radios to go.
        await page.getByRole('radio').first().waitFor({ state: 'detached' });
        await page.getByRole('main').waitFor();
      });
    }
  }

  // 8. The Status Guide, filtered.
  await shoot(page, 'status-guide-search', 'app', args.outDir, results, async () => {
    await page.goto(`${args.baseUrl}/status-guide`, { waitUntil: 'networkidle' });
    const box = page.getByRole('searchbox');
    await box.waitFor();
    await box.fill(SEARCH_TERM);
    await page.getByRole('listitem').first().waitFor();
  });

  await page.close();
}

// ---------------------------------------------------------------------------
// The prototype side
//
// The prototype is one HTML file with global functions (doLogin, openStage,
// setStep, startQuiz, submitQuiz, filterStatuses) and global state (view,
// progress, STAGES). Driving those directly is the only way to reach a locked
// screen in a file:// page, and it changes nothing on disk.
// ---------------------------------------------------------------------------

/** Signs in to the prototype's demo form with invented details. */
async function prototypeSignIn(page: Page, fileUrl: string, subject: Subject): Promise<void> {
  await page.goto(fileUrl, { waitUntil: 'load' });
  await page.locator('#fName').fill(subject.prototypeName);
  await page.locator('#fEmail').fill(subject.prototypeEmail);
  await page.locator('#fTrack').selectOption(subject.prototypeTrack);
  await page.locator('#loginBtn').click();
  await page.locator('#appScreen').waitFor({ state: 'visible' });
  await prototypeToastGone(page);
}

/**
 * Runs an expression in the prototype's own global scope.
 *
 * The prototype keeps its state in top-level `let`/`const` bindings (view,
 * progress, quizState, STAGES). Those live in the global LEXICAL scope, so
 * they are not properties of `window` and a normal page.evaluate() callback
 * cannot see them — exactly as the prototype's own inline onclick handlers do,
 * an expression evaluated in page scope can.
 */
async function run<T>(page: Page, expression: string): Promise<T> {
  return page.evaluate<T>(expression);
}

/** Opens a stage by index, past the prototype's own lock check. */
async function prototypeOpenStage(
  page: Page,
  index: number,
  step: string,
  lesson = 0,
): Promise<void> {
  await run(
    page,
    `view = { screen: 'stage', stage: ${String(index)}, step: '${step}', ` +
      `lesson: ${String(lesson)} }; navRender();`,
  );
}

/** Marks every lesson and recording of the open stage done, so its quiz opens. */
async function prototypeCompleteParts(page: Page): Promise<void> {
  await run(
    page,
    `(() => { const s = STAGES[view.stage];
        s.lessons.forEach((_, i) => progress[s.id].lessons[i] = true);
        s.recordings.forEach((_, i) => progress[s.id].recs[i] = true);
        navRender(); })()`,
  );
}

/**
 * Clears the prototype's toast before a screenshot, so the banner it shows for
 * 2.6 s after a sign-in or a quiz pass is not sitting across the content. It
 * only removes the class the prototype's own timer would remove a moment
 * later; nothing else about the page changes.
 */
async function prototypeToastGone(page: Page): Promise<void> {
  await run(page, "document.getElementById('toast').classList.remove('show')").catch(
    () => undefined,
  );
}

/** Where the Status Guide lesson sits, so it can be opened directly. */
async function prototypeStatusGuideStage(page: Page): Promise<{ stage: number; lesson: number }> {
  return run<{ stage: number; lesson: number }>(
    page,
    `(() => { for (let i = 0; i < STAGES.length; i++) {
        const j = STAGES[i].lessons.findIndex((l) => /status guide/i.test(l.t));
        if (j !== -1) return { stage: i, lesson: j };
      } return { stage: 0, lesson: 0 }; })()`,
  );
}

async function capturePrototype(
  context: BrowserContext,
  args: ScreenshotArgs,
  fileUrl: string,
  results: Results,
): Promise<void> {
  const page = await context.newPage();
  page.setDefaultTimeout(VIEW_TIMEOUT_MS);

  await shoot(page, 'login', 'prototype', args.outDir, results, async () => {
    await page.goto(fileUrl, { waitUntil: 'load' });
    await page.locator('#loginScreen').waitFor({ state: 'visible' });
  });

  await shoot(page, 'dashboard-dept', 'prototype', args.outDir, results, () =>
    prototypeSignIn(page, fileUrl, DEPARTMENT),
  );

  const agentDashboard = await shoot(
    page,
    'dashboard-agent',
    'prototype',
    args.outDir,
    results,
    () => prototypeSignIn(page, fileUrl, AGENT),
  );
  if (!agentDashboard) {
    for (const view of [
      'stage',
      'lesson',
      'quiz-question',
      'quiz-result',
      'status-guide-search',
    ] as View[]) {
      results.record(view, 'prototype', {
        ok: false,
        why: 'the prototype sign-in did not complete',
      });
    }
    await page.close();
    return;
  }

  await shoot(page, 'stage', 'prototype', args.outDir, results, () =>
    prototypeOpenStage(page, 0, 'lessons'),
  );
  await shoot(page, 'lesson', 'prototype', args.outDir, results, () =>
    prototypeOpenStage(page, 0, 'lessons', 1),
  );

  const gotQuiz = await shoot(
    page,
    'quiz-question',
    'prototype',
    args.outDir,
    results,
    async () => {
      await prototypeOpenStage(page, 0, 'lessons');
      await prototypeCompleteParts(page);
      await prototypeOpenStage(page, 0, 'quiz');
      await run(page, 'startQuiz()');
      await page.locator('input[type=radio]').first().waitFor();
    },
  );

  if (!gotQuiz) {
    results.record('quiz-result', 'prototype', {
      ok: false,
      why: 'the quiz question view was not reached',
    });
  } else {
    await shoot(page, 'quiz-result', 'prototype', args.outDir, results, async () => {
      // Answer every question correctly, the way a passing trainee would, then
      // submit through the prototype's own grader.
      await run(
        page,
        '(() => { quizState.answers = quizState.qs.map((q) => q.a); submitQuiz(); })()',
      );
      await page.locator('.quiz-result').waitFor();
      await prototypeToastGone(page);
    });
  }

  await shoot(page, 'status-guide-search', 'prototype', args.outDir, results, async () => {
    const where = await prototypeStatusGuideStage(page);
    await prototypeOpenStage(page, where.stage, 'lessons', where.lesson);
    const box = page.locator('input[oninput^="filterStatuses"]');
    await box.waitFor();
    await box.fill(SEARCH_TERM);
    await page.locator('.sg-item:visible').first().waitFor();
    await prototypeToastGone(page);
  });

  await page.close();
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

export async function main(argv = process.argv.slice(2)): Promise<number> {
  loadDotenvIfPresent();
  const args = parseScreenshotArgs(argv, process.env);
  const prototype = resolvePrototypePath(process.env);
  const fileUrl = pathToFileURL(prototype).href;

  mkdirSync(args.outDir, { recursive: true });
  console.log(`App:       ${args.baseUrl}`);
  console.log(`Prototype: ${prototype}`);
  console.log(`Output:    ${args.outDir}\n`);

  const db = await connectDev(args.expectDb, 'academy-screenshots');
  const results = new Results();
  let browser: Browser | null = null;
  try {
    browser = await chromium.launch();
    if (args.only !== 'prototype') {
      const context = await browser.newContext({ viewport: VIEWPORT });
      console.log('The local app:');
      await captureApp(context, args, db, results);
      await context.close();
    }
    if (args.only !== 'app') {
      // A separate context: the prototype keeps its demo state in localStorage.
      const context = await browser.newContext({ viewport: VIEWPORT });
      console.log('The prototype:');
      await capturePrototype(context, args, fileUrl, results);
      await context.close();
    }
  } finally {
    await browser?.close();
    await db.end().catch(() => undefined);
  }

  return results.print(args.outDir);
}

runIfMain(import.meta.url, 'screenshots', main);
