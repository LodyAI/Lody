import { expect, test } from '@playwright/test';

test('selects the first-task Agent and skips without starting', async ({ page }) => {
  const response = await page.goto(
    '/iframe.html?id=onboarding-firsttaskscreen--multiple-providers&viewMode=story'
  );
  expect(response?.ok()).toBeTruthy();

  await expect(page.getByRole('heading', { name: 'Start your first session' })).toBeVisible();
  const provider = page.getByRole('combobox', { name: 'Agent' });
  await expect(provider).toContainText('Claude Code');

  await provider.click();
  await page.getByRole('option', { name: 'Kimi' }).click();
  await expect(provider).toContainText('Kimi');

  await page.getByRole('button', { name: 'Skip for now' }).click();
  await expect(page.getByTestId('first-task-skipped')).toBeAttached();
});
