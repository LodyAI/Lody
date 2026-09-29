import { expect, test } from '@playwright/test';

/* The sidebar's leading elements share one column: every nav row's icon box
   starts on the same X as the header wordmark's text, and the row labels sit
   one icon-width-plus-gap past it. The oversized w-5 icon slot previously
   padded the 16px glyph 2px inward, pushing all three nav icons right of the
   axis the wordmark, group labels and project rows already share. */
test('nav icons sit on the sidebar leading column', async ({ page }) => {
  await page.goto('/iframe.html?id=components-lodysidebar--default&viewMode=story');
  const wordmark = page.locator('span[aria-label="Lody"]');
  await expect(wordmark).toBeVisible();
  // The span carries px-2; its text — the 'L' — starts at the padding edge.
  const axis = await wordmark.evaluate(
    (el) => el.getBoundingClientRect().left + parseFloat(getComputedStyle(el).paddingLeft)
  );
  const rows = page.getByRole('button', { name: /^(Home|Schedules|Search)$/ });
  await expect(rows).toHaveCount(3);
  for (let i = 0; i < 3; i += 1) {
    const row = rows.nth(i);
    const iconLeft = await row
      .locator('svg')
      .first()
      .evaluate((el) => el.getBoundingClientRect().left);
    expect(Math.abs(iconLeft - axis)).toBeLessThanOrEqual(1);
    const labelLeft = await row
      .locator('span.truncate')
      .evaluate((el) => el.getBoundingClientRect().left);
    // 16px icon + the row's gap lands the label on the shared text column.
    expect(Math.abs(labelLeft - (axis + 24))).toBeLessThanOrEqual(1);
  }
});
