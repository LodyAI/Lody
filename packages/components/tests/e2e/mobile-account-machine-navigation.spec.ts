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
