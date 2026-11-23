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

test('plays, pauses, and seeks a video attachment in the right sidebar via custom controls', async ({
  page,
}, testInfo) => {
  await page.setViewportSize({ width: 960, height: 720 });
  await page.goto('/iframe.html?id=ai-sessionfilepreviewpanel--side-panel-video&viewMode=story');

  const video = page.getByLabel('Video preview');
  await expect(video).toBeVisible();
  expect(await video.evaluate((el: HTMLVideoElement) => el.controls)).toBe(false);

  await expect
    .poll(async () => video.evaluate((el: HTMLVideoElement) => el.readyState))
    .toBeGreaterThanOrEqual(1);
  const duration = await video.evaluate((el: HTMLVideoElement) => el.duration);
  expect(duration).toBeGreaterThan(0);

  await page.getByRole('button', { name: 'Play', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Pause', exact: true })).toBeVisible();
  await expect
    .poll(async () => video.evaluate((el: HTMLVideoElement) => el.currentTime))
    .toBeGreaterThan(0);

  await page.getByRole('button', { name: 'Pause', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Play', exact: true })).toBeVisible();
  expect(await video.evaluate((el: HTMLVideoElement) => el.paused)).toBe(true);

  const targetTime = Number((duration * 0.5).toFixed(2));
  const scrubber = page.getByRole('slider', { name: 'Seek', exact: true });
  await expect(scrubber).toBeEnabled();
  await scrubber.fill(String(targetTime));
  await expect
    .poll(async () => video.evaluate((el: HTMLVideoElement) => el.currentTime))
    .toBeGreaterThanOrEqual(targetTime * 0.7);

  await expect(page.getByRole('button', { name: 'Download', exact: true })).toBeVisible();

  const speedButton = page.getByRole('button', { name: 'Playback speed: 1×', exact: true });
  await expect(speedButton).toBeVisible();
  expect(await video.evaluate((el: HTMLVideoElement) => el.playbackRate)).toBe(1);

  await speedButton.click();
  for (const label of ['0.5×', '0.75×', '1×', '1.25×', '1.5×', '2×']) {
    await expect(page.getByRole('menuitemradio', { name: label, exact: true })).toBeVisible();
  }
  await page.getByRole('menuitemradio', { name: '0.5×', exact: true }).click();
  await expect(
    page.getByRole('button', { name: 'Playback speed: 0.5×', exact: true })
  ).toBeVisible();
  expect(await video.evaluate((el: HTMLVideoElement) => el.playbackRate)).toBe(0.5);

  await scrubber.fill('0');
  await page.getByRole('button', { name: 'Play', exact: true }).click();
  await page.waitForTimeout(450);
  await page.getByRole('button', { name: 'Pause', exact: true }).click();
  const slowDelta = await video.evaluate((el: HTMLVideoElement) => el.currentTime);

  await page.getByRole('button', { name: 'Playback speed: 0.5×', exact: true }).click();
  await page.getByRole('menuitemradio', { name: '2×', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Playback speed: 2×', exact: true })).toBeVisible();
  expect(await video.evaluate((el: HTMLVideoElement) => el.playbackRate)).toBe(2);

  await scrubber.fill('0');
  await page.getByRole('button', { name: 'Play', exact: true }).click();
  await page.waitForTimeout(450);
  await page.getByRole('button', { name: 'Pause', exact: true }).click();
  const fastDelta = await video.evaluate((el: HTMLVideoElement) => el.currentTime);

  expect(fastDelta).toBeGreaterThan(slowDelta * 2);

  await scrubber.fill(String(targetTime));
  await expect
    .poll(async () => video.evaluate((el: HTMLVideoElement) => el.currentTime))
    .toBeGreaterThanOrEqual(targetTime * 0.7);

  await page.screenshot({ path: testInfo.outputPath('desktop-sidebar-video-player.png') });
});
