import { expect, test } from '@playwright/test';

test('keeps ordered-list counters and periods on the same marker line', async ({ page }) => {
  const response = await page.goto(
    '/iframe.html?id=ai-markdownrenderer--loose-list-with-multi-paragraph-items&viewMode=story'
  );
  expect(response?.ok()).toBeTruthy();

  const listItems = page.locator('#storybook-root .markdown-renderer ol > li');
  await expect(listItems).toHaveCount(4);

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
