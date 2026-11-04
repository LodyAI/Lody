import { expect, test } from '@playwright/test';

test('plays an authorized WebM on a narrow mobile surface', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/iframe.html?id=sessions-sessionfilebinarypreview--webm-video&viewMode=story');
  const video = page.getByLabel('Video preview');
  await expect(video).toBeVisible();
  await video.evaluate(async (element: HTMLVideoElement) => {
    await element.play();
    await new Promise<void>((resolve, reject) => {
      if (element.currentTime > 0) return resolve();
      element.addEventListener('timeupdate', () => resolve(), { once: true });
      element.addEventListener('error', () => reject(new Error('WebM decode failed')), {
        once: true,
      });
    });
    element.pause();
  });
  expect(await video.evaluate((element: HTMLVideoElement) => element.currentTime)).toBeGreaterThan(
    0
  );
  expect(await video.evaluate((element: HTMLVideoElement) => element.videoWidth)).toBe(160);
  expect(await video.evaluate((element: HTMLVideoElement) => element.playsInline)).toBe(true);
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)
  ).toBeLessThanOrEqual(1);
  await page.screenshot({ path: testInfo.outputPath('mobile-video-preview.png') });
});

test('keeps file actions when media decoding fails', async ({ page }) => {
  await page.goto(
    '/iframe.html?id=sessions-sessionfilebinarypreview--unsupported-video&viewMode=story'
  );
  await expect(page.getByText('Video unavailable')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Share file…', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Copy file path', exact: true })).toBeVisible();
  await expect(page.locator('video')).toHaveCount(0);
});
