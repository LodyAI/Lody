import { mkdir, writeFile } from 'node:fs/promises';
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
    await page.getByRole('button', { name: 'More document controls' }).click();
    await page.getByRole('menuitem', { name: 'Rotate clockwise' }).click();
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

test('PDF text selection carries source and comment into the composer handoff', async ({
  page,
}) => {
  await page.goto(
    '/iframe.html?id=sessions-sessionfilebinarypreview--pdf-selection&viewMode=story'
  );
  const text = page
    .locator('.page[data-page-number="1"] .textLayer span')
    .filter({ hasText: 'Quarterly report page 1' });
  await expect(text).toBeVisible();
  const box = await text.boundingBox();
  if (!box) throw new Error('Missing PDF text bounds');
  await page.mouse.move(box.x + 1, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width - 1, box.y + box.height / 2, { steps: 8 });
  await page.mouse.up();
  await expect(page.getByRole('region', { name: 'Selection annotation' })).toContainText('Page 1');
  await page.getByRole('textbox', { name: 'Selection comment' }).fill('Explain this passage');
  await page.getByRole('button', { name: 'Add to chat', exact: true }).click();
  const selection = await page.evaluate(
    () =>
      (
        window as Window & {
          documentSelection?: { path: string; location: string; text: string; comment: string };
        }
      ).documentSelection
  );
  expect(selection).toMatchObject({
    path: '/tmp/annual-report.pdf',
    location: 'Page 1',
    text: 'Quarterly report page 1',
    comment: 'Explain this passage',
  });
});

test('PDF region capture previews source pixels and stages a PNG with its comment', async ({
  page,
}) => {
  await page.goto(
    '/iframe.html?id=sessions-sessionfilebinarypreview--pdf-selection&viewMode=story'
  );
  await expect(page.locator('.page[data-page-number="1"] canvas')).toBeVisible();
  const target = await page.locator('.page[data-page-number="1"]').boundingBox();
  if (!target) throw new Error('Missing PDF page bounds');
  await page.getByRole('button', { name: 'Select screenshot area' }).click();
  await page.mouse.move(target.x + 40, target.y + 40);
  await page.mouse.down();
  await page.mouse.move(target.x + 380, target.y + 240, { steps: 8 });
  await page.mouse.up();
  const previewCanvas = page.getByLabel('Selected screenshot');
  await expect(previewCanvas).toBeVisible({ timeout: 30000 });
  await expect(page.getByRole('group', { name: 'Markup tools' })).toHaveCount(0);
  await page.getByRole('textbox', { name: 'Selection comment' }).fill('Review this layout');
  await page.screenshot({ path: '/tmp/lody-document-selection-pdf.png' });
  await page.getByRole('button', { name: 'Add to chat', exact: true }).click();
  await expect(page.getByRole('region', { name: 'Selection annotation' })).toHaveCount(0);
  const image = await page.evaluate(async () => {
    const selection = (
      window as Window & { documentSelection?: { location: string; comment: string; image: File } }
    ).documentSelection!;
    const bitmap = await createImageBitmap(selection.image),
      canvas = document.createElement('canvas');
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    const context = canvas.getContext('2d')!;
    context.drawImage(bitmap, 0, 0);
    bitmap.close();
    const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
    return {
      location: selection.location,
      comment: selection.comment,
      type: selection.image.type,
      width: canvas.width,
      height: canvas.height,
      hasContent: pixels.some((value, index) => index % 4 !== 3 && value < 100),
      hasMarkup: pixels.some(
        (value, index) =>
          index % 4 === 0 && value > 190 && pixels[index + 1] < 70 && pixels[index + 2] < 70
      ),
    };
  });
  expect(image).toMatchObject({
    location: 'Page 1',
    comment: 'Review this layout',
    type: 'image/png',
    width: 340,
    height: 200,
    hasContent: true,
    hasMarkup: false,
  });
});

test('existing screenshot attachments can be marked up without capturing the desktop', async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(
    '/iframe.html?id=sessions-sessionfilebinarypreview--attached-image-markup&viewMode=story'
  );
  await expect(page.getByRole('dialog', { name: 'Mark up image' })).toBeVisible();
  const canvas = page.getByLabel('Draw on selected screenshot');
  await expect(canvas).toBeVisible();
  const original = await canvas.evaluate((element) => (element as HTMLCanvasElement).toDataURL());
  const box = await canvas.boundingBox();
  if (!box) throw new Error('Missing image canvas');
  await page.getByRole('button', { name: 'Arrow', exact: true }).click();
  await page.mouse.move(box.x + 20, box.y + 20);
  await page.mouse.down();
  await page.mouse.move(box.x + 100, box.y + 70, { steps: 6 });
  await page.mouse.up();
  expect(await canvas.evaluate((element) => (element as HTMLCanvasElement).toDataURL())).not.toBe(
    original
  );
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  expect(await canvas.evaluate((element) => (element as HTMLCanvasElement).toDataURL())).toBe(
    original
  );
  await page.getByRole('button', { name: 'Rectangle', exact: true }).click();
  await page.mouse.move(box.x + 40, box.y + 50);
  await page.mouse.down();
  await page.mouse.move(box.x + 260, box.y + 110, { steps: 6 });
  await page.mouse.up();
  await page.getByRole('textbox', { name: 'Annotation note' }).fill('Change the blue header');
  await page.getByRole('button', { name: 'Pen', exact: true }).click();
  await page.mouse.move(box.x + 40, box.y + 40);
  await page.mouse.down();
  await page.mouse.move(box.x + 150, box.y + 80, { steps: 8 });
  await page.mouse.up();
  await page.getByRole('button', { name: 'Done', exact: true }).click();
  await expect(page.getByRole('dialog', { name: 'Mark up image' })).toHaveCount(0);
  expect(
    await page.evaluate(async () => {
      const selection = (
        window as Window & { documentSelection?: { image: File; comment: string } }
      ).documentSelection!;
      const image = await createImageBitmap(selection.image);
      const size = { width: image.width, height: image.height };
      image.close();
      return { comment: selection.comment, type: selection.image.type, ...size };
    })
  ).toEqual({ comment: 'Change the blue header', type: 'image/png', width: 800, height: 400 });
});

for (const width of [390, 1280]) {
  test(`image markup uses a full-window lightbox at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 844 });
    await page.goto(
      '/iframe.html?id=sessions-sessionfilebinarypreview--attached-image-markup&viewMode=story'
    );
    const lightbox = page.getByRole('dialog', { name: 'Mark up image' });
    const canvas = lightbox.getByLabel('Draw on selected screenshot');
    await expect(canvas).toBeVisible();
    const box = await lightbox.boundingBox();
    expect(box).toEqual({ x: 0, y: 0, width, height: 844 });
    const controls = lightbox.getByRole('group', { name: 'Markup tools' });
    const toolsBox = await controls.boundingBox();
    expect(toolsBox).not.toBeNull();
    expect(toolsBox!.x).toBeGreaterThanOrEqual(0);
    expect(toolsBox!.x + toolsBox!.width).toBeLessThanOrEqual(width);
    await page.keyboard.press('Tab');
    await expect(lightbox.locator(':focus')).toHaveCount(1);
    await lightbox.getByRole('button', { name: 'Cancel' }).focus();
    await page.keyboard.press('Escape');
    await expect(lightbox).toHaveCount(0);
  });
}

for (const { width, theme, locale } of [
  { width: 390, theme: 'light', locale: 'en' },
  { width: 480, theme: 'dark', locale: 'zh_CN' },
  { width: 960, theme: 'light', locale: 'en' },
]) {
  test(`PDF selection toolbar fits one reading row at ${width}px in ${locale} ${theme}`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 844 });
    await page.goto(
      `/iframe.html?id=sessions-sessionfilebinarypreview--pdf-selection&viewMode=story&globals=theme:${theme};locale:${locale}`
    );
    await expect(page.locator('.page[data-page-number="1"] canvas')).toBeVisible();
    const toolbar = page.locator('[data-document-toolbar]');
    await expect(toolbar).toHaveCount(1);
    const dimensions = await toolbar.evaluate((element) => {
      const box = element.getBoundingClientRect();
      const controls = Array.from(element.querySelectorAll('button, input'))
        .filter(
          (control) =>
            control.getAttribute('aria-hidden') !== 'true' &&
            control.getAttribute('type') !== 'hidden'
        )
        .map((control) => control.getBoundingClientRect())
        .filter((rect) => rect.width && rect.height);
      return {
        height: box.height,
        within: controls.every(
          (rect) =>
            rect.left >= box.left &&
            rect.right <= box.right &&
            rect.top >= box.top &&
            rect.bottom <= box.bottom
        ),
      };
    });
    await page.screenshot({ path: `/tmp/lody-selection-redesign-toolbar-${width}.png` });
    expect(dimensions.height).toBeLessThanOrEqual(40);
    expect(dimensions.within).toBe(true);
    await expect(page.locator('[data-document-capture]')).toBeVisible();
    await expect(page.locator('[data-document-capture]')).toHaveText('');
  });
}

test('selected-text feedback retains its highlighted source and typed draft while scrolling', async ({
  page,
}) => {
  await page.setViewportSize({ width: 600, height: 844 });
  await page.goto(
    '/iframe.html?id=sessions-sessionfilebinarypreview--pdf-selection&viewMode=story'
  );
  const text = page
    .locator('.page[data-page-number="1"] .textLayer span')
    .filter({ hasText: 'Quarterly report page 1' });
  await expect(text).toBeVisible();
  const box = await text.boundingBox();
  if (!box) throw new Error('Missing selected text');
  await page.mouse.move(box.x + 1, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width - 1, box.y + box.height / 2, { steps: 8 });
  await page.mouse.up();
  const editor = page.getByRole('region', { name: 'Selection annotation' });
  await expect(editor).toBeVisible();
  const popup = await editor.boundingBox();
  expect(popup!.width).toBeLessThanOrEqual(340);
  expect(popup!.y).toBeGreaterThanOrEqual(box.y + box.height);
  await page.keyboard.press('ControlOrMeta+i');
  const comment = page.getByRole('textbox', { name: 'Selection comment' });
  await expect(comment).toBeFocused();
  await comment.fill('Keep this note while reading');
  await expect(page.locator('[data-document-selection-highlight]').first()).toBeVisible();
  await page.screenshot({ path: '/tmp/lody-selection-redesign-text.png' });
  await page.locator('.page[data-page-number="2"]').scrollIntoViewIfNeeded();
  await expect(editor).toBeHidden();
  await page.locator('.page[data-page-number="1"]').scrollIntoViewIfNeeded();
  await expect(editor).toBeVisible();
  await expect(comment).toHaveValue('Keep this note while reading');
  await comment.press('ControlOrMeta+Enter');
  await expect(editor).toHaveCount(0);
  expect(
    await page.evaluate(
      () =>
        (window as Window & { documentSelection?: { comment: string } }).documentSelection?.comment
    )
  ).toBe('Keep this note while reading');
});

test.describe('high-density document regions', () => {
  test.use({ deviceScaleFactor: 2 });

  test('retains the source PDF pixels, crop edges and CSS preview size', async ({
    page,
  }, testInfo) => {
    await page.goto(
      '/iframe.html?id=sessions-sessionfilebinarypreview--pdf-selection&viewMode=story'
    );
    const source = page.locator('.page[data-page-number="1"] canvas').first();
    await expect(
      page
        .locator('.page[data-page-number="1"] .textLayer span')
        .filter({ hasText: 'Quarterly report page 1' })
    ).toBeVisible();
    await expect(source).toBeVisible();
    const box = await source.boundingBox();
    if (!box) throw new Error('Missing PDF bitmap');
    const region = { x: box.x + 40, y: box.y + 40, width: 340, height: 200 };
    const expected = await source.evaluate((element, crop) => {
      const bitmap = element as HTMLCanvasElement;
      const bounds = bitmap.getBoundingClientRect();
      const result = document.createElement('canvas');
      result.width = crop.width * devicePixelRatio;
      result.height = crop.height * devicePixelRatio;
      result
        .getContext('2d')!
        .drawImage(
          bitmap,
          ((crop.x - bounds.left) * bitmap.width) / bounds.width,
          ((crop.y - bounds.top) * bitmap.height) / bounds.height,
          (crop.width * bitmap.width) / bounds.width,
          (crop.height * bitmap.height) / bounds.height,
          0,
          0,
          result.width,
          result.height
        );
      return result.toDataURL();
    }, region);
    await page.getByRole('button', { name: 'Select screenshot area' }).click();
    await page.mouse.move(region.x, region.y);
    await page.mouse.down();
    await page.mouse.move(region.x + region.width, region.y + region.height, { steps: 8 });
    await page.mouse.up();
    const preview = page.getByLabel('Selected screenshot');
    await expect(preview).toBeVisible();
    await writeFile(
      testInfo.outputPath('crop-reference.png'),
      Buffer.from(expected.split(',')[1], 'base64')
    );
    const actualUrl = await preview.evaluate((element) =>
      (element as HTMLCanvasElement).toDataURL()
    );
    await writeFile(
      testInfo.outputPath('crop-actual.png'),
      Buffer.from(actualUrl.split(',')[1], 'base64')
    );
    await page.screenshot({ path: testInfo.outputPath('pdf-selection-retina.png') });
    const comparison = await preview.evaluate(async (element, expectedUrl) => {
      const actual = element as HTMLCanvasElement;
      const expectedImage = new Image();
      expectedImage.src = expectedUrl;
      await expectedImage.decode();
      const reference = document.createElement('canvas');
      reference.width = expectedImage.naturalWidth;
      reference.height = expectedImage.naturalHeight;
      reference.getContext('2d')!.drawImage(expectedImage, 0, 0);
      if (actual.width !== reference.width || actual.height !== reference.height)
        return { width: actual.width, height: actual.height, error: null };
      const pixels = actual.getContext('2d')!.getImageData(0, 0, actual.width, actual.height).data;
      const original = reference
        .getContext('2d')!
        .getImageData(0, 0, reference.width, reference.height).data;
      let total = 0;
      for (let index = 0; index < pixels.length; index++)
        total += Math.abs(pixels[index] - original[index]);
      return { width: actual.width, height: actual.height, error: total / pixels.length };
    }, expected);
    expect(comparison.width).toBe(680);
    expect(comparison.height).toBe(400);
    expect(comparison.error).not.toBeNull();
    expect(comparison.error!).toBeLessThan(1);
    const displayed = await preview.boundingBox();
    expect(displayed!.width).toBe(340);
    expect(displayed!.height).toBe(200);
    await page.getByRole('button', { name: 'Add to chat', exact: true }).click();
    await expect(page.getByRole('region', { name: 'Selection annotation' })).toHaveCount(0);
    const dimensions = await page.evaluate(async () => {
      const file = (window as Window & { documentSelection?: { image: File } }).documentSelection!
        .image;
      const bitmap = await createImageBitmap(file);
      const size = { width: bitmap.width, height: bitmap.height };
      bitmap.close();
      return size;
    });
    expect(dimensions).toEqual({ width: 680, height: 400 });
  });
  test('keeps page pixels aligned when a region crosses a PDF page boundary', async ({ page }) => {
    await page.goto(
      '/iframe.html?id=sessions-sessionfilebinarypreview--pdf-selection&viewMode=story'
    );
    await expect(
      page.locator('.page[data-page-number="1"] .textLayer span').filter({ hasText: 'Overview' })
    ).toBeVisible();
    await page.getByRole('combobox', { name: 'Zoom level' }).click();
    await page.getByRole('option', { name: '25%', exact: true }).click();
    await expect(
      page.locator('.page[data-page-number="2"] .textLayer span').filter({ hasText: 'Revenue' })
    ).toBeVisible();
    const first = await page.locator('.page[data-page-number="1"] canvas').first().boundingBox();
    if (!first) throw new Error('Missing PDF bitmap');
    const crop = {
      x: Math.ceil(first.x + 20),
      y: Math.ceil(first.y + first.height - 80),
      width: 160,
      height: 200,
    };
    const expected = await page.locator('.pdfViewer').evaluate((element, region) => {
      const canvas = document.createElement('canvas');
      canvas.width = region.width * devicePixelRatio;
      canvas.height = region.height * devicePixelRatio;
      const context = canvas.getContext('2d')!;
      for (const bitmap of element.querySelectorAll<HTMLCanvasElement>('.page canvas')) {
        const box = bitmap.getBoundingClientRect();
        const x = Math.max(box.left, region.x),
          y = Math.max(box.top, region.y);
        const right = Math.min(box.right, region.x + region.width),
          bottom = Math.min(box.bottom, region.y + region.height);
        if (right <= x || bottom <= y) continue;
        context.drawImage(
          bitmap,
          ((x - box.left) * bitmap.width) / box.width,
          ((y - box.top) * bitmap.height) / box.height,
          ((right - x) * bitmap.width) / box.width,
          ((bottom - y) * bitmap.height) / box.height,
          (x - region.x) * devicePixelRatio,
          (y - region.y) * devicePixelRatio,
          (right - x) * devicePixelRatio,
          (bottom - y) * devicePixelRatio
        );
      }
      return canvas.toDataURL();
    }, crop);
    await page.getByRole('button', { name: 'Select screenshot area' }).click();
    await page.mouse.move(crop.x, crop.y);
    await page.mouse.down();
    await page.mouse.move(crop.x + crop.width, crop.y + crop.height, { steps: 8 });
    await page.mouse.up();
    const preview = page.getByLabel('Selected screenshot');
    await expect(preview).toBeVisible();
    const error = await preview.evaluate(async (element, referenceUrl) => {
      const actual = element as HTMLCanvasElement;
      const image = new Image();
      image.src = referenceUrl;
      await image.decode();
      const reference = document.createElement('canvas');
      reference.width = image.naturalWidth;
      reference.height = image.naturalHeight;
      reference.getContext('2d')!.drawImage(image, 0, 0);
      const original = reference
        .getContext('2d')!
        .getImageData(0, 0, reference.width, reference.height).data;
      const pixels = actual.getContext('2d')!.getImageData(0, 0, actual.width, actual.height).data;
      let total = 0,
        count = 0;
      for (let index = 0; index < original.length; index += 4) {
        if (original[index + 3] < 255) continue;
        for (let channel = 0; channel < 4; channel++)
          total += Math.abs(original[index + channel] - pixels[index + channel]);
        count += 4;
      }
      return {
        error: total / count,
        count,
        width: actual.width,
        height: actual.height,
        referenceWidth: reference.width,
        referenceHeight: reference.height,
      };
    }, expected);
    expect(error.count).toBeGreaterThan(0);
    expect(error.width).toBe(error.referenceWidth);
    expect(error.height).toBe(error.referenceHeight);
    expect(error.error).toBeLessThan(1);
  });

  test('bounds high-density output without rejecting an otherwise valid selection', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1600, height: 1600 });
    await page.goto(
      '/iframe.html?id=sessions-sessionfilebinarypreview--pdf-selection&viewMode=story'
    );
    const result = await page.evaluate(async () => {
      const modulePath = '/src/lib/document-selection.ts';
      const { captureDocumentRegion, MAX_SELECTION_PIXELS } = await import(
        /* @vite-ignore */ modulePath
      );
      const root = document.createElement('div');
      root.style.cssText =
        'position:absolute;left:0;top:0;width:1500px;height:1500px;background:white';
      document.body.appendChild(root);
      try {
        const image = await captureDocumentRegion(
          root,
          { x: 0, y: 0, width: 1500, height: 1500 },
          new AbortController().signal
        );
        return {
          width: image.width,
          height: image.height,
          logicalWidth: image.style.width,
          pixels: image.width * image.height,
          limit: MAX_SELECTION_PIXELS,
        };
      } finally {
        root.remove();
      }
    });
    expect(result.pixels).toBeLessThanOrEqual(result.limit);
    expect(result.pixels).toBeGreaterThan(result.limit * 0.99);
    expect(result.logicalWidth).toBe('1500px');
  });
});
