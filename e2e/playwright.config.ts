import { defineConfig, devices } from '@playwright/test';

// The S10 suite runs headless against the app that is ALREADY RUNNING locally:
// the Vite dev server on 5173, which proxies /api to the API on 4100. It never
// starts or stops a server of its own, and it never touches production — the
// database work all goes through ops/dev/e2e-prepare.ts, which refuses any
// database whose name does not look local.
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
  reporter: isCI ? [['github'], ['list']] : 'list',
  use: {
    baseURL,
    trace: 'on-first-retry',
    actionTimeout: 30_000,
    navigationTimeout: 60_000,
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
});
