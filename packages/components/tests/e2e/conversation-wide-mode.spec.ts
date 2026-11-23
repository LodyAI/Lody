import { expect, test } from '@playwright/test';

for (const width of [390, 820]) {
  for (const inset of [false, true]) {
    test(`column geometry and draft at ${width}px${inset ? ' with caller inset' : ''}`, async ({
      page,
    }) => {
      await page.setViewportSize({ width, height: 900 });
      await page.goto(
        `/iframe.html?id=shared-conversationcolumn--${inset ? 'caller-inset' : 'default'}&viewMode=story`
      );
      const column = page.locator('[data-slot="conversation-column"]');
      const draft = page.getByRole('textbox');
      await expect(column).toHaveCSS('max-width', width < 640 ? '796px' : '804px');
      await expect(column).toHaveCSS('padding-inline-start', width < 640 ? '14px' : '18px');
      await draft.fill('Still editing');
      await page.getByRole('button', { name: 'Toggle full width' }).click();
      await expect(column).toHaveCSS('max-width', 'none');
      const padding = width >= 640 ? '64px' : inset ? '12px' : '14px';
      await expect(column).toHaveCSS('padding-inline-start', padding);
      await expect(column).toHaveCSS('padding-inline-end', padding);
      await expect(draft).toHaveValue('Still editing');
      await page.getByRole('button', { name: 'Toggle full width' }).click();
      await expect(column).toHaveCSS('max-width', width < 640 ? '796px' : '804px');
      await expect(draft).toHaveValue('Still editing');
    });
  }
}
