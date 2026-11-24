import { expect, test } from '@playwright/test';

test('keeps ordered-list counters and periods on the same marker line', async ({ page }) => {
  const response = await page.goto(
    '/iframe.html?id=sessions-assistantturnalignment--conversation-rhythm&viewMode=story'
  );
  expect(response?.ok()).toBeTruthy();

  const listItems = page.locator('#storybook-root .markdown-renderer ol > li');
  await expect(listItems).toHaveCount(3, { timeout: 20_000 });

  const markerStyles = await listItems.evaluateAll((items) =>
    items.map((item) => {
      const style = getComputedStyle(item, '::before');
      return {
        height: Number.parseFloat(style.height),
        lineHeight: Number.parseFloat(style.lineHeight),
        whiteSpace: style.whiteSpace,
      };
    })
  );

  for (const markerStyle of markerStyles) {
    expect(markerStyle.whiteSpace).toBe('nowrap');
    expect(markerStyle.height).toBeLessThanOrEqual(markerStyle.lineHeight + 0.5);
  }
});

for (const variant of ['completed', 'streaming'] as const) {
  test(`renders ordered, unordered, and mixed task lists without stray markers or overlap (${variant})`, async ({
    page,
  }) => {
    const response = await page.goto(
      `/iframe.html?id=ai-gui-markdown-task-lists--${variant}&viewMode=story`
    );
    expect(response?.ok()).toBeTruthy();

    const taskItems = page.locator('#storybook-root .markdown-renderer li.task-list-item');
    await expect(taskItems).toHaveCount(7, { timeout: 20_000 });

    const listStyles = await page
      .locator('#storybook-root .markdown-renderer .contains-task-list')
      .evaluateAll((lists) => lists.map((list) => getComputedStyle(list).listStyleType));
    expect(listStyles.length).toBeGreaterThanOrEqual(4);
    for (const listStyleType of listStyles) {
      expect(listStyleType).toBe('none');
    }

    const taskMeasurements = await taskItems.evaluateAll((items) =>
      items.map((item) => {
        const before = getComputedStyle(item, '::before');
        const checkbox = item.querySelector(':scope > input[type="checkbox"]');
        if (!(checkbox instanceof HTMLInputElement)) {
          throw new Error('Expected task item to contain a direct checkbox input');
        }
        const itemRect = item.getBoundingClientRect();
        const checkboxRect = checkbox.getBoundingClientRect();
        const walker = document.createTreeWalker(item, NodeFilter.SHOW_TEXT);
        let firstTextRect: DOMRect | null = null;
        while (walker.nextNode()) {
          const node = walker.currentNode;
          if (!node.textContent?.trim()) continue;
          const range = document.createRange();
          range.selectNodeContents(node);
          firstTextRect = range.getBoundingClientRect();
          break;
        }
        if (!firstTextRect) {
          throw new Error('Expected task item to contain visible text');
        }
        return {
          beforeContent: before.content,
          itemLeft: itemRect.left,
          checkboxLeft: checkboxRect.left,
          checkboxRight: checkboxRect.right,
          textLeft: firstTextRect.left,
        };
      })
    );

    for (const m of taskMeasurements) {
      expect(m.beforeContent).toBe('none');
      expect(m.checkboxLeft).toBeGreaterThanOrEqual(m.itemLeft);
      expect(m.textLeft).toBeGreaterThan(m.checkboxRight + 2);
    }

    // Non-task siblings inside mixed lists keep their own markers.
    const regularOrderedBefore = await page
      .locator('#storybook-root .markdown-renderer ol.contains-task-list > li:not(.task-list-item)')
      .evaluateAll((items) => items.map((item) => getComputedStyle(item, '::before').content));
    expect(regularOrderedBefore).toHaveLength(2);
    for (const content of regularOrderedBefore) {
      expect(content).not.toBe('none');
    }

    const regularUnorderedBefore = await page
      .locator('#storybook-root .markdown-renderer ul.contains-task-list > li:not(.task-list-item)')
      .evaluateAll((items) => items.map((item) => getComputedStyle(item, '::before').content));
    expect(regularUnorderedBefore).toHaveLength(2);
    for (const content of regularUnorderedBefore) {
      expect(content).not.toBe('none');
    }
  });
}
