import { defineConfig, devices } from '@playwright/test';

// The S10 suite runs headless against an app that is ALREADY RUNNING. It never
// starts or stops a server of its own, and it never touches production — the
// database work all goes through ops/dev/e2e-prepare.ts, which refuses any
// database whose name does not look local.
//
//   locally  the Vite dev server on 5173, proxying /api to the API on 4100;
//   in CI    `vite preview` serving the BUILT client/dist on 4173, proxying
//            /api to `node server/dist/api.js` — the real build, not a dev
//            server compiling on demand. E2E_BASE_URL points at it.
//
// A CI runner has no training content (it is seeded from the prototype HTML,
// which can never be committed), so CI runs only the tests tagged
// `@content-free`. e2e/helpers/tags.ts and e2e-coverage.json hold that split,
// and e2e/global-setup.ts refuses any wider selection on an empty database.
//
// Parallelism is bounded by the accounts, not by the machine: only the mock
// CRM's invented users can sign in, each worker leases one for its whole life
// (e2e/helpers/lease.ts), and the API allows five sign-in attempts a minute
// from one IP address. Three workers is the sweet spot: four staff accounts
// exist, and the fourth is the spare a re-sign-in needs.

const baseURL = process.env['E2E_BASE_URL'] ?? 'http://localhost:5173';
const isCI = Boolean(process.env['CI']);

export default defineConfig({
  testDir: './tests',
  globalSetup: './global-setup.ts',
  globalTeardown: './global-teardown.ts',
  forbidOnly: isCI,
  retries: 0,
  // Windows on a slow disk: the app is a dev server compiling on demand, and
  // two specs sit through a real listen and a real 30-second roster refresh.
  timeout: 4 * 60_000,
  expect: { timeout: 20_000 },
  workers: Number(process.env['E2E_WORKERS'] ?? 3),
  // Tests inside one file share a leased account, so they run in order.
  fullyParallel: false,
  // In CI the run is the only witness: nobody is watching the terminal, so a
  // failure has to leave behind something a person can open. The HTML report
  // (with the trace and the screenshot of the failing step) is uploaded as an
  // artifact by .github/workflows/ci.yml.
  reporter: isCI
    ? [['github'], ['list'], ['html', { open: 'never', outputFolder: 'playwright-report' }]]
    : 'list',
  use: {
    baseURL,
    trace: isCI ? 'retain-on-failure' : 'on-first-retry',
    screenshot: isCI ? 'only-on-failure' : 'off',
    actionTimeout: 30_000,
    navigationTimeout: 60_000,
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
});
