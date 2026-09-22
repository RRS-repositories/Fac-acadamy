import { defineConfig, devices } from '@playwright/test';

// Points at a running app: Vite dev server locally, or E2E_BASE_URL.
const baseURL = process.env['E2E_BASE_URL'] ?? 'http://localhost:5173';
const isCI = Boolean(process.env['CI']);

export default defineConfig({
  testDir: './tests',
  forbidOnly: isCI,
  retries: isCI ? 1 : 0,
  reporter: isCI ? 'github' : 'list',
  use: {
    baseURL,
    trace: 'on-first-retry',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
});
