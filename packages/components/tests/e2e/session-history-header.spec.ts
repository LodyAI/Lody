import { expect, test } from '@playwright/test';
import en from '../../../../locales/en.json' with { type: 'json' };
import zh from '../../../../locales/zh_CN.json' with { type: 'json' };

test.setTimeout(90_000);

for (const [language, copy] of [
  ['en', en],
  ['zh_CN', zh],
] as const) {
  for (const width of [1180, 390]) {
    test(`read-only history header stays interactive in a macOS window: ${language}, ${width}px`, async ({
      page,
    }, testInfo) => {
      await page.setViewportSize({ width, height: 844 });
      const story = `${width === 390 ? 'narrow-' : ''}mac-window${language === 'zh_CN' ? '-chinese' : ''}`;
      await page.goto(
        `/iframe.html?id=sessions-readonlyhistory--${story}&viewMode=story&globals=locale:${language}`
      );
      const strip = page.locator('[data-window-drag-strip]');
      await expect(strip).toBeVisible({ timeout: 60_000 });
      const menu = page.getByRole('button', { name: copy['sessions.moreActions'], exact: true });
      const back = page.getByRole('button', { name: copy['common.back'], exact: true });
      await expect(menu).toBeEnabled();
      await expect(back).toBeVisible();
      // A real pointer click, without force or injected CSS. The broken header is covered by the strip.
      await menu.click({ timeout: 5_000 });
      await expect(menu).toHaveAttribute('aria-expanded', 'true');
      await expect(
        page.getByRole('menuitem', { name: copy['sessions.copy'], exact: true })
      ).toBeVisible();
      await page.getByRole('menuitem', { name: copy['sessions.copy'], exact: true }).hover();
      const markdown = page.getByRole('menuitem', {
        name: copy['sessions.copyAsMarkdown'],
        exact: true,
      });
      await expect(markdown).toBeVisible();
      await expect(markdown).toBeEnabled();
      await markdown.evaluate(async (item) => {
        const popup = item.closest('[role="menu"]')!;
        await Promise.all(
          popup
            .getAnimations({ subtree: true })
            .map((animation) => animation.finished.catch(() => {}))
        );
      });
      await page.screenshot({ path: testInfo.outputPath('history-menu-open.png') });
      await markdown.click();
      await expect(menu).toHaveAttribute('aria-expanded', 'false');
      for (const control of [menu, back]) {
        expect(
          await control.evaluate((button) => {
            const box = button.getBoundingClientRect();
            const hit = document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2);
            return {
              uncovered: hit !== null && button.contains(hit),
              region: getComputedStyle(button).getPropertyValue('-webkit-app-region'),
              insideViewport: box.x >= 0 && box.right <= innerWidth,
            };
          })
        ).toEqual({ uncovered: true, region: 'no-drag', insideViewport: true });
      }
      await back.click();
      expect(
        await strip.evaluate((element) =>
          getComputedStyle(element).getPropertyValue('-webkit-app-region')
        )
      ).toBe('drag');
      await page.screenshot({ path: testInfo.outputPath('history-header.png') });
    });
  }
}
