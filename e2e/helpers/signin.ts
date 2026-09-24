import { expect } from '@playwright/test';
import type { Browser, BrowserContext, Page } from '@playwright/test';
import { claimSignInSlot } from './throttle.js';
import { nextCode, normaliseSecret } from './totp.js';

// Signing in the way a person does: the real /login screen, the real CRM check
// (the mock CRM locally), and a real authenticator code.
//
// On the FIRST sign-in after ops/dev/e2e-prepare.ts, the account has no
// authenticator, so the enrolment screen appears and prints the new secret —
// that is where the suite gets a secret it can generate codes from. Afterwards
// the same account sees the challenge screen and the remembered secret answers
// it.

export const DEV_PASSWORD = 'dev-password';

export type StorageState = Awaited<ReturnType<BrowserContext['storageState']>>;

const ENROL_HEADING = 'Set up your authenticator';
const CHALLENGE_HEADING = 'Enter your authenticator code';

export interface SignInResult {
  /** The base32 TOTP secret, without the spaces the screen prints. */
  secret: string;
  /** True when this sign-in went through the enrolment screen. */
  enrolled: boolean;
}

/**
 * Drives /login to a signed-in session on `page`.
 *
 * `remembered` is the secret from an earlier sign-in of the same account; it is
 * required once the account has enrolled.
 */
export async function signInThroughUi(
  page: Page,
  email: string,
  remembered?: string,
): Promise<SignInResult> {
  await claimSignInSlot();
  await page.goto('/login');

  await page.getByLabel('Work email').fill(email);
  await page.getByLabel('Password', { exact: true }).fill(DEV_PASSWORD);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();

  const enrolHeading = page.getByRole('heading', { name: ENROL_HEADING });
  const challengeHeading = page.getByRole('heading', { name: CHALLENGE_HEADING });
  await expect(enrolHeading.or(challengeHeading)).toBeVisible({ timeout: 30_000 });

  const enrolling = await enrolHeading.isVisible();
  let secret: string;
  if (enrolling) {
    // The key is behind a <details>; opening it is what somebody without a
    // camera to hand does.
    const details = page.locator('details').first();
    await details.locator('summary').click();
    const printed = await details.locator('code').first().innerText();
    secret = normaliseSecret(printed);
    expect(secret, 'the enrolment screen must print a base32 secret').toMatch(/^[A-Z2-7]{16,}$/);
  } else {
    if (remembered === undefined) {
      throw new Error(
        `e2e: ${email} already has an authenticator but no secret was remembered. ` +
          'Run ops/dev/e2e-prepare.ts (the global setup does) to reset it.',
      );
    }
    secret = normaliseSecret(remembered);
  }

  await page.getByLabel('6-digit code').fill(await nextCode(secret));
  await page
    .getByRole('button', { name: enrolling ? 'Turn on and sign in' : 'Verify and sign in' })
    .click();

  // Signed in: the login screen has handed over to the app.
  await page.waitForURL((url) => !url.pathname.startsWith('/login'), { timeout: 30_000 });

  return { secret, enrolled: enrolling };
}

/**
 * Signs in in a throw-away context and returns its cookies, so every test in
 * the worker can open a page that is already signed in without spending
 * another of the five-a-minute sign-in attempts the API allows per IP address.
 */
export async function captureSignedInState(
  browser: Browser,
  email: string,
  remembered?: string,
): Promise<{ state: StorageState; secret: string }> {
  const context = await browser.newContext();
  try {
    const page = await context.newPage();
    const { secret } = await signInThroughUi(page, email, remembered);
    const state = await context.storageState();
    return { state, secret };
  } finally {
    await context.close();
  }
}
