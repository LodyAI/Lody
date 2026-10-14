import { expect, test } from '@playwright/test';

test('HTML attachment dialog defaults to preview and preserves source actions on mobile', async ({
  page,
}, testInfo) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'clipboard', {
      value: {
        writeText: async (text: string) => {
          (window as unknown as { copiedText: string }).copiedText = text;
        },
      },
      configurable: true,
    });
  });
  await page.goto('/iframe.html?id=ai-sessionfilepreviewpanel--html-attachment&viewMode=story');
  const dialog = page.getByRole('dialog');
  const frame = dialog.frameLocator('iframe[title="Preview"]');
  await expect(frame.getByRole('heading', { name: 'HTML 附件预览' })).toBeVisible({
    timeout: 30_000,
  });
  await expect(dialog.locator('iframe')).toHaveAttribute('sandbox', '');
  await frame.getByRole('button', { name: 'Run script' }).click();
  await expect(frame.getByRole('button', { name: 'Run script' })).toBeVisible();
  await frame.getByText('External link').click();
  await expect(frame.getByRole('heading')).toHaveText('HTML 附件预览');
  await expect(dialog.getByRole('button', { name: 'Download', exact: true })).toBeEnabled();
  await dialog.getByRole('button', { name: 'Copy', exact: true }).click();
  const copied = await page.evaluate(
    () => (window as unknown as { copiedText: string }).copiedText
  );
  expect(copied).toContain('<!doctype html>');
  expect(copied).toContain('<script>');
  const rect = await dialog.boundingBox();
  expect(rect!.x).toBeGreaterThanOrEqual(0);
  expect(rect!.x + rect!.width).toBeLessThanOrEqual(391);
  await page.screenshot({ path: testInfo.outputPath('html-attachment-preview.png') });
  await dialog.getByRole('button', { name: 'Hide preview', exact: true }).click();
  await expect(dialog.locator('iframe')).toHaveCount(0);
  await expect(dialog.locator('pre')).toHaveText(copied);
  await dialog.getByRole('button', { name: 'Preview', exact: true }).click();
  await expect(frame.getByRole('heading')).toHaveText('HTML 附件预览');
  await dialog.getByRole('button', { name: 'Close', exact: true }).click();
  await expect(dialog).not.toBeVisible();
  await expect(page.locator('iframe[title="Preview"]')).toHaveCount(0);
});

test('truncated HTML remains source-only with the full-download action', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/iframe.html?id=ai-sessionfilepreviewpanel--truncated-html&viewMode=story');
  const dialog = page.getByRole('dialog');
  await expect(dialog.locator('pre')).toContainText('<!doctype html>', { timeout: 30_000 });
  await expect(dialog.locator('iframe')).toHaveCount(0);
  await expect(dialog.getByRole('button', { name: /preview/i })).toHaveCount(0);
  await expect(
    dialog.getByRole('button', { name: 'Download full file', exact: true })
  ).toBeEnabled();
});

for (const [story, message] of [
  ['loading-html', 'Loading preview…'],
  ['failed-html', 'Could not load preview'],
]) {
  test(`HTML attachment ${story} never offers an empty preview`, async ({ page }) => {
    await page.goto(`/iframe.html?id=ai-sessionfilepreviewpanel--${story}&viewMode=story`);
    const dialog = page.getByRole('dialog');
    await expect(dialog.getByText(message, { exact: true })).toBeVisible({ timeout: 30_000 });
    await expect(dialog.locator('iframe')).toHaveCount(0);
    await expect(dialog.getByRole('button', { name: /^(Hide preview|Preview)$/ })).toHaveCount(0);
    await expect(dialog.getByRole('button', { name: 'Copy', exact: true })).toBeDisabled();
    await expect(
      dialog.getByRole('button', { name: 'Download', exact: true }).first()
    ).toBeEnabled();
  });
}
