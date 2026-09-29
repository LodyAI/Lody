import { test, expect, type Page } from '@playwright/test';

/**
 * The conversation scroll engine in a real browser (scroll-engine note,
 * verification step 5). The central assertion is observed every
 * animation frame, not only at the end: every sampled line of the viewport's
 * content area has a row under it — the conversation is never blank.
 */

const OPEN = '/iframe.html?id=sessions-conversationview--open-long-conversation&viewMode=story';
const SWITCH =
  '/iframe.html?id=sessions-conversationview--switch-between-long-conversations&viewMode=story';

/** Start recording, every animation frame, how many sampled lines have no row under them. */
async function startBlankSampler(page: Page) {
  await page.evaluate(() => {
    const frames: number[] = [];
    let running = true;
    const sample = () => {
      if (!running) return;
      const viewport = document.querySelector<HTMLElement>('[data-conversation-scroll-engine]');
      const content = viewport?.firstElementChild as HTMLElement | null | undefined;
      if (viewport && content) {
        const view = viewport.getBoundingClientRect();
        const rows = content.getBoundingClientRect();
        const style = getComputedStyle(viewport);
        const top = Math.max(view.top + (parseFloat(style.paddingTop) || 0), rows.top) + 2;
        const bottom =
          Math.min(view.bottom - (parseFloat(style.paddingBottom) || 0), rows.bottom) - 2;
        const x = view.left + view.width / 2;
        let blank = 0;
        for (let y = top; y < bottom; y += 16) {
          const hit = document.elementFromPoint(x, y);
          if (!hit?.closest('[data-virtual-index]')) blank += 1;
        }
        frames.push(blank);
      } else {
        frames.push(-1);
      }
      requestAnimationFrame(sample);
    };
    requestAnimationFrame(sample);
    Object.assign(window, {
      __stopBlankSampler: () => {
        running = false;
        return frames;
      },
    });
  });
}

async function stopBlankSampler(page: Page): Promise<number[]> {
  return page.evaluate(() =>
    (window as unknown as { __stopBlankSampler: () => number[] }).__stopBlankSampler()
  );
}

async function settleFrames(page: Page, frames = 10) {
  await page.evaluate(
    (count) =>
      new Promise<void>((resolve) => {
        let left = count;
        const tick = () => (--left <= 0 ? resolve() : requestAnimationFrame(tick));
        requestAnimationFrame(tick);
      }),
    frames
  );
}

/** The row under the viewport's top content line and its screen offset. */
async function topRow(page: Page) {
  return page.evaluate(() => {
    const viewport = document.querySelector<HTMLElement>('[data-conversation-scroll-engine]')!;
    const view = viewport.getBoundingClientRect();
    const y = view.top + (parseFloat(getComputedStyle(viewport).paddingTop) || 0) + 4;
    const row = document
      .elementFromPoint(view.left + view.width / 2, y)
      ?.closest<HTMLElement>('[data-virtual-index]');
    return row
      ? {
          key: row.dataset.conversationRowKey ?? '',
          top: Math.round(row.getBoundingClientRect().top),
        }
      : null;
  });
}

test('opens a 3,000-turn conversation at its end with no blank frame', async ({ page }) => {
  await page.goto(OPEN);
  await expect(page.getByTestId('view-ready')).toHaveText('view-ready', { timeout: 30_000 });
  await startBlankSampler(page);
  await page.getByTestId('open-conversation').click();
  await expect(page.locator('[data-conversation-scroll-engine]')).toBeVisible();
  await settleFrames(page, 20);
  const frames = (await stopBlankSampler(page)).filter((blank) => blank >= 0);
  expect(frames.length).toBeGreaterThan(0);
  expect(frames.filter((blank) => blank > 0)).toEqual([]);
  // Following: the viewport sits at the real bottom.
  const distance = await page
    .locator('[data-conversation-scroll-engine]')
    .evaluate((element) => element.scrollHeight - element.clientHeight - element.scrollTop);
  expect(distance).toBeLessThanOrEqual(1);
});

test('scrolls through history with the wheel and every frame stays covered', async ({ page }) => {
  await page.goto(OPEN);
  await expect(page.getByTestId('view-ready')).toHaveText('view-ready', { timeout: 30_000 });
  await page.getByTestId('open-conversation').click();
  const viewport = page.locator('[data-conversation-scroll-engine]');
  await expect(viewport).toBeVisible();
  await settleFrames(page);
  await viewport.hover();
  await startBlankSampler(page);
  for (let step = 0; step < 30; step++) {
    await page.mouse.wheel(0, -600);
    await settleFrames(page, 2);
  }
  await settleFrames(page, 10);
  const frames = (await stopBlankSampler(page)).filter((blank) => blank >= 0);
  expect(frames.filter((blank) => blank > 0)).toEqual([]);

  // Position, not only coverage: after each settled step, the row that was
  // under the top line moved down by exactly the wheel's distance — rows
  // hydrating or measured around it (placeholders included) never pull it.
  for (let step = 0; step < 10; step++) {
    const before = await topRow(page);
    expect(before).not.toBeNull();
    await page.mouse.wheel(0, -300);
    await settleFrames(page, 10);
    const top = await page
      .locator(`[data-conversation-row-key="${before!.key}"]`)
      .evaluate((row) => Math.round(row.getBoundingClientRect().top));
    expect(top - before!.top, `step ${step}, row ${before!.key}`).toBe(300);
  }
});

test('switching away and back restores the reading position with no blank frame', async ({
  page,
}) => {
  await page.goto(SWITCH);
  await expect(page.getByTestId('view-ready')).toHaveText('view-ready', { timeout: 60_000 });
  await page.getByTestId('select-conversation-0').click();
  const viewport = page.locator('[data-conversation-scroll-engine]');
  await expect(viewport).toBeVisible();
  await settleFrames(page);
  await viewport.hover();
  for (let step = 0; step < 12; step++) {
    await page.mouse.wheel(0, -700);
    await settleFrames(page, 2);
  }
  await settleFrames(page, 10);
  const before = await topRow(page);
  expect(before).not.toBeNull();

  await startBlankSampler(page);
  await page.getByTestId('select-conversation-1').click();
  await settleFrames(page, 10);
  await page.getByTestId('select-conversation-0').click();
  await settleFrames(page, 20);
  const frames = (await stopBlankSampler(page)).filter((blank) => blank >= 0);
  expect(frames.filter((blank) => blank > 0)).toEqual([]);

  const after = await topRow(page);
  expect(after?.key).toBe(before!.key);
  expect(Math.abs((after?.top ?? 0) - before!.top)).toBeLessThanOrEqual(2);
});

const WINDOWED =
  '/iframe.html?id=sessions-conversationview--extreme-conversation-windowed&viewMode=story';

test('outline jumps land their round at the top, far and near, while rows hydrate', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1400, height: 900 });
  await page.goto(WINDOWED);
  await page.waitForSelector('[data-outline-index]', { timeout: 60_000 });
  await settleFrames(page, 30);
  // Far, then near (the rows around the first target are hydrating), then back.
  for (const round of [400, 410, 1200, 1195, 10, 5]) {
    await page.locator(`[data-outline-index="${round}"]`).evaluate((element) => {
      (element as HTMLElement).click();
    });
    await settleFrames(page, 60);
    const landed = await page.evaluate((index) => {
      const viewport = document.querySelector('[data-message-selection-scroll]')!;
      const row = document.querySelector(`[data-conversation-turn-id="v-user-${index}"]`);
      const active = document.querySelector('[data-outline-index][aria-current]');
      return {
        distance: row
          ? Math.abs(row.getBoundingClientRect().top - viewport.getBoundingClientRect().top)
          : null,
        active: active ? Number(active.getAttribute('data-outline-index')) : null,
      };
    }, round);
    expect(landed, `round ${round}`).toEqual({ distance: expect.any(Number), active: round });
    expect(landed.distance!, `round ${round}`).toBeLessThanOrEqual(1);
  }
});
