import { expect, test, type Page } from '@playwright/test';

test.use({ colorScheme: 'light', reducedMotion: 'no-preference' });

declare global {
  interface Window {
    homeTransition: ViewTransition;
    homeTransitionReady: Promise<void>;
  }
}

async function openLanding(page: Page, width: number) {
  await page.setViewportSize({ width, height: 900 });
  await page.goto('/iframe.html?id=chat-homedashboard--landing&viewMode=story&globals=locale:en');
  await expect(page.getByTestId('home-now')).toBeVisible();
  await page.evaluate(() => {
    const start = document.startViewTransition.bind(document);
    document.startViewTransition = (options) => {
      const transition = start(options);
      window.homeTransition = transition;
      window.homeTransitionReady = transition.ready.then(() => {
        for (const animation of document.getAnimations()) {
          animation.pause();
          animation.currentTime = 0;
        }
      });
      return transition;
    };
  });
}

async function switchTo(page: Page, selector: string) {
  await page.locator(selector).evaluate((element: HTMLElement) => element.click());
  await page.evaluate(() => window.homeTransitionReady);
}

async function finishTransition(page: Page) {
  await page.evaluate(async () => {
    for (const animation of document.getAnimations()) animation.finish();
    await window.homeTransition.finished;
  });
}

/** The switching pictures drift outside their snapshot box; the box must not shear an edge. */
async function expectBoardDriftUnclipped(page: Page, time: number) {
  const overflow = await page.evaluate((sampleTime) => {
    for (const animation of document.getAnimations()) animation.currentTime = sampleTime;
    return getComputedStyle(document.documentElement, '::view-transition-group(home-board)')
      .overflow;
  }, time);
  expect(overflow).toBe('visible');
}

/** Check rendered ink, since DOM visibility alone cannot detect a snapshot hiding text. */
async function expectReadableLabels(page: Page, time: number) {
  const boxes = await page.evaluate((sampleTime) => {
    for (const animation of document.getAnimations()) animation.currentTime = sampleTime;
    return ['now', 'week'].map((board) => {
      const style = getComputedStyle(
        document.documentElement,
        `::view-transition-group(home-${board}-label)`
      );
      const matrix = new DOMMatrix(style.transform);
      return {
        x: matrix.e,
        y: matrix.f,
        width: parseFloat(style.width),
        height: parseFloat(style.height),
      };
    });
  }, time);
  for (const box of boxes) {
    expect(box.width).toBeGreaterThan(10);
    expect(box.height).toBeGreaterThan(5);
  }
  const screenshot = await page.screenshot();
  const ink = await page.evaluate(
    async ({ image, boxes: labelBoxes }) => {
      const bitmap = await createImageBitmap(
        await (await fetch(`data:image/png;base64,${image}`)).blob()
      );
      const canvas = document.createElement('canvas');
      canvas.width = bitmap.width;
      canvas.height = bitmap.height;
      const context = canvas.getContext('2d')!;
      context.drawImage(bitmap, 0, 0);
      bitmap.close();
      return labelBoxes.map((box) => {
        const pixels = context.getImageData(
          Math.floor(box.x),
          Math.floor(box.y),
          Math.ceil(box.width),
          Math.ceil(box.height)
        ).data;
        let dark = 0;
        for (let index = 0; index < pixels.length; index += 4) {
          if (pixels[index]! < 170 && pixels[index + 1]! < 170 && pixels[index + 2]! < 170) dark++;
        }
        return dark;
      });
    },
    { image: screenshot.toString('base64'), boxes }
  );
  for (const count of ink) expect(count).toBeGreaterThan(25);
}

for (const width of [1180, 720]) {
  test(`keeps labels readable and the switch in place at ${width}px`, async ({ page }) => {
    await openLanding(page, width);
    for (const board of ['week', 'now']) {
      const label = page.locator(`[data-segment=${board}] > [style*="home-${board}-label"]`);
      const before = await label.boundingBox();
      await switchTo(page, `[data-segment=${board}]`);
      // Switching boards never moves the switch: the board's slot keeps one height, and both
      // segments keep their summaries, so the next press lands where this one did.
      const after = await label.boundingBox();
      expect(Math.abs(after!.y - before!.y)).toBeLessThan(1);
      expect(Math.abs(after!.x - before!.x)).toBeLessThan(1);
      // At the start of the transition the label occupies the same place.
      const startY = await page.evaluate((targetBoard) => {
        const style = getComputedStyle(
          document.documentElement,
          `::view-transition-group(home-${targetBoard}-label)`
        );
        return new DOMMatrix(style.transform).f;
      }, board);
      expect(startY).toBeCloseTo(before!.y, 0);
      for (const time of [0, 80, 160, 239]) {
        await expectReadableLabels(page, time);
        await expectBoardDriftUnclipped(page, time);
      }
      await finishTransition(page);
      await expect(page.getByTestId(board === 'now' ? 'home-now' : 'home-week')).toBeVisible();
    }
    await switchTo(page, '[data-testid=home-dashboard-fold]');
    for (const time of [0, 120, 239]) await expectReadableLabels(page, time);
    await finishTransition(page);
    await expect(page.getByTestId('home-now')).toHaveCount(0);
    await switchTo(page, '[data-testid=home-dashboard-fold]');
    for (const time of [0, 120, 239]) await expectReadableLabels(page, time);
    await finishTransition(page);
    await expect(page.getByTestId('home-now')).toBeVisible();
  });
}

test('keeps the last selection when a transition is interrupted', async ({ page }) => {
  await openLanding(page, 1180);
  await switchTo(page, '[data-segment=week]');
  await page.evaluate(() => {
    for (const animation of document.getAnimations()) animation.currentTime = 80;
  });
  await switchTo(page, '[data-segment=now]');
  await expectReadableLabels(page, 120);
  await finishTransition(page);
  await expect(page.getByTestId('home-now')).toBeVisible();
  await expect(page.locator('[data-segment=now]')).toHaveAttribute('aria-expanded', 'true');
});

test('switches and folds immediately under reduced motion', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await openLanding(page, 1180);
  await page.locator('[data-segment=week]').click();
  await expect(page.getByTestId('home-week')).toBeVisible();
  await page.getByTestId('home-dashboard-fold').click();
  await expect(page.getByTestId('home-week')).toHaveCount(0);
  expect(await page.evaluate(() => window.homeTransition)).toBeUndefined();
});
