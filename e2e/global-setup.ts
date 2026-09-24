import { mkdirSync, writeFileSync } from 'node:fs';
import type { FullConfig } from '@playwright/test';
import { STATE_DIR, baseUrl, loadEnv, targetDatabase } from './helpers/env.js';
import { resetLeases } from './helpers/lease.js';
import { runOpsScript } from './helpers/run-ops.js';
import { resetSecrets } from './helpers/secrets.js';
import { PREPARED_FILE } from './helpers/state.js';
import type { PreparedState } from './helpers/state.js';
import { CONTENT_FREE_TAG, isContentFreeSelection } from './helpers/tags.js';
import { resetSignInMeter } from './helpers/throttle.js';

// Runs once, before any spec, against the LOCAL app that is already running.
//
//  1. checks the app is up and the ACADEMY_V2 flag is on — a suite that fails
//     because nothing is listening should say so in one line, not in 40;
//  2. runs ops/dev/e2e-prepare.ts, which carries the local-only database
//     guards (the name must contain 'dev' or 'test' and never 'prod'/'live')
//     and does all the state work: the nine per-track dev accounts, the five
//     sign-in accounts reset to day one with their authenticators cleared, and
//     the short fixture recording the listening journey needs;
//  3. clears the account leases and the sign-in meter from any previous run.
//
// ON A DATABASE WITH NO TRAINING CONTENT (a CI runner: the content is seeded
// from the approved prototype HTML, which can never be committed) step 2 can
// still prepare the accounts, but there is no stage, lesson, quiz or recording
// for a test to walk through. That is allowed — and only allowed — when the
// run has been restricted to the `@content-free` tag. Anything else stops
// here, loudly, rather than running a fraction of the suite behind a tick.

export default async function globalSetup(config: FullConfig): Promise<void> {
  loadEnv();
  mkdirSync(STATE_DIR, { recursive: true });

  const url = baseUrl();
  let health: { ok?: boolean; flag?: boolean; db?: boolean };
  try {
    const response = await fetch(`${url}/api/health`);
    health = (await response.json()) as typeof health;
  } catch (err) {
    throw new Error(
      `e2e: nothing answered ${url}/api/health (${String(err)}). Start the app first: ` +
        '`npm run dev:server` and `npm run dev:client`.',
    );
  }
  if (health.ok !== true || health.db !== true) {
    throw new Error(`e2e: ${url}/api/health says ${JSON.stringify(health)}.`);
  }
  if (health.flag !== true) {
    throw new Error('e2e: ACADEMY_V2 is off, so every API route answers 503. Turn it on in .env.');
  }

  const database = targetDatabase();
  const stdout = runOpsScript('ops/dev/e2e-prepare.ts', [
    '--expect-db',
    database,
    '--json',
    // An unseeded database is a fact to be reported, not a crash — the check
    // below decides whether it is acceptable for THIS selection of tests.
    '--allow-unseeded',
  ]);
  const json = stdout.slice(stdout.indexOf('{'));
  writeFileSync(PREPARED_FILE, json, 'utf8');

  resetLeases();
  resetSignInMeter();
  // The authenticators were just deleted, so any secret from a previous run is
  // dead: the first sign-in of this run enrols a new one.
  resetSecrets();

  const prepared = JSON.parse(json) as PreparedState;

  if (!prepared.seeded) {
    if (!isContentFreeSelection(config)) {
      throw new Error(
        `e2e: ${database} has been migrated but never seeded, so there are no stages, lessons, ` +
          'quizzes or recordings. Most of this suite cannot run here.\n' +
          `  * To run the part that does not need content: playwright test --grep "${CONTENT_FREE_TAG}"\n` +
          '  * To run all of it: seed the content first (ops/seed/seed-content.ts, which reads\n' +
          '    the approved prototype through PROTOTYPE_PATH — it is never committed).\n' +
          'Refusing to run a fraction of the suite as though it were the whole of it.',
      );
    }
    console.log(
      `e2e: ${String(prepared.accounts.length)} sign-in accounts prepared on ${database}. ` +
        `NO TRAINING CONTENT here, so only the ${CONTENT_FREE_TAG} tests are running; ` +
        'every browser journey through a stage, lesson, quiz or recording is unproven by this run.',
    );
    return;
  }

  console.log(
    `e2e: ${String(prepared.accounts.length)} sign-in accounts prepared on ${database}; ` +
      `fixture recording ${String(prepared.fixture?.durationSecs ?? 0)}s installed.`,
  );
}
