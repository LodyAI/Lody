import type { Page } from '@playwright/test';

/**
 * Opens Archive the way a person does: the sidebar footer keeps Archive behind
 * its More menu, not as a standalone button.
 */
export async function openSidebarArchive(page: Page): Promise<void> {
  await page.getByRole('button', { name: /^(More|更多)$/u, exact: true }).click();
  await page.getByRole('menuitem', { name: /^(Archive|归档)$/u }).click();
}
