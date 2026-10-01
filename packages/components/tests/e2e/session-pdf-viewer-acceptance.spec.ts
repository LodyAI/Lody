import { mkdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { expect, test } from '@playwright/test';

const capturePhase = process.env.PDF_VIEWER_CAPTURE_PHASE;
const storyUrl =
  process.env.PDF_VIEWER_STORY_URL ??
  '/iframe.html?id=sessions-sessionfilebinarypreview--pdf-document&viewMode=story';
const artifactDirectory = resolve(process.cwd(), '../../artifacts/pdf-viewer-acceptance');

test.use({
  viewport: { width: 1280, height: 800 },
  video: capturePhase ? { mode: 'on', size: { width: 1280, height: 800 } } : 'off',
});

test('PDF viewer acceptance capture', async ({ page }) => {
  await page.goto(storyUrl);

  if (capturePhase === 'before') {
    await expect(page.getByText('The component failed to render properly')).toBeVisible();
  } else {
    await expect(page.getByRole('region', { name: 'PDF viewer' })).toBeVisible();
    const currentPage = page.getByRole('spinbutton', { name: 'Page number' });
    await expect(currentPage).toHaveValue('1');

    await page.getByRole('button', { name: 'Pages sidebar' }).click();
    await page.getByRole('button', { name: 'Go to page 3' }).click();
    await expect(currentPage).toHaveValue('3');

    const pageView = page.locator('.page[data-page-number="3"]');
    const beforeRotation = await pageView.boundingBox();
    await page.getByRole('button', { name: 'Rotate clockwise' }).click();
    await expect(currentPage).toHaveValue('3');
    await expect
      .poll(async () => (await pageView.boundingBox())?.height ?? 0)
      .toBeLessThan(beforeRotation?.height ?? 0);

    await page.getByRole('combobox', { name: 'Zoom level' }).click();
    await page.getByRole('option', { name: 'Fit page' }).click();
    await expect(page.getByRole('combobox', { name: 'Zoom level' })).toContainText('Fit page');
    await page.getByRole('combobox', { name: 'Zoom level' }).click();
    await page.getByRole('option', { name: '125%' }).click();
    await expect(page.getByRole('combobox', { name: 'Zoom level' })).toContainText('125%');

    await page.getByRole('button', { name: 'Search document' }).click();
    await page.getByRole('searchbox', { name: 'Find in document' }).fill('Revenue');
    await expect(page.getByText('1/1')).toBeVisible();
    await expect(currentPage).toHaveValue('2');
    await expect(page.locator('.textLayer .highlight')).toHaveCount(1);
    await page.getByRole('button', { name: 'Close search' }).click();
    await expect(page.getByRole('searchbox', { name: 'Find in document' })).toHaveCount(0);
    await expect(page.locator('.textLayer .highlight')).toHaveCount(0);
  }

  if (capturePhase) {
    await mkdir(artifactDirectory, { recursive: true });
    await page.screenshot({ path: join(artifactDirectory, `${capturePhase}.png`) });
    const video = page.video();
    await page.close();
    await video?.saveAs(join(artifactDirectory, `${capturePhase}.webm`));
  }
});

test('PDF viewer controls remain usable in a narrow file panel', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/iframe.html?id=sessions-sessionfilebinarypreview--pdf-document&viewMode=story');

  await expect(page.getByRole('region', { name: 'PDF viewer' })).toBeVisible();
  await page.getByRole('button', { name: 'Pages sidebar' }).click();
  await page.getByRole('button', { name: 'Go to page 2' }).click();
  await expect(page.getByRole('spinbutton', { name: 'Page number' })).toHaveValue('2');
  await page.getByRole('button', { name: 'Search document' }).click();
  await expect(page.getByRole('searchbox', { name: 'Find in document' })).toBeVisible();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth
    )
  ).toBeLessThanOrEqual(1);
});
