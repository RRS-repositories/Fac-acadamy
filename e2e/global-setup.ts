import { mkdirSync, writeFileSync } from 'node:fs';
import { STATE_DIR, baseUrl, loadEnv, targetDatabase } from './helpers/env.js';
import { resetLeases } from './helpers/lease.js';
import { runOpsScript } from './helpers/run-ops.js';
import { resetSecrets } from './helpers/secrets.js';
import { PREPARED_FILE } from './helpers/state.js';
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

export default async function globalSetup(): Promise<void> {
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
  const stdout = runOpsScript('ops/dev/e2e-prepare.ts', ['--expect-db', database, '--json']);
  const json = stdout.slice(stdout.indexOf('{'));
  writeFileSync(PREPARED_FILE, json, 'utf8');

  resetLeases();
  resetSignInMeter();
  // The authenticators were just deleted, so any secret from a previous run is
  // dead: the first sign-in of this run enrols a new one.
  resetSecrets();

  const prepared = JSON.parse(json) as { accounts: unknown[]; fixture: { durationSecs: number } };
  console.log(
    `e2e: ${String(prepared.accounts.length)} sign-in accounts prepared on ${database}; ` +
      `fixture recording ${String(prepared.fixture.durationSecs)}s installed.`,
  );
}
