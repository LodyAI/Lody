import { expect, test, type Page, type TestInfo } from '@playwright/test';

const prefix = 'migration-ownedlegacysidebarparts--';
test.use({ viewport: { width: 1280, height: 1000 }, reducedMotion: 'reduce' });

async function openParts(page: Page, story: string, theme: string) {
  await page.goto(
    `/iframe.html?id=${prefix}${story}&viewMode=story&globals=theme:${theme};locale:en`
  );
  await expect(page.locator('[data-sidebar-parts-state]')).toHaveAttribute(
    'data-sidebar-parts-state',
    'expanded'
  );
  await expect
    .poll(() => page.evaluate(() => document.documentElement.classList.contains('dark')))
    .toBe(theme === 'dark');
  await page.mouse.move(1200, 900);
  await page.evaluate(() => document.fonts.ready);
  await settle(page);
}

async function settle(page: Page) {
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          document
            .getAnimations()
            .filter(
              (animation) =>
                animation.effect?.getTiming().iterations !== Infinity &&
                (animation.pending || animation.playState === 'running')
            ).length
      )
    )
    .toBe(0);
}

async function capture(page: Page, target: string, name: string, info: TestInfo) {
  const wholePath = info.outputPath(`${name}-sidebar.png`);
  const targetPath = info.outputPath(`${name}-target.png`);
  await page.screenshot({ path: wholePath, caret: 'initial', animations: 'allow' });
  await page
    .locator(target)
    .first()
    .screenshot({ path: targetPath, caret: 'initial', animations: 'allow' });
  await info.attach(`${name} actual Sidebar`, { path: wholePath, contentType: 'image/png' });
  await info.attach(`${name} actual target`, { path: targetPath, contentType: 'image/png' });
}

async function verifyMenu(page: Page) {
  await page.getByRole('button', { name: 'default synthetic item', exact: true }).click();
  await expect(page.locator('[data-sidebar-parts-event]')).toHaveText('default');
  await page.getByRole('button', { name: 'Add synthetic group', exact: true }).click();
  await expect(page.locator('[data-sidebar-parts-event]')).toHaveText('Group added');
  await expect(page.getByRole('button', { name: 'Disabled item', exact: true })).toBeDisabled();
}

for (const theme of ['light', 'dark']) {
  for (const opaque of [false, true]) {
    test(`${theme}: ${opaque ? 'opaque callers' : 'default'} retain their own layout and actions`, async ({
      page,
    }, info) => {
      await openParts(page, opaque ? 'opaque-callers' : 'default', theme);
      const header = page.locator('[data-sidebar=header]');
      const item = page.getByRole('button', { name: 'default synthetic item', exact: true });
      await expect(header).toHaveCSS('display', opaque ? 'grid' : 'flex');
      await expect(header).toHaveCSS('gap', '8px');
      await expect(header).toHaveCSS('padding', '8px');
      await expect(item).toHaveCSS('height', '32px');
      // Opaque classes change grid display and width, but their competing
      // spacing, height and radius retain the primitive's computed defaults.
      if (opaque) {
        await expect(item).toHaveCSS('width', '83px');
        await expect(item).toHaveCSS('border-radius', '6px');
        await expect(page.getByRole('link', { name: 'Slot item', exact: true })).toHaveCSS(
          'width',
          '79px'
        );
        await expect(page.getByRole('link', { name: 'Slot item', exact: true })).toHaveCSS(
          'height',
          '41px'
        );
      }
      await capture(page, '[data-sidebar=header]', opaque ? 'caller' : 'default', info);
      await verifyMenu(page);
      await page.getByRole('button', { name: 'Toggle parts from content', exact: true }).click();
      await expect(page.locator('[data-sidebar-parts-state]')).toHaveAttribute(
        'data-sidebar-parts-state',
        'collapsed'
      );
      await settle(page);
      await page.getByRole('button', { name: 'Toggle parts from content', exact: true }).click();
      await expect(page.locator('[data-sidebar-parts-state]')).toHaveAttribute(
        'data-sidebar-parts-state',
        'expanded'
      );
      await settle(page);
      await verifyMenu(page);
    });
  }

  test(`${theme}: actual input and skeleton parts preserve geometry and interaction`, async ({
    page,
  }, info) => {
    await openParts(page, 'input-and-skeleton', theme);
    const input = page.getByRole('textbox', { name: 'Plain synthetic input', exact: true });
    await input.fill('local files');
    await expect(page.locator('[data-input-skeleton-event]')).toHaveText('Input: local files');
    await expect(input).toHaveCSS('height', '32px');
    await expect(
      page.getByRole('textbox', { name: 'Disabled opaque synthetic input', exact: true })
    ).toBeDisabled();
    const leading = page
      .getByRole('textbox', { name: 'Leading caller synthetic input', exact: true })
      .locator('..');
    await expect(leading).toHaveCSS('height', '48px');
    await expect(leading).toHaveCSS('width', '160px');
    await page.getByRole('button', { name: 'Mount synthetic skeletons', exact: true }).click();
    await expect(page.locator('[data-input-skeleton]')).toHaveCount(3);
    await expect(
      page.getByRole('button', { name: 'Mount synthetic skeletons', exact: true })
    ).toBeDisabled();
    const plain = page.locator('[data-input-skeleton=plain]');
    const caller = page.locator('[data-input-skeleton=utility]');
    await expect(plain).toHaveCSS('height', '32px');
    await expect(plain).toHaveCSS('display', 'flex');
    await expect(caller).toHaveCSS('height', '48px');
    await expect(caller).toHaveCSS('display', 'grid');
    await expect(caller).toHaveCSS('gap', '16px');
    await expect(caller).toHaveCSS('padding-left', '20px');
    await expect(caller).toHaveCSS('border-radius', '0px');
    await capture(page, '[data-input-skeleton=utility]', 'input-and-skeleton', info);
  });
}
