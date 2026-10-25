import { test, expect } from '@playwright/test';

test('direct folder selection keeps a draft, deduplicates and explains in-place access', async ({
  page,
}) => {
  await page.goto(
    '/iframe.html?id=settings-projectgroupform--direct-folder-creation&viewMode=story&globals=locale:en'
  );
  const create = page.getByRole('button', { name: 'Create', exact: true });
  await expect(create).toBeDisabled();
  for (const name of ['backend', 'design-notes', 'backend']) {
    await page.getByRole('button', { name: 'Select local folders', exact: true }).click();
    await page.getByRole('button', { name, exact: true }).click();
    await page.getByRole('button', { name: 'Select this folder', exact: true }).click();
    await expect(page.getByRole('dialog')).toHaveCount(0);
  }
  await expect(page.locator('#storybook-root').getByText('backend', { exact: true })).toHaveCount(
    1
  );
  await expect(page.getByText('/Users/demo/Projects/backend', { exact: true })).toBeVisible();
  await expect(page.getByText(/design-notes.*Not a Git repository, edited in place/)).toBeVisible();
  await expect(create).toBeEnabled();
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(create).toBeDisabled();
  await expect(page.getByText('/Users/demo/Projects/backend', { exact: true })).toHaveCount(0);
});
