import { expect, test, type Locator, type Page } from '@playwright/test';

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

const STATUS_STORY =
  '/iframe.html?id=sidebar-status-view--expanded-later-and-settled&viewMode=story';
const PINNED_STORY = '/iframe.html?id=sidebar-pinned-sections--playground&viewMode=story';

type Point = { x: number; y: number };

/** A pointer drag past the 5px activation distance, then a slow move to the drop point. */
async function drag(page: Page, from: Point, to: Point) {
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move(from.x, from.y + 10, { steps: 5 });
  await page.mouse.move(to.x, to.y, { steps: 25 });
  await page.mouse.up();
}

async function centerOf(locator: Locator): Promise<Point> {
  const box = (await locator.boundingBox())!;
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
}

/**
 * The pointer Y that drops into Focus slot `index` (>= 1): halfway between the
 * untransformed centers of the rows around it, the geometry the drop index reads.
 * Entering Focus closes a pinned row's home gap and shifts Focus, so callers
 * read it until it settles.
 */
const focusSlotY = (page: Page, index: number) =>
  page.evaluate(
    ({ focus, index }) => {
      const rows = document.querySelector(`${focus} [data-pin-rows]`)!;
      const nodes = Array.from(rows.children) as HTMLElement[];
      const center = (node: HTMLElement) => node.offsetTop + node.offsetHeight / 2;
      return Math.round(
        rows.getBoundingClientRect().top + (center(nodes[index - 1]!) + center(nodes[index]!)) / 2
      );
    },
    { focus: FOCUS, index }
  );

const nodeIds = (page: Page, section: string) =>
  page
    .locator(`[data-pin-section="${section}"] [data-pin-node]`)
    .evaluateAll((nodes) => nodes.map((n) => n.getAttribute('data-pin-node')));

test('a pinned row dropped below a row of another section moves into that section', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1200, height: 900 });
  await page.goto(STATUS_STORY);
  const target = page.locator('[data-pin-section="maintenance"] [data-pin-node="pin-1"]');
  await expect(target).toBeVisible();
  expect(await nodeIds(page, 'default')).toEqual(['pin-2']);

  const box = (await target.boundingBox())!;
  await drag(page, await centerOf(page.locator('[data-pin-node="pin-2"]')), {
    x: box.x + box.width / 2,
    y: box.y + box.height - 2,
  });

  await expect.poll(() => nodeIds(page, 'maintenance')).toEqual(['pin-1', 'pin-2']);
  expect(await nodeIds(page, 'default')).toEqual([]);
});

test('a section dragged by its header onto the section above reorders the sections', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1200, height: 1600 });
  await page.goto(PINNED_STORY);
  const handles = page.locator('[data-pin-section-handle]');
  await expect(handles).toHaveCount(2);
  const sectionOrder = () =>
    page
      .locator('[data-pin-section]')
      .evaluateAll((nodes) =>
        nodes.map((n) => n.getAttribute('data-pin-section')).filter((id) => id !== 'default')
      );
  expect(await sectionOrder()).toEqual(['maintenance', 'releases']);

  // dnd-kit matches sections by center: drag until the centers meet, as a person would.
  const centers = await page.evaluate(() =>
    ['maintenance', 'releases'].map((id) => {
      const list = document.querySelector(`[data-pin-section="${id}"]`)!;
      const handle = list.parentElement!.querySelector('[data-pin-section-handle]') ?? list;
      const top = Math.min(handle.getBoundingClientRect().top, list.getBoundingClientRect().top);
      const bottom = list.getBoundingClientRect().bottom;
      return (top + bottom) / 2;
    })
  );
  const grab = await centerOf(handles.nth(1));
  await drag(page, grab, { x: grab.x, y: grab.y + centers[0]! - centers[1]! });

  await expect.poll(sectionOrder).toEqual(['releases', 'maintenance']);
});

test('a Later row dropped between two Focus rows is restored at that slot', async ({ page }) => {
  await page.setViewportSize({ width: 1200, height: 900 });
  await page.goto(STATUS_STORY);
  const focusRows = page.locator(`${FOCUS} [data-pin-node]`);
  await expect(focusRows.first()).toBeVisible();
  const order = () => nodeIds(page, '__status_focus__');
  const before = await order();
  const laterRow = page.locator('[data-sidebar-updated-id="later-1"]');
  await expect(laterRow).toBeVisible();

  const first = (await focusRows.nth(0).boundingBox())!;
  await drag(page, await centerOf(laterRow), {
    x: first.x + first.width / 2,
    y: first.y + first.height,
  });

  await expect.poll(order).toEqual([before[0], 'later-1', ...before.slice(1)]);
});

test('a pinned row dragged into Focus is unpinned at the dropped slot', async ({ page }) => {
  await page.setViewportSize({ width: 1200, height: 900 });
  await page.goto('/iframe.html?id=sidebar-status-view--default&viewMode=story');
  const focusRows = page.locator(`${FOCUS} [data-pin-node]`);
  await expect(focusRows.first()).toBeVisible();
  const focusOrder = () =>
    focusRows.evaluateAll((nodes) => nodes.map((n) => n.getAttribute('data-pin-node')));
  const before = await focusOrder();
  expect(before.length).toBeGreaterThan(1);

  const start = await centerOf(
    page.locator('[data-pin-section="default"] [data-pin-node="pin-2"]')
  );
  await page.mouse.move(start.x, start.y);
  await page.mouse.down();
  await page.mouse.move(start.x, start.y + 10, { steps: 5 });
  const entry = (await focusRows.nth(0).boundingBox())!;
  await page.mouse.move(start.x, entry.y + entry.height / 2, { steps: 20 });
  let y = await focusSlotY(page, 1);
  await expect
    .poll(async () => {
      const previous = y;
      y = await focusSlotY(page, 1);
      return y === previous;
    })
    .toBe(true);
  await page.mouse.move(start.x, y, { steps: 20 });
  await page.mouse.up();

  await expect.poll(focusOrder).toEqual([before[0], 'pin-2', ...before.slice(1)]);
  await expect(page.locator('[data-pin-section="default"] [data-pin-node="pin-2"]')).toHaveCount(0);
});
