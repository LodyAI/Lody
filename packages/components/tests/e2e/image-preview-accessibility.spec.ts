import { test, expect } from '@playwright/test';

for (const viewport of [
  { width: 1280, height: 800 },
  { width: 390, height: 844 },
]) {
  test(`image preview is modal and keyboard accessible at ${viewport.width}px`, async ({
    page,
  }) => {
    await page.setViewportSize(viewport);
    await page.goto('/iframe.html?id=shared-zoomableimageviewer--keyboard-gallery&viewMode=story');
    const opener = page.getByRole('button', { name: 'Open viewer', exact: true });
    await opener.click();
    const dialog = page.getByRole('dialog', { name: 'Image preview' });
    const close = dialog.getByRole('button', { name: 'Close image preview' });
    const next = dialog.getByRole('button', { name: 'Next image' });
    const previous = dialog.getByRole('button', { name: 'Previous image' });
    await expect(close).toBeFocused();
    for (const control of [close, previous, next]) {
      expect(await control.evaluate((node) => getComputedStyle(node).backgroundColor)).toBe(
        'rgba(0, 0, 0, 0)'
      );
    }
    await expect(previous).toBeDisabled();
    expect(
      await page
        .getByText('before.png', { exact: true })
        .evaluate((node) => !!node.closest('[inert]'))
    ).toBe(true);
    await page.keyboard.press('Tab');
    await expect(next).toBeFocused();
    await page.keyboard.press('Tab');
    await expect(close).toBeFocused();
    await page.keyboard.press('Shift+Tab');
    await expect(next).toBeFocused();
    await page.keyboard.press('ArrowRight');
    await expect(dialog).toContainText('2 / 3');
    await previous.click();
    await expect(dialog).toContainText('1 / 3');
    await next.focus();
    await page.keyboard.press('Enter');
    await expect(dialog).toContainText('2 / 3');
    await page.keyboard.press('Escape');
    await expect(dialog).toHaveCount(0);
    await expect(opener).toBeFocused();
    expect(await page.locator('[inert]').count()).toBe(0);
    await opener.click();
    await page.getByRole('button', { name: 'Close image preview' }).click();
    await expect(opener).toBeFocused();
    await expect(dialog).toHaveCount(0);
  });
}
