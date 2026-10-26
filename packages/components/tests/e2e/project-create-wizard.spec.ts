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
  // Next leads to the last step; it never submits on the click that advanced.
  await expect(page.getByText('Project created')).toHaveCount(0);
  await expect(page.getByText('Edited in place')).toBeVisible();
  await expect(
    page.getByText('Conversations in this project run on wibusdeMacBook-Air-M2.local.')
  ).toBeVisible();
  await page.getByRole('button', { name: 'Create', exact: true }).click();
  await expect(page.getByText('Project created')).toBeVisible();
});

test('a repository may be ticked as a folder and on GitHub, with a notice only', async ({
  page,
}) => {
  await story(page, 'local-sources');
  await page.getByRole('tab', { name: /GitHub repositories/ }).click();
  // The whole list is shown, including repositories with a copy here.
  await expect(page.getByRole('checkbox', { name: 'acme/service-24', exact: true })).toBeVisible();
  const web = page.getByRole('checkbox', { name: 'acme/web', exact: true });
  await expect(web).not.toBeChecked();
  await web.click();
  await expect(page.getByText(/acme\/web is selected both as a folder/)).toBeVisible();
  await expect(page.getByText('4 selected')).toBeVisible();
  const next = page.getByRole('button', { name: 'Next', exact: true });
  await expect(next).toBeEnabled();

  // Unticking the folder keeps the repository, now cloned per conversation.
  await page.getByRole('tab', { name: /Folders on/ }).click();
  await page.getByRole('checkbox', { name: 'web', exact: true }).click();
  await expect(page.getByText(/selected both as a folder/)).toHaveCount(0);
  await expect(page.getByText('4 selected')).toBeVisible();
  await next.click();
  await expect(page.getByRole('button', { name: 'Remove acme/web' })).toBeVisible();
  await expect(page.getByText('Cloned per conversation')).toHaveCount(2);
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
