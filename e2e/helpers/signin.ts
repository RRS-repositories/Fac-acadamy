import type { Browser, BrowserContext, Page } from '@playwright/test';
import { claimSignInSlot } from './throttle.js';

// Signing in the way a person does: the real /login screen and the real CRM
// check (the mock CRM locally). Sign-in is one step — email and password — and
// there is no authenticator step after it (decision D21, 12 Oct).

export const DEV_PASSWORD = 'dev-password';

export type StorageState = Awaited<ReturnType<BrowserContext['storageState']>>;

/** Drives /login to a signed-in session on `page`. */
export async function signInThroughUi(page: Page, email: string): Promise<void> {
  await claimSignInSlot();
  await page.goto('/login');

  await page.getByLabel('Work email').fill(email);
  await page.getByLabel('Password', { exact: true }).fill(DEV_PASSWORD);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();

  // Signed in: the login screen has handed over to the app.
  await page.waitForURL((url) => !url.pathname.startsWith('/login'), { timeout: 30_000 });
}

/**
 * Signs in in a throw-away context and returns its cookies, so every test in
 * the worker can open a page that is already signed in without spending
 * another of the five-a-minute sign-in attempts the API allows per IP address.
 */
export async function captureSignedInState(browser: Browser, email: string): Promise<StorageState> {
  const context = await browser.newContext();
  try {
    const page = await context.newPage();
    await signInThroughUi(page, email);
    return await context.storageState();
  } finally {
    await context.close();
  }
}
