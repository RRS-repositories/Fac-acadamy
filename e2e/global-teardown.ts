import { loadEnv, targetDatabase } from './helpers/env.js';
import { resetLeases } from './helpers/lease.js';
import { runOpsScript } from './helpers/run-ops.js';

// Puts the seeded content back exactly as the S02 seed left it: the fixture
// recording's slot returns to "coming soon" and its file is deleted, so
// `ops/seed/verify-seed.ts` still counts seven recordings with media.
//
// The accounts are left as they are on purpose: after a failing run it is
// useful to be able to sign in and look at what the suite was looking at. The
// next run's global setup resets them.

export default async function globalTeardown(): Promise<void> {
  loadEnv();
  resetLeases();
  try {
    runOpsScript('ops/dev/e2e-prepare.ts', ['--expect-db', targetDatabase(), '--clean']);
  } catch (err) {
    console.error(
      'e2e: could not remove the fixture recording. Run ' +
        '`npm run e2e:clean -w @fac-academy/e2e` by hand.',
      err,
    );
  }
}
