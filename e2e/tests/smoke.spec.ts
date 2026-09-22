import { expect, test } from '@playwright/test';

test('home page shows the FAC Academy heading', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'FAC Academy' })).toBeVisible();
});
