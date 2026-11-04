import { test, expect } from '@playwright/test';

test('only the creator can remove a project from its sidebar menu', async ({ page }) => {
  await page.goto(
    '/iframe.html?id=components-sidebar-folded-group-status--side-by-side&viewMode=story&globals=locale:en'
  );
  await page.getByText('Shop', { exact: true }).first().click({ button: 'right' });
  await expect(page.getByRole('menuitem', { name: 'Remove project' })).toBeVisible();
  await page.keyboard.press('Escape');

  await page.getByText('Docs site', { exact: true }).first().click({ button: 'right' });
  await expect(page.getByRole('menuitem', { name: 'Edit project…' })).toBeVisible();
  await expect(page.getByRole('menuitem', { name: 'Remove project' })).toHaveCount(0);
});
