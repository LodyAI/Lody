import { expect, test } from '@playwright/test';

test('provider skip remains an honest path into Lody', async ({ page }) => {
  test.setTimeout(60_000);
  const response = await page.goto(
    '/iframe.html?id=onboarding-completionjourney--provider-skip&viewMode=story'
  );
  expect(response?.ok()).toBeTruthy();

  await expect(page.getByRole('heading', { name: 'Connect a coding agent' })).toBeVisible({
    timeout: 30_000,
  });
  await page.getByRole('button', { name: 'Skip for now' }).click();

  await expect(page.getByRole('heading', { name: 'Explore Lody' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Enter Lody' })).toBeEnabled();
  await page.getByRole('button', { name: 'Enter Lody' }).click();

  await expect(page.getByTestId('onboarding-complete')).toBeVisible();
});
