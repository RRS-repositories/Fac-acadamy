import { expect, test } from '@playwright/test';

// The cheapest test in the suite, and the one that says what is wrong when
// nothing else can run: the app is up, the flag is on, a signed-out visitor is
// sent to the sign-in screen, and the API refuses them.

test('the app is up and the flag is on', async ({ request }) => {
  const response = await request.get('/api/health');
  expect(response.status()).toBe(200);
  expect(await response.json()).toMatchObject({ ok: true, db: true, flag: true });
});

test('a signed-out visitor is sent to sign in, and the API refuses them', async ({ page }) => {
  await page.goto('/');
  await page.waitForURL(/\/login/);
  await expect(page.getByRole('heading', { name: 'Sign in to start training' })).toBeVisible();
  await expect(page.getByLabel('Work email')).toBeVisible();

  const refused = await page.request.get('/api/track', { failOnStatusCode: false });
  expect(refused.status()).toBe(401);
  expect(await refused.json()).toEqual({ error: 'not_signed_in' });
});
