import type { Page } from '@playwright/test';

/** Opens Archive through its standalone sidebar footer button. */
export async function openSidebarArchive(page: Page): Promise<void> {
  await page.getByRole('button', { name: /^(Archive|归档)$/u, exact: true }).click();
}
