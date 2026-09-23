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

test('pending provider selects a project then finishes on the preparing summary', async ({
  page,
}) => {
  test.setTimeout(60_000);
  const response = await page.goto(
    '/iframe.html?id=onboarding-completionjourney--provider-pending-setup&viewMode=story'
  );
  expect(response?.ok()).toBeTruthy();

  await expect(page.getByRole('heading', { name: 'Connect a coding agent' })).toBeVisible({
    timeout: 30_000,
  });
  await page.getByRole('button', { name: 'Next' }).click();

  await expect(page.getByRole('heading', { name: 'Pick a project to start with' })).toBeVisible();
  await page.getByRole('button', { name: 'Next' }).click();

  await expect(page.getByRole('heading', { name: 'Ready to enter Lody' })).toBeVisible();
  await expect(page.getByText('Your Agent setup is still in progress.')).toBeVisible();
  await expect(page.getByRole('cell', { name: 'Codex' })).toBeVisible();
  await expect(page.getByRole('cell', { name: 'Lody' })).toBeVisible();
  await expect(page.getByText('Setting up')).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Run your first task' })).toHaveCount(0);
  await page.getByRole('button', { name: 'Enter Lody' }).click();

  await expect(page.getByTestId('onboarding-complete')).toBeVisible();
});
