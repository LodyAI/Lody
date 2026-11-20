import { expect, test } from '@playwright/test';

const FOCUS = '[data-pin-section="__status_focus__"]';

test('a Focus row released between the last row and the Later label lands last', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1200, height: 900 });
  await page.goto('/iframe.html?id=sidebar-status-view--expanded-later-and-settled&viewMode=story');
  const rows = page.locator(`${FOCUS} [data-pin-node]`);
  await expect(rows.first()).toBeVisible();
  const order = () =>
    rows.evaluateAll((nodes) => nodes.map((n) => n.getAttribute('data-pin-node')));
  const before = await order();
  expect(before.length).toBeGreaterThan(1);

  const geometry = await page.evaluate((focus) => {
    const section = document.querySelector(focus)!;
    const slots = Array.from(section.querySelectorAll('[data-pin-node]'));
    const first = slots[0]!.getBoundingClientRect();
    const lastBottom = slots[slots.length - 1]!.getBoundingClientRect().bottom;
    // The next bucket's heading is the first element painted below Focus.
    let laterTop = Infinity;
    for (const element of Array.from(document.querySelectorAll('*'))) {
      if (section.contains(element) || element.contains(section)) continue;
      const top = element.getBoundingClientRect().top;
      if (top >= lastBottom && element.getBoundingClientRect().height > 0) {
        laterTop = Math.min(laterTop, top);
      }
    }
    return {
      x: first.left + first.width / 2,
      y: first.top + first.height / 2,
      lastBottom,
      laterTop,
    };
  }, FOCUS);
  // The visual spacing below Focus is what a slightly low release falls into.
  expect(geometry.laterTop - geometry.lastBottom).toBeGreaterThan(4);
  const dropY = (geometry.lastBottom + geometry.laterTop) / 2;

  await page.mouse.move(geometry.x, geometry.y);
  await page.mouse.down();
  await page.mouse.move(geometry.x, geometry.y + 10, { steps: 5 });
  await page.mouse.move(geometry.x, dropY, { steps: 20 });
  await page.mouse.up();

  await expect.poll(order).toEqual([...before.slice(1), before[0]]);
});
