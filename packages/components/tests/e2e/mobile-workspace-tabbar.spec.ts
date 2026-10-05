import { expect, test, type Page } from '@playwright/test';

test.use({ viewport: { width: 393, height: 852 } });

async function open(page: Page, story = 'scroll-collapsing') {
  await page.clock.install({ time: new Date('2026-01-01T00:00:00Z') });
  await page.goto(`/iframe.html?id=mobile-mobileworkspacetabbar--${story}&viewMode=story`);
  await expect(page.getByRole('tablist')).toBeVisible();
  await page.clock.pauseAt(new Date('2026-01-01T01:00:00Z'));
}

async function scroll(page: Page, top: number) {
  // Distinct input events get distinct timestamps, including when motion jumps.
  await page.clock.runFor(1);
  await page.getByTestId('dock-scroll').evaluate((element, value) => {
    element.scrollTop = value;
    element.dispatchEvent(new Event('scroll'));
  }, top);
}

async function sample(page: Page) {
  return page.getByRole('tablist').evaluate((shell) => {
    const tab = shell.querySelector('[aria-selected="true"]')!;
    const svg = tab.querySelector('svg')!;
    const box = svg.getBoundingClientRect();
    const shellBox = shell.getBoundingClientRect();
    const slotBox = shell.parentElement!.getBoundingClientRect();
    let opacity = 1;
    for (let node: Element | null = svg; node; node = node.parentElement) {
      opacity *= Number(getComputedStyle(node).opacity);
    }
    return {
      width: box.width,
      height: box.height,
      x: box.x,
      opacity,
      left: shellBox.left,
      right: shellBox.right,
      shellWidth: shellBox.width,
      shellHeight: shellBox.height,
      slotWidth: slotBox.width,
      sameNode: svg === (window as unknown as { dockIcon: Element }).dockIcon,
      icons: tab.querySelectorAll('svg').length,
    };
  });
}

async function rememberIcon(page: Page) {
  await page.locator('[aria-selected="true"] svg').evaluate((svg) => {
    (window as unknown as { dockIcon: Element }).dockIcon = svg;
  });
}

function assertIcon(frame: Awaited<ReturnType<typeof sample>>) {
  expect(frame.sameNode).toBe(true);
  expect(frame.icons).toBe(1);
  expect(frame.width).toBeCloseTo(24, 3);
  expect(frame.height).toBeCloseTo(24, 3);
  expect(frame.opacity).toBe(1);
  expect(frame.x).toBeGreaterThanOrEqual(frame.left);
  expect(frame.x + frame.width).toBeLessThanOrEqual(frame.right + 0.01);
}

for (const [story, activeIndex] of [
  ['scroll-collapsing', 0],
  ['signal-scrolling', 1],
  ['scroll-material', 2],
] as const) {
  test(`${story}: tab ${activeIndex} keeps its SVG through collapse and interrupted reversal`, async ({
    page,
  }) => {
    await open(page, story);
    await page.getByRole('tab').nth(activeIndex).click();
    await rememberIcon(page);
    const initial = await sample(page);
    await scroll(page, 180);
    await expect(page.getByRole('tab', { selected: true })).toHaveAttribute(
      'aria-label',
      '展开导航'
    );
    const frames = [];
    for (let step = 0; step < 50; step++) {
      // Retarget the same animation twice before it settles, away from top.
      if (step === 5) {
        await scroll(page, 150);
        await expect(page.locator('[aria-selected="true"]')).not.toHaveAttribute(
          'aria-label',
          '展开导航'
        );
      }
      if (step === 10) {
        await scroll(page, 180);
        await expect(page.getByRole('tab', { selected: true })).toHaveAttribute(
          'aria-label',
          '展开导航'
        );
      }
      await page.clock.runFor(16);
      const frame = await sample(page);
      assertIcon(frame);
      expect(frame.slotWidth).toBe(initial.slotWidth);
      frames.push(frame);
    }
    expect(
      frames.some((frame) => frame.shellWidth > 48 && frame.shellWidth < initial.shellWidth)
    ).toBe(true);
    expect(frames.at(-1)!.shellWidth).toBeCloseTo(48, 1);
    // No single-frame teleport, including either retarget; sampled at a fixed clock step.
    for (let index = 1; index < frames.length; index++) {
      expect(Math.abs(frames[index].x - frames[index - 1].x)).toBeLessThan(30);
    }
    await scroll(page, 150);
    await expect(page.locator('[aria-selected="true"]')).not.toHaveAttribute(
      'aria-label',
      '展开导航'
    );
    await page.clock.runFor(1000);
    assertIcon(await sample(page));
    expect((await sample(page)).shellWidth).toBeCloseTo(initial.shellWidth, 1);
  });
}

test('direction changes reset hysteresis; hidden controls cannot take focus; tap expands in place', async ({
  page,
}) => {
  await open(page);
  const tabs = page.locator('[role="tab"]');
  await tabs.nth(1).focus();
  await scroll(page, 10);
  await scroll(page, 6);
  await scroll(page, 15);
  await expect(tabs.first()).toHaveAttribute('aria-label', 'Local');
  await scroll(page, 20);
  await expect(tabs.first()).toHaveAttribute('aria-label', '展开导航');
  await expect(tabs.first()).toBeFocused();
  await page.clock.runFor(1000);
  await expect(tabs.nth(1)).toHaveAttribute('inert', '');
  await tabs.nth(1).evaluate((element) => element.focus());
  await expect(tabs.first()).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(page.getByRole('button', { name: '新建对话' })).toBeFocused();
  await tabs.first().click();
  await expect(tabs.first()).toHaveAttribute('aria-label', 'Local');
  await expect(page.getByTestId('dock-scroll')).toHaveJSProperty('scrollTop', 20);
  // Expansion does not expose still-invisible tabs to keyboard or pointer input.
  await expect(tabs.nth(1)).toHaveAttribute('inert', '');
  await page.clock.runFor(1000);
  await expect(tabs.nth(1)).not.toHaveAttribute('inert');
  await scroll(page, 21);
  await expect(tabs.first()).toHaveAttribute('aria-label', 'Local');
  await scroll(page, 40);
  await expect(tabs.first()).toHaveAttribute('aria-label', '展开导航');
  await scroll(page, 4);
  await expect(tabs.first()).toHaveAttribute('aria-label', 'Local');
});

for (const story of ['scroll-collapsing', 'scroll-without-new-chat']) {
  test(`${story}: resize uses the stable slot with reduced motion`, async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await open(page, story);
    await rememberIcon(page);
    await scroll(page, 180);
    await expect(page.getByRole('tab', { selected: true })).toHaveAttribute(
      'aria-label',
      '展开导航'
    );
    await page.clock.runFor(32);
    assertIcon(await sample(page));
    expect((await sample(page)).shellWidth).toBe(48);
    // ResizeObserver runs on the browser's layout clock, not Playwright's JS
    // timer clock. Wait for its actual delivery rather than guessing a delay.
    const expectedWidth = story === 'scroll-collapsing' ? 330 : 398;
    await page.getByRole('tablist').evaluate((shell, expected) => {
      (window as unknown as { dockResize: Promise<void> }).dockResize = new Promise((resolve) => {
        const observer = new ResizeObserver(([entry]) => {
          if (entry.contentRect.width === expected) {
            observer.disconnect();
            resolve();
          }
        });
        observer.observe(shell.parentElement!);
      });
    }, expectedWidth);
    await page.setViewportSize({ width: 430, height: 852 });
    await page.evaluate(() => (window as unknown as { dockResize: Promise<void> }).dockResize);
    await page.clock.runFor(32);
    await scroll(page, 150);
    await expect(page.locator('[aria-selected="true"]')).not.toHaveAttribute(
      'aria-label',
      '展开导航'
    );
    await page.clock.runFor(32);
    const frame = await sample(page);
    assertIcon(frame);
    expect(frame.shellWidth).toBe(frame.slotWidth);
    expect(frame.shellWidth).toBe(story === 'scroll-collapsing' ? 330 : 398);
    expect(frame.shellHeight).toBe(56);
    await expect(page.getByRole('tab')).toHaveCount(story === 'scroll-collapsing' ? 3 : 2);
  });
}

test('a missing selection stays reachable, and selecting a tab can subsequently minimize', async ({
  page,
}) => {
  await open(page, 'no-selection');
  await scroll(page, 180);
  await page.clock.runFor(1000);
  await expect(page.getByRole('tab')).toHaveCount(3);
  await expect(page.getByRole('tab', { selected: true })).toHaveCount(0);
  await page.getByRole('tab', { name: 'GitHub' }).click();
  await expect(page.getByRole('tab', { selected: true })).toHaveAttribute('aria-label', '展开导航');
  await rememberIcon(page);
  await page.clock.runFor(1000);
  assertIcon(await sample(page));
});
