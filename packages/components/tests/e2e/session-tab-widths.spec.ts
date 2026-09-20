import { expect, test, type Page } from '@playwright/test';

const items = '[data-adaptive-tab-strip-item]';
const frame = '[data-testid="session-tab-bar-story-frame"]';

async function geometry(page: Page) {
  return page.locator(items).evaluateAll((elements) =>
    elements.map((element) => {
      const rect = element.getBoundingClientRect();
      return {
        id: element.getAttribute('data-adaptive-tab-strip-item'),
        width: rect.width,
        left: rect.left,
        right: rect.right,
      };
    })
  );
}

async function settle(page: Page) {
  await page.locator('[data-adaptive-tab-strip]').evaluate(async (element) => {
    await new Promise<void>((resolve) =>
      requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
    );
    await Promise.all(
      element
        .getAnimations({ subtree: true })
        .map((animation) => animation.finished.catch(() => {}))
    );
  });
}

test('renders active minimum and one gap, and follows every resize frame', async ({ page }) => {
  await page.goto(
    '/iframe.html?id=sessions-sessiontabbar--equal-at-minimum-threshold&viewMode=story'
  );
  await expect(page.locator(items)).toHaveCount(3);
  for (const width of [394, 592, 900]) {
    await page.locator(frame).evaluate((element, nextWidth) => {
      (element as HTMLElement).style.width = `${nextWidth}px`;
    }, width);
    const boxes = await geometry(page);
    for (let i = 1; i < boxes.length; i++)
      expect(boxes[i].left - boxes[i - 1].right).toBeCloseTo(6, 1);
    const active = page.locator(`${items}:has([aria-selected="true"])`);
    expect((await active.boundingBox())!.width).toBeGreaterThanOrEqual(180);
  }
  // A paused animation makes each sampled layout deterministic, independent of
  // machine speed. Width updates must be visible in the same style calculation.
  const gaps = await page.locator(frame).evaluate((element) => {
    const animation = element.animate([{ width: '592px' }, { width: '900px' }], {
      duration: 220,
      fill: 'both',
    });
    animation.pause();
    const sampledGaps = [0, 55, 110, 165, 220].map((time) => {
      animation.currentTime = time;
      const viewport = element.querySelector('[data-adaptive-tab-strip-viewport]')!;
      const tabs = element.querySelectorAll('[data-adaptive-tab-strip-item]');
      return (
        viewport.getBoundingClientRect().right - tabs[tabs.length - 1].getBoundingClientRect().right
      );
    });
    animation.cancel();
    return sampledGaps;
  });
  for (const gap of gaps) expect(gap).toBeCloseTo(8, 1);
});

test('keeps real pointer closes frozen until the pointer leaves', async ({ page }) => {
  await page.goto('/iframe.html?id=sessions-sessiontabbar--rapid-close&viewMode=story');
  await expect(page.locator(items)).toHaveCount(8);
  const before = await geometry(page);
  for (const count of [7, 6]) {
    await page.locator('[role="tab"][aria-selected="true"] button').click();
    await expect(page.locator(items)).toHaveCount(count);
    await settle(page);
    const after = await geometry(page);
    expect(after[0].width).toBeCloseTo(before[0].width, 1);
    expect(after[1].width).toBeCloseTo(before[1].width, 1);
    for (let i = 1; i < after.length; i++)
      expect(after[i].left - after[i - 1].right).toBeCloseTo(6, 1);
  }
  await page.mouse.move(10, 400);
  await settle(page);
  expect((await geometry(page))[0].width).toBeGreaterThan(before[0].width);
});

test('initial multiple tabs paint at their final widths without width animation', async ({
  page,
}) => {
  await page.addInitScript(() => {
    const samples: number[][] = [];
    Object.assign(window, { tabMountSamples: samples });
    new MutationObserver(() => {
      const tabs = [...document.querySelectorAll<HTMLElement>('[data-adaptive-tab-strip-item]')];
      if (tabs.length !== 8) return;
      samples.push(tabs.map((tab) => tab.getBoundingClientRect().width));
    }).observe(document, { childList: true, subtree: true });
  });
  await page.goto(
    '/iframe.html?id=sessions-sessiontabbar--rapid-close&viewMode=story&args=activeTabSessionId:session-parent'
  );
  await expect(page.locator(items)).toHaveCount(8);
  await expect(page.locator('[role="tab"]').first()).toHaveAttribute('aria-selected', 'true');
  const widths = (await geometry(page)).map((box) => box.width);
  const samples = await page.evaluate(
    () => (window as unknown as { tabMountSamples: number[][] }).tabMountSamples
  );
  expect(samples.length).toBeGreaterThan(0);
  for (const sample of samples)
    sample.forEach((width, index) => expect(width).toBeCloseTo(widths[index], 1));
  const transitions = await page
    .locator(items)
    .evaluateAll(
      (tabs) =>
        tabs
          .flatMap((tab) => tab.getAnimations())
          .filter(
            (animation) =>
              animation instanceof CSSTransition && animation.transitionProperty === 'width'
          ).length
    );
  expect(transitions).toBe(0);
});
