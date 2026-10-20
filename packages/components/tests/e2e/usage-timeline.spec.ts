import { expect, test, type Page } from '@playwright/test';

test.use({ colorScheme: 'light', reducedMotion: 'no-preference' });
test.setTimeout(60_000);

type ViewBox = { x: number; y: number; width: number; height: number };

async function openUsage(page: Page, width: number) {
  await page.setViewportSize({ width, height: 1300 });
  await page.goto(
    '/iframe.html?id=settings-statssettings--default&viewMode=story&globals=locale:en'
  );
  await expect(page.locator('[data-usage-view="hourly"] [role="gridcell"]')).toHaveCount(24);
  await page.evaluate(() => document.fonts.ready);
}

/** Observe the commit that pops the old view, before the exit animation can remove it. */
async function switchRange(page: Page, rangeIndex: number) {
  return page.evaluate((index) => {
    const frame = document.querySelector('[data-usage-view-frame]')!;
    const leaving = frame.querySelector<HTMLElement>('[data-usage-view]')!;
    const measure = (): ViewBox => {
      const box = leaving.getBoundingClientRect();
      const origin = frame.getBoundingClientRect();
      return { x: box.x - origin.x, y: box.y - origin.y, width: box.width, height: box.height };
    };
    const before = measure();
    return new Promise<{
      before: ViewBox;
      after: ViewBox;
      cellAnimations: number;
    }>((resolve) => {
      const observer = new MutationObserver(() => {
        if (getComputedStyle(leaving).position !== 'absolute') return;
        observer.disconnect();
        const cells = frame.querySelectorAll('[data-usage-view="skyline"] [role="gridcell"]');
        resolve({
          before,
          after: measure(),
          cellAnimations: [...cells].reduce((sum, cell) => sum + cell.getAnimations().length, 0),
        });
      });
      observer.observe(frame, { attributes: true, childList: true, subtree: true });
      const tabs = document
        .querySelector('[role="tablist"]')!
        .querySelectorAll<HTMLButtonElement>('button');
      tabs[index]!.click();
    });
  }, rangeIndex);
}

for (const width of [1180, 390]) {
  test(`keeps exiting charts anchored inside their view frame at ${width}px`, async ({ page }) => {
    await openUsage(page, width);
    for (const range of [3, 0]) {
      const { before, after } = await switchRange(page, range);
      expect(Math.abs(after.x - before.x)).toBeLessThanOrEqual(1);
      expect(Math.abs(after.y - before.y)).toBeLessThanOrEqual(1);
      expect(after.width).toBeCloseTo(before.width, 0);
      const exiting = range === 3 ? 'hourly' : 'skyline';
      await expect(page.locator(`[data-usage-view="${exiting}"]`)).toHaveCount(0);
    }
  });
}

test('reveals the full-year calendar without starting a separate animation for each day', async ({
  page,
}) => {
  await openUsage(page, 1180);
  const { cellAnimations } = await switchRange(page, 3);
  expect(cellAnimations).toBe(0);
});

test('switches to the calendar with reduced motion', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await openUsage(page, 390);
  await page.getByRole('tablist').first().getByRole('tab').nth(3).click();
  await expect(page.locator('[data-usage-view="hourly"]')).toHaveCount(0);
  await expect(page.locator('[data-usage-view="skyline"] [role="gridcell"]')).toHaveCount(371);
});
