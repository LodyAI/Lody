import { expect, test } from '@playwright/test';

const STORY_URL =
  '/iframe.html?id=settings-accountsettings--workspace-general-merged&viewMode=story&globals=locale:en';

test('shows copy feedback for a pending workspace invitation', async ({ page }) => {
  const response = await page.goto(STORY_URL);
  expect(response?.ok()).toBeTruthy();

  await expect(page.getByText('Pending Invitations')).toBeVisible();

  const invitation = page.getByText('dave@example.com').locator('xpath=ancestor::div[contains(@class, "gap-3")]');
  const copyButton = invitation.locator('button').first();

  await expect(copyButton).toHaveText('Copy Link');

  await copyButton.click();

  await expect(copyButton).toHaveText('Copied!');
  await expect(copyButton.locator('svg.lucide-check')).toBeVisible();
  await expect(copyButton).toHaveText('Copy Link', { timeout: 2_500 });
  await expect(copyButton.locator('svg.lucide-copy')).toBeVisible();
});
