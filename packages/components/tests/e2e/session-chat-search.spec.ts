import { expect, test } from '@playwright/test';

test.beforeEach(async ({ page }) => {
  await page.route('**/*', (route) => {
    const hostname = new URL(route.request().url()).hostname;
    return ['localhost', '127.0.0.1', '[::1]'].includes(hostname)
      ? route.continue()
      : route.abort();
  });
});

for (const [story, count, nextIndex] of [
  ['literal-underscores', 2, 2],
  ['literal-markdown-cases', 8, 3],
  ['streaming-literal', 2, 1],
] as const) {
  test(`literal search counts and highlights stay aligned: ${story}`, async ({ page }) => {
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.goto(`/iframe.html?id=sessions-sessionchatsearch--${story}&viewMode=story`);
    const search = page.getByRole('searchbox', { name: 'Find in session' });
    const marks = page.locator('mark[data-search-result-id]');
    await expect(marks).toHaveCount(count);
    for (const mark of await marks.all()) await expect(mark).toHaveText('QA_RESUMED_OK');
    await expect(page.getByRole('search')).toContainText(`/ ${count}`);
    await page.getByRole('button', { name: 'Next result', exact: true }).click();
    await expect(page.getByRole('search')).toContainText(`${nextIndex} / ${count}`);
    await search.fill('QA_RESUMED_OK —');
    await expect(page.getByRole('search')).toContainText('1 / 1');
    await expect(marks).toHaveCount(1);
    await expect(marks).toHaveText('QA_RESUMED_OK —');
    await search.fill('QARESUMEDOK');
    await expect(page.getByRole('search')).toContainText('0 / 0');
    await expect(marks).toHaveCount(0);
    await search.fill('QA_RESUMED_OK');
    await expect(marks).toHaveCount(count);
    await search.fill('');
    await expect(marks).toHaveCount(0);
    await expect(page.locator('.markdown-renderer').first()).toContainText('QA_RESUMED_OK —');
    await search.fill('QA_RESUMED_OK');
    await expect(marks).toHaveCount(count);
    await page.getByRole('button', { name: 'Close', exact: true }).click();
    await expect(marks).toHaveCount(0);
    await expect(search).toHaveValue('');
    await page.reload();
    await expect(marks).toHaveCount(count);
    expect(errors).toEqual([]);
  });
}
