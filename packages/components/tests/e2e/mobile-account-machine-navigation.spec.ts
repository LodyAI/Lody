import { expect, test } from '@playwright/test';
import { EDGE_ZONE_PX } from '../../src/components/mobile/mobile-edge-back-swipe';

test.use({ hasTouch: true, isMobile: true, viewport: { width: 393, height: 852 } });

for (const locale of ['zh_CN', 'en']) {
  test(`native Account Manage remains tappable (${locale})`, async ({ page }, testInfo) => {
    await page.goto(
      `/iframe.html?id=mobile-mobilesettingslayout--account-machine-management&viewMode=story&globals=locale:${locale};theme:light`
    );
    const manage = page.getByRole('button', {
      name: locale === 'zh_CN' ? '管理 codex-happy' : 'Manage codex-happy',
      exact: true,
    });
    await expect(manage).toBeVisible();
    // Finish the finite entry animation; do not sample a translated intermediate frame.
    await page.evaluate(async () => {
      await Promise.all(
        document
          .getAnimations()
          .filter((a) => a.effect?.getTiming().iterations !== Infinity)
          .map((a) => a.finished.catch(() => undefined))
      );
    });
    const box = await manage.boundingBox();
    await page.screenshot({ path: testInfo.outputPath('account.png') });
    expect(box).not.toBeNull();
    expect(box!.x).toBeGreaterThanOrEqual(EDGE_ZONE_PX);
    // Keep the gesture strip over the non-control area; do not solve this by removing it.
    expect(
      await page.evaluate(
        ({ y }) => {
          const hit = document.elementFromPoint(1, y);
          return hit instanceof HTMLElement && hit.style.touchAction === 'pan-y';
        },
        { y: box!.y + box!.height / 2 }
      )
    ).toBe(true);
    await manage.tap();
    await expect(page.getByRole('heading', { name: 'codex-happy', exact: true })).toBeVisible();
    await page
      .getByRole('button', { name: locale === 'zh_CN' ? '返回' : 'Back', exact: true })
      .tap();
    await expect(manage).toBeVisible();
    // The unchanged native gesture must still return from machine details.
    await expect(page.locator('.mobile-drill-out')).toHaveCount(0);
    await manage.tap();
    await expect(page.getByRole('heading', { name: 'codex-happy', exact: true })).toBeVisible();
    const cdp = await page.context().newCDPSession(page);
    await cdp.send('Input.dispatchTouchEvent', {
      type: 'touchStart',
      touchPoints: [{ x: 1, y: 300 }],
    });
    for (let x = 6; x <= 121; x += 5) {
      await cdp.send('Input.dispatchTouchEvent', {
        type: 'touchMove',
        touchPoints: [{ x, y: 300 }],
      });
    }
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    await expect(manage).toBeVisible();
    await cdp.detach();
  });
}

test('project Back slides the project page off over home settling in underneath', async ({
  page,
}) => {
  await page.goto(
    '/iframe.html?id=mobile-mobileprojectscreen--back-to-home&viewMode=story&globals=locale:zh_CN;theme:light'
  );
  await page.getByRole('button', { name: /lody/ }).first().tap({ timeout: 60_000 });
  const back = page.getByRole('button', { name: '返回', exact: true });
  await expect(back).toBeVisible();
  await page.evaluate(async () => {
    await Promise.all(
      document
        .getAnimations()
        .filter((a) => a.effect?.getTiming().iterations !== Infinity)
        .map((a) => a.finished.catch(() => undefined))
    );
  });
  // Freeze the page's timers so the exit overlay stays until the test advances time.
  await page.clock.install();
  await back.tap();
  await expect(page.getByTestId('stand-in-home')).toBeVisible();
  // Sample both animations at the same point of their timeline.
  const frame = await page.evaluate(() => {
    const exitPanel = document.querySelector<HTMLElement>('body > * .mobile-drill-out');
    const home = document.querySelector<HTMLElement>('[data-testid="stand-in-home"]');
    const exit = exitPanel?.getAnimations()[0];
    const reveal = home?.getAnimations()[0] as CSSAnimation | undefined;
    if (!exitPanel || !home || !exit || !reveal) return null;
    for (const animation of [exit, reveal]) {
      animation.pause();
      animation.currentTime = 60;
    }
    const homeStyle = getComputedStyle(home);
    return {
      reveal: reveal.animationName,
      exitX: new DOMMatrix(getComputedStyle(exitPanel).transform).m41,
      homeX: new DOMMatrix(homeStyle.transform).m41,
      homeOpacity: Number(homeStyle.opacity),
    };
  });
  expect(frame).not.toBeNull();
  expect(frame!.reveal).toBe('mobile-drill-reveal');
  expect(frame!.exitX).toBeGreaterThan(0);
  expect(frame!.homeX).toBeLessThan(0);
  expect(frame!.homeOpacity).toBeLessThan(1);
  await page.clock.runFor(300);
  await expect(page.locator('.mobile-drill-out')).toHaveCount(0);
  // Home consumed the back flag: opening a project again is a forward push, not a reveal.
  await page.getByRole('button', { name: /lody/ }).first().tap();
  await expect(page.locator('[data-mobile-drill-panel]')).toHaveCount(1);
  await expect(page.locator('[data-mobile-drill-panel]')).not.toHaveClass(/mobile-drill-reveal/);
});
