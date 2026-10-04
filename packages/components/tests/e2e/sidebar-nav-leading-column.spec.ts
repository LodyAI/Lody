import { expect, test } from '@playwright/test';

test('sidebar footer controls share a compact desktop height across identity states', async ({
  page,
}) => {
  await page.setViewportSize({ width: 900, height: 500 });
  for (const theme of ['light', 'dark']) {
    for (const story of ['default', 'long-name', 'syncing', 'local-identity']) {
      await page.goto(
        `/iframe.html?id=components-sidebarfooter--${story}&viewMode=story&globals=theme:${theme}`
      );
      const footer = page.locator('[data-sidebar-footer]');
      await expect(footer).toBeVisible();
      for (const fontSize of [12, 14, 18]) {
        await page.evaluate(
          (size) => document.documentElement.style.setProperty('--ui-font-size', `${size}px`),
          fontSize
        );
        const geometry = await footer.evaluate((element) => {
          const box = (node: Element) => {
            const rect = node.getBoundingClientRect();
            return {
              left: rect.left,
              right: rect.right,
              width: rect.width,
              height: rect.height,
              centerY: rect.y + rect.height / 2,
            };
          };
          const identity = element.querySelector(
            '[data-workspace-switcher-trigger], [data-workspace-identity]'
          )!;
          return {
            footer: box(element),
            identity: box(identity),
            actions: Array.from(element.querySelectorAll('button[aria-label]')).map((button) => ({
              ...box(button),
              glyph: box(button.querySelector('svg')!),
            })),
            overflow: element.scrollWidth > element.clientWidth,
          };
        });
        expect(geometry.identity.height).toBe(28);
        expect(geometry.footer.height).toBeLessThanOrEqual(37);
        expect(geometry.overflow).toBe(false);
        expect(geometry.actions).toHaveLength(3);
        const controls = [geometry.identity, ...geometry.actions];
        for (let index = 1; index < controls.length; index += 1) {
          expect(controls[index].left - controls[index - 1].right).toBe(4);
        }
        for (const action of geometry.actions) {
          expect(action.width).toBe(28);
          expect(action.height).toBe(28);
          expect(action.glyph.width).toBe(16);
          expect(action.glyph.height).toBe(16);
          expect(Math.abs(action.centerY - geometry.identity.centerY)).toBeLessThan(0.5);
        }
      }
      if (story === 'local-identity') {
        await expect(footer.locator('[data-workspace-switcher-trigger]')).toHaveCount(0);
      } else {
        const trigger = footer.locator('[data-workspace-switcher-trigger]');
        await trigger.focus();
        await page.keyboard.press('Enter');
        await expect(page.getByRole('menuitemradio').first()).toBeVisible();
        await page.keyboard.press('Escape');
        await expect(page.getByRole('menuitemradio').first()).toBeHidden();
        await expect(trigger).toHaveAttribute('aria-expanded', 'false');
      }
    }
  }
});

test('sidebar footer keeps mobile actions as 48px touch targets', async ({ browser }) => {
  const context = await browser.newContext({
    viewport: { width: 390, height: 600 },
    userAgent:
      'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Version/18.0 Mobile/15E148 Safari/604.1',
    isMobile: true,
    hasTouch: true,
  });
  const page = await context.newPage();
  try {
    await page.goto('/iframe.html?id=components-sidebarfooter--default&viewMode=story');
    const footer = page.locator('[data-sidebar-footer]');
    for (const name of ['Help', 'Archive', 'Settings']) {
      const action = footer.getByRole('button', { name, exact: true });
      await expect(action).toBeVisible();
      const box = await action.boundingBox();
      const glyph = await action.locator('svg').boundingBox();
      expect(box?.width).toBe(48);
      expect(box?.height).toBe(48);
      expect(glyph?.width).toBe(20);
      expect(glyph?.height).toBe(20);
    }
    await expect(footer.locator('[data-workspace-switcher-trigger]')).toHaveCount(0);
    await footer.getByRole('button', { name: 'Archive', exact: true }).tap();
    await expect(footer.getByRole('button', { name: 'Leave Archive' })).toHaveAttribute(
      'aria-current',
      'page'
    );
    await footer.getByRole('button', { name: 'Help', exact: true }).tap();
    await expect(page.getByRole('menuitem', { name: 'Docs' })).toBeVisible();
  } finally {
    await context.close();
  }
});

test.describe('compact navigation modal', () => {
  test.use({ viewport: { width: 500, height: 745 } });

  test.beforeEach(async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.goto('/iframe.html?id=layout-compactnavigationdialog--default&viewMode=story');
  });

  test('keeps Tab, Shift+Tab, programmatic focus and pointer presses off the background', async ({
    page,
  }) => {
    const opener = page.getByRole('button', { name: 'Show navigation sidebar' });
    const navigation = page.getByRole('dialog', { name: 'Navigation Menu', exact: true });
    for (let repeat = 0; repeat < 2; repeat += 1) {
      await opener.click();
      await expect(navigation).toBeVisible();
      const first = navigation.getByRole('button', { name: 'New Chat' });
      const last = navigation.getByRole('button', { name: 'Settings', exact: true });
      await expect(first).toBeFocused();
      await page.keyboard.press('Shift+Tab');
      await expect(last).toBeFocused();
      await page.keyboard.press('Tab');
      await expect(first).toBeFocused();
      const background = page.locator('[data-focus-scope="workspace-content"]');
      await expect(background).toHaveAttribute('inert', '');
      await background
        .getByRole('button', { name: 'Machine', includeHidden: true, exact: true })
        .evaluate((button) => button.focus());
      await expect(first).toBeFocused();
      await expect(page.getByRole('dialog', { name: 'Background machine picker' })).toHaveCount(0);
      await page.keyboard.press('Enter');
      await expect(navigation).toBeHidden();
      await expect(page.getByRole('dialog', { name: 'Background machine picker' })).toHaveCount(0);
      await expect(opener).toBeFocused();
      await expect(background).not.toHaveAttribute('inert');
    }
    await opener.click();
    // The uncovered right-hand part of the backdrop dismisses navigation.
    await page.mouse.click(450, 300);
    await expect(navigation).toBeHidden();
    await expect(page.getByRole('dialog', { name: 'Background machine picker' })).toHaveCount(0);
    await expect(opener).toBeFocused();
    await page.getByRole('button', { name: 'Machine', exact: true }).click();
    await expect(page.getByRole('dialog', { name: 'Background machine picker' })).toBeVisible();
  });

  test('dismisses a nested popup or dialog before navigation and keeps focus in navigation', async ({
    page,
  }) => {
    await page.getByRole('button', { name: 'Show navigation sidebar' }).click();
    const navigation = page.getByRole('dialog', { name: 'Navigation Menu', exact: true });
    const machine = navigation.getByRole('button', { name: 'Navigation machine' });
    await machine.click();
    await expect(page.getByRole('button', { name: 'Demo machine' })).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.getByRole('button', { name: 'Demo machine' })).toBeHidden();
    await expect(navigation).toBeVisible();
    await expect
      .poll(() => navigation.evaluate((dialog) => dialog.contains(document.activeElement)))
      .toBe(true);
    const settings = navigation.getByRole('button', { name: 'Settings', exact: true });
    await settings.click();
    await expect(page.getByRole('dialog', { name: 'Nested settings' })).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.getByRole('dialog', { name: 'Nested settings' })).toBeHidden();
    await expect(navigation).toBeVisible();
    await expect(settings).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(navigation).toBeHidden();
    await expect(page.getByRole('button', { name: 'Show navigation sidebar' })).toBeFocused();
  });

  test('falls back to the content scope when the opener disappears', async ({ page }) => {
    await page.getByRole('button', { name: 'Show navigation sidebar' }).click();
    await page.getByRole('button', { name: 'Remove opener and close' }).click();
    await expect(page.getByRole('dialog', { name: 'Navigation Menu', exact: true })).toBeHidden();
    await expect(page.locator('[data-focus-scope="workspace-content"]')).toBeFocused();
  });

  test('restores focus and releases the modal after an animated close', async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'no-preference' });
    const opener = page.getByRole('button', { name: 'Show navigation sidebar' });
    await opener.click();
    const navigation = page.getByRole('dialog', { name: 'Navigation Menu', exact: true });
    await expect(navigation.getByRole('button', { name: 'New Chat' })).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(navigation).toBeHidden();
    await expect(opener).toBeFocused();
    await expect(page.locator('[data-focus-scope="workspace-content"]')).not.toHaveAttribute(
      'inert'
    );
  });
});

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

test('settings account avatars stay square and centred on the navigation row', async ({ page }) => {
  for (const theme of ['light', 'dark']) {
    for (const story of ['with-image', 'initials']) {
      await page.goto(
        `/iframe.html?id=settings-settingsaccountentry--${story}&viewMode=story&globals=theme:${theme}`
      );
      const row = page.getByRole('button', { name: 'Open account settings' });
      const avatar = row.locator('[data-size="medium"]');
      await expect(avatar).toBeVisible();
      if (story === 'with-image') await expect(avatar.locator('img')).toBeVisible();
      await page.evaluate(() => document.fonts.ready);

      for (const fontSize of [12, 14, 18]) {
        await page.evaluate((size) => {
          document.documentElement.style.setProperty('--ui-font-size', `${size}px`);
        }, fontSize);
        const face = await avatar.boundingBox();
        const label = await row.locator(':scope > span').last().boundingBox();
        const button = await row.boundingBox();
        const icon = await page
          .getByRole('button', { name: 'Preferences' })
          .locator('svg')
          .boundingBox();
        expect(face).not.toBeNull();
        expect(label).not.toBeNull();
        expect(button).not.toBeNull();
        expect(icon).not.toBeNull();
        expect(face!.width).toBe(24);
        expect(face!.height).toBe(24);
        expect(
          Math.abs(face!.y + face!.height / 2 - (button!.y + button!.height / 2))
        ).toBeLessThan(0.5);
        expect(Math.abs(face!.y + face!.height / 2 - (label!.y + label!.height / 2))).toBeLessThan(
          0.5
        );
        expect(Math.abs(face!.x + face!.width / 2 - (icon!.x + icon!.width / 2))).toBeLessThan(0.5);
        if (story === 'with-image') {
          const image = avatar.locator('img');
          expect(await image.boundingBox()).toEqual(face);
          await expect(image).toHaveCSS('object-fit', 'cover');
        }
      }
    }
  }
});
