import { expect, test, type Locator } from '@playwright/test';

const scenarios = [
  ['owned-root-mobile-default', [0, 0, 0, 0]],
  ['owned-root-mobile-native-inset', [0, 0, 260, 0]],
  ['owned-root-web-native-inset', [27, 13, 260, 11]],
  ['owned-root-settings-native-inset', [27, 13, 260, 11]],
] as const;

test.use({ reducedMotion: 'no-preference' });

async function expectContentBounds(
  root: Locator,
  width: number,
  top: number,
  right: number,
  bottom: number,
  left: number
) {
  await expect
    .poll(() =>
      root.evaluate((element) => {
        const pane = element.querySelector('[data-owned-workspace-content]')!;
        return [element, pane].flatMap((node) => {
          const { x, y, width: nodeWidth, height } = node.getBoundingClientRect();
          return [x, y, nodeWidth, height];
        });
      })
    )
    .toEqual([0, 0, width, 900, left, top, width - left - right, 900 - top - bottom]);
}

for (const width of [390, 820]) {
  for (const theme of ['light', 'dark']) {
    for (const [story, [top, right, keyboard, left]] of scenarios) {
      test(`${story} keeps usable content at ${width}px in ${theme}`, async ({ page }) => {
        await page.setViewportSize({ width, height: 900 });
        await page.goto(
          `/iframe.html?id=mobile-viewportkeyboard--${story}&viewMode=story&globals=locale:en;theme:${theme}`
        );
        const root = page.locator('[data-owned-workspace-root]');
        const input = page.getByRole('combobox', { name: 'Message', exact: true });
        await input.waitFor({ state: 'visible' });
        await expect(input).toBeEditable();
        await expect
          .poll(() => page.evaluate(() => document.documentElement.classList.contains('dark')))
          .toBe(theme === 'dark');
        await expect(page.getByRole('button', { name: 'Try again', exact: true })).toHaveCount(0);
        await page.evaluate(() => document.fonts.ready);
        for (const [edge, value] of Object.entries({ top, right, bottom: keyboard, left })) {
          await expect(root).toHaveCSS(`padding-${edge}`, `${value}px`);
        }
        if (story === 'owned-root-settings-native-inset') {
          await expect(root).toHaveCSS('position', 'relative');
        }
        await expectContentBounds(root, width, top, right, keyboard, left);
        await expect(input).toBeInViewport({ ratio: 1 });
        await input.fill('Draft survives the keyboard inset');

        // This changes the fixture's host input, not the helper's styles or animation clock.
        const duration = await root.evaluate(async (element) => {
          void getComputedStyle(element).paddingBottom;
          element.parentElement!.style.setProperty('--native-keyboard-height', '120px');
          await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
          void getComputedStyle(element).paddingBottom;
          const transition = element
            .getAnimations()
            .find(
              (animation) =>
                animation instanceof CSSTransition &&
                animation.transitionProperty === 'padding-bottom'
            );
          if (!transition?.effect) throw new Error('Expected the keyboard padding transition');
          const timing = transition.effect.getTiming();
          await transition.finished;
          return { duration: timing.duration, easing: timing.easing };
        });
        expect(duration).toEqual({
          duration: 250,
          easing: 'cubic-bezier(0.2, 0.7, 0.3, 1)',
        });
        await expect(root).toHaveCSS('padding-bottom', '120px');
        await expectContentBounds(root, width, top, right, 120, left);
        await expect(input).toBeInViewport({ ratio: 1 });
        await expect(input).toBeFocused();
        await expect(input).toHaveValue('Draft survives the keyboard inset');

        await root.evaluate((element, value) => {
          element.parentElement!.style.setProperty('--native-keyboard-height', `${value}px`);
        }, keyboard);
        await expect(root).toHaveCSS('padding-bottom', `${keyboard}px`);
        await expectContentBounds(root, width, top, right, keyboard, left);
        await expect(input).toHaveValue('Draft survives the keyboard inset');
      });
    }
  }
}
