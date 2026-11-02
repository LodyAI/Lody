import {
  BOOT_SHELL_HEAD_MARKER,
  BOOT_SHELL_ROOT_MARKER,
  injectBootShell,
} from '../../vite-boot-shell';
import { expect, test, type Page } from '@playwright/test';

const STORY = '/iframe.html?id=components-bootshell--transition&viewMode=story&globals=locale:en';
async function phase(page: Page, name: string) {
  await page.getByRole('button', { name, exact: true }).evaluate((el: HTMLElement) => el.click());
}
async function frame(page: Page) {
  return page.locator('.lody-boot-shell__main').evaluate((el) => {
    const rect = el.getBoundingClientRect();
    const style = getComputedStyle(el);
    return {
      x: rect.x,
      y: rect.y,
      width: rect.width,
      height: rect.height,
      radius: style.borderRadius,
      border: style.borderColor,
      shadow: style.boxShadow,
      canvas: style.backgroundColor,
    };
  });
}
async function settled(page: Page) {
  await page.waitForFunction(
    () =>
      !document
        .querySelector('.lody-boot-shell')!
        .getAnimations({ subtree: true })
        .some(
          (animation) => animation instanceof CSSTransition && animation.playState === 'running'
        )
  );
}

for (const theme of ['light', 'dark']) {
  test(`startup keeps one frame and hands its geometry to the real card in ${theme}`, async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1200, height: 800 });
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.goto(`${STORY};theme:${theme}`);
    await expect(page.locator('[data-lody-boot-shell]')).toHaveCount(1);
    await page.evaluate(() => {
      (window as any).startupMark = document.querySelector('.lody-boot-shell__mark');
    });
    const neutral = await frame(page);
    expect(neutral.x).toBe(0);
    await phase(page, 'workspace');
    const loading = await frame(page);
    expect(loading.x).toBe(280);
    expect(loading.y).toBe(4);
    expect(loading.radius).toBe('14px');
    expect(
      await page.evaluate(
        () => (window as any).startupMark === document.querySelector('.lody-boot-shell__mark')
      )
    ).toBe(true);
    await phase(page, 'content');
    await expect(page.locator('[data-lody-boot-shell]')).toHaveCount(0);
    await expect(
      page.locator('[data-loading-placeholder-scope=content] [role=status]')
    ).toContainText('Syncing workspace');
    const actual = await page.locator('[data-workspace-card]').evaluate((el) => {
      const rect = el.getBoundingClientRect();
      const style = getComputedStyle(el);
      return {
        x: rect.x,
        y: rect.y,
        width: rect.width,
        height: rect.height,
        radius: style.borderRadius,
        border: style.borderColor,
        shadow: style.boxShadow,
        canvas: style.backgroundColor,
      };
    });
    expect(actual).toEqual(loading);
    await phase(page, 'ready');
    await page
      .getByRole('textbox', { name: 'Message' })
      .fill('Ready without waiting for animation');
    await expect(page.getByRole('textbox', { name: 'Message' })).toHaveValue(
      'Ready without waiting for animation'
    );
    await phase(page, 'entry');
    await phase(page, 'recovery');
    await expect(page.getByRole('button', { name: 'Retry startup' })).toBeVisible();
    await expect(page.locator('[data-lody-boot-shell]')).toHaveCount(0);
    await page.getByRole('button', { name: 'Retry startup' }).click();
    await expect(page.locator('[data-lody-boot-shell]')).toHaveCount(1);
  });
}

test('layout interpolates, reverses from its current position, and releases input immediately', async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await page.setViewportSize({ width: 1200, height: 800 });
  await page.goto(STORY);
  await expect(page.locator('[data-lody-boot-shell]')).toBeVisible();
  await settled(page);
  await phase(page, 'workspace');
  // Pause the browser's actual CSS transition, then sample a deterministic midpoint.
  await page.locator('.lody-boot-shell__sidebar').evaluate((el) => {
    const transition = el.getAnimations().find((animation) => animation instanceof CSSTransition)!;
    transition.pause();
    transition.currentTime = 160;
  });
  const middle = await frame(page);
  expect(middle.x).toBeGreaterThan(1);
  expect(middle.x).toBeLessThan(279);
  await phase(page, 'entry');
  const reversed = await frame(page);
  expect(Math.abs(reversed.x - middle.x)).toBeLessThan(1);
  await settled(page);
  expect((await frame(page)).x).toBe(0);
  await phase(page, 'workspace');
  await settled(page);
  await phase(page, 'ready');
  await expect(page.locator('.lody-boot-shell')).toHaveAttribute('inert', '');
  await expect(page.locator('.lody-boot-shell [role=status]')).toHaveCount(0);
  await page.getByRole('textbox', { name: 'Message' }).fill('Interactive during fade');
});

test('collapsed, settings and mobile presentations do not reserve a sidebar column', async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.setViewportSize({ width: 1200, height: 800 });
  await page.goto(STORY);
  await phase(page, 'workspace');
  await phase(page, 'Toggle sidebar');
  expect((await frame(page)).x).toBe(8);
  await phase(page, 'settings');
  expect((await frame(page)).x).toBe(0);
  expect((await frame(page)).radius).toBe('0px');
  await phase(page, 'workspace');
  await phase(page, 'Toggle mobile');
  expect((await frame(page)).x).toBe(0);
  expect((await frame(page)).y).toBe(0);
  expect((await frame(page)).radius).toBe('0px');
});

for (const mobile of [false, true]) {
  test(`${mobile ? 'phone' : 'compact desktop'} startup follows the real viewport layout family`, async ({
    browser,
  }) => {
    const context = await browser.newContext({
      viewport: { width: mobile ? 390 : 600, height: 800 },
      reducedMotion: 'reduce',
      ...(mobile
        ? {
            isMobile: true,
            userAgent:
              'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148 Safari/604.1',
          }
        : {}),
    });
    try {
      const page = await context.newPage();
      await page.goto(STORY);
      await phase(page, 'workspace');
      await expect(page.locator('[data-lody-boot-shell]')).toHaveAttribute(
        'data-mobile',
        String(mobile)
      );
      await expect(page.locator('[data-lody-boot-shell]')).toHaveAttribute(
        'data-sidebar',
        'hidden'
      );
      expect((await frame(page)).x).toBe(mobile ? 0 : 4);
      expect((await frame(page)).radius).toBe(mobile ? '0px' : '14px');
    } finally {
      await context.close();
    }
  });
}

test('the inline document paints the same workspace frame before any product stylesheet or React runs', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1200, height: 800 });
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto(STORY);
  await page.evaluate(() => {
    history.replaceState(null, '', '/example/chat');
    localStorage.setItem('vite-ui-theme', 'light');
    localStorage.setItem('lody-sidebar-last-width', '280');
    localStorage.setItem('lody-sidebar-collapsed', 'false');
  });
  await page.setContent(
    injectBootShell(
      `<html><head>${BOOT_SHELL_HEAD_MARKER}</head><body><div id="root">${BOOT_SHELL_ROOT_MARKER}</div></body></html>`
    )
  );
  const firstPaint = await frame(page);
  await page.goto(STORY);
  await phase(page, 'workspace');
  expect(await frame(page)).toEqual(firstPaint);
});
