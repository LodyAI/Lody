import { test, expect, type Page } from '@playwright/test';

const story = (page: Page, id: string) =>
  page.goto(`/iframe.html?id=settings-projectcreatewizard--${id}&viewMode=story&globals=locale:en`);

test('a local project is built one question at a time and keeps only its machine', async ({
  page,
}) => {
  await story(page, 'choose-kind');
  await page.getByRole('button', { name: /Includes local folders/ }).click();
  await expect(page.getByText('Which machine are the folders on?')).toBeVisible();
  await page.getByRole('button', { name: /zhaoliangdeMacBook-Pro\.local/ }).click();

  const next = page.getByRole('button', { name: 'Next', exact: true });
  await expect(next).toBeDisabled();
  await page.getByRole('checkbox', { name: 'notes', exact: true }).click();
  await page.getByRole('tab', { name: /GitHub repositories/ }).click();
  await page.getByRole('checkbox', { name: 'acme/proto', exact: true }).click();
  await expect(page.getByText('2 selected')).toBeVisible();

  // Changing the machine drops the folder bound to the previous one.
  await page.getByRole('button', { name: 'Back', exact: true }).click();
  await page.getByRole('button', { name: /wibusdeMacBook-Air-M2\.local/ }).click();
  await expect(page.getByText('1 selected')).toBeVisible();
  await page.getByRole('checkbox', { name: 'ios', exact: true }).click();
  await next.click();

  await expect(page.getByRole('textbox', { name: 'Project name' })).toHaveValue('proto');
  await expect(page.getByText('Edited in place')).toBeVisible();
  await expect(
    page.getByText('Conversations in this project run on wibusdeMacBook-Air-M2.local.')
  ).toBeVisible();
  await expect(page.getByRole('button', { name: 'Create', exact: true })).toBeEnabled();
});

test('a GitHub-only project drops local folders and runs anywhere', async ({ page }) => {
  await story(page, 'local-sources');
  await expect(page.getByText('4 selected')).toBeVisible();
  await page.getByRole('button', { name: 'Back', exact: true }).click();
  await page.getByRole('button', { name: 'Back', exact: true }).click();
  await page.getByRole('button', { name: /GitHub repositories only/ }).click();

  await expect(page.getByText('2 selected')).toBeVisible();
  await expect(page.getByRole('tab')).toHaveCount(0);
  await page.getByRole('button', { name: 'Next', exact: true }).click();
  await expect(
    page.getByText('Conversations in this project can run on any machine.')
  ).toBeVisible();
  await page.getByRole('button', { name: 'Remove acme/web' }).click();
  await expect(page.getByText('Includes 1 item')).toBeVisible();
});
