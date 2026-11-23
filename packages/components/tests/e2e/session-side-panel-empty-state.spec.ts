import { expect, test } from '@playwright/test';

test('panel launcher buttons stay equal as the panel is resized', async ({ page }) => {
  await page.goto('/iframe.html?id=sessions-sessionsidepaneltabbar--empty-state&viewMode=story');
  const title = page.getByText('Open a panel', { exact: true });
  await expect(title).toBeVisible();
  const panel = title.locator('xpath=../../../..');
  const buttons = title.locator('xpath=../div[2]/button');
  await expect(buttons).toHaveCount(6);

  // A narrow panel wraps the longer label; resizing also exercises both grid layouts.
  for (const width of [180, 360, 420, 180]) {
    await panel.evaluate((element, value) => {
      element.style.width = `${value}px`;
    }, width);
    const sizes = await buttons.evaluateAll((elements) =>
      elements.map((element) => ({
        height: element.getBoundingClientRect().height,
        contentHeight: element.scrollHeight,
      }))
    );
    expect(sizes.every(({ height }) => Math.abs(height - sizes[0]!.height) < 0.5)).toBe(true);
    expect(sizes.every(({ height, contentHeight }) => contentHeight <= height)).toBe(true);
  }

  // Opening the real side panel animates its width. Check the intermediate
  // frames too, while labels are reflowing between the one- and two-column layouts.
  const animatedHeights = await panel.evaluate((element) => {
    const grid = element.querySelector('div:has(> button:nth-child(6))')!;
    const animation = element.animate([{ width: '120px' }, { width: '420px' }], {
      duration: 220,
      easing: 'cubic-bezier(0.32, 0.72, 0, 1)',
    });
    animation.pause();
    const frames = [0, 30, 60, 100, 160, 220].map((time) => {
      animation.currentTime = time;
      return Array.from(grid.children, (button) => button.getBoundingClientRect().height);
    });
    animation.cancel();
    return frames;
  });
  for (const heights of animatedHeights) {
    expect(heights.every((height) => Math.abs(height - heights[0]!) < 0.5)).toBe(true);
  }
});
