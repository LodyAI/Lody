import { expect, test } from '@playwright/test';

for (const locale of ['en', 'zh_CN']) {
  test(`${locale} announces only changed recovery results by id`, async ({ page }) => {
    await page.goto(
      `/iframe.html?id=e2ee-status--recovery-changes&viewMode=story&globals=locale:${locale}`
    );
    const region = page.getByRole('region', {
      name: locale === 'en' ? 'Recovery is partially complete' : '部分恢复已完成',
    });
    const live = region.locator('[aria-live="polite"]');
    const overall = region.getByRole('status').first();
    await expect(region).toBeVisible();
    await expect(live).toBeEmpty();
    await expect(live).toHaveAttribute('aria-atomic', 'true');
    const initialOverall = await overall.textContent();
    await live.evaluate((element) => {
      const updates: string[] = [];
      Reflect.set(element, 'observedUpdates', updates);
      new MutationObserver(() => updates.push(element.textContent ?? '')).observe(element, {
        subtree: true,
        childList: true,
        characterData: true,
      });
    });
    const button = page.getByRole('button', {
      name: locale === 'en' ? 'Apply next example update' : '应用下一次示例更新',
    });
    await button.focus();
    const failed =
      locale === 'en'
        ? 'Example workspace A: Recovery check failed.'
        : '示例工作区甲：恢复检查失败。';
    const verified =
      locale === 'en'
        ? 'Example workspace C: Recovery check passed for key update 4.'
        : '示例工作区丙：第 4 次密钥更新的恢复检查通过。';
    const expected: string[] = [];
    // Same-name IDs change separately, then only reorder, clone unchanged props,
    // update an already-verified row's key evidence, and render unchanged again.
    for (let step = 1; step <= 6; step++) {
      await page.keyboard.press('Enter');
      await expect(page.locator('[data-committed-step]')).toHaveAttribute(
        'data-committed-step',
        String(step)
      );
      if (step <= 2) expected.push(failed);
      if (step === 5) expected.push(verified);
      await expect(live).toHaveText(expected.at(-1)!);
      expect(await live.evaluate((element) => Reflect.get(element, 'observedUpdates'))).toEqual(
        expected
      );
      await expect(button).toBeFocused();
      await expect(overall).toHaveText(initialOverall!);
      if (step <= 2) {
        await expect(
          region
            .getByRole('listitem')
            .filter({ hasText: locale === 'en' ? 'Recovery check failed' : '恢复检查失败' })
        ).toHaveCount(step);
      }
    }
    await expect(region.getByRole('listitem').first()).toContainText(
      locale === 'en' ? 'key update 4' : '第 4 次密钥更新'
    );
  });

  for (const width of [360, 1280]) {
    test(`${locale} states remain readable at ${width}px`, async ({ page }, testInfo) => {
      await page.setViewportSize({ width, height: 900 });
      await page.goto(
        `/iframe.html?id=e2ee-status--all-states&viewMode=story&globals=locale:${locale};theme:${width === 360 ? 'dark' : 'light'}`
      );
      const main = page.getByRole('main');
      await expect(
        main.getByRole('region', {
          name: locale === 'en' ? 'Some content has not arrived' : '部分内容尚未到齐',
        })
      ).toBeVisible();
      await expect(
        main.getByRole('heading', {
          name: locale === 'en' ? 'Waiting for approval' : '等待批准',
          exact: true,
        })
      ).toBeVisible();
      await expect(
        main.getByRole('heading', {
          name: locale === 'en' ? 'Waiting for a key' : '等待获取密钥',
          exact: true,
        })
      ).toBeVisible();
      await expect(main).toContainText(
        locale === 'en'
          ? 'Information saved; recovery not yet verified'
          : '资料已保存，尚未验证恢复'
      );
      await expect(main).toContainText(locale === 'en' ? 'key update 3' : '第 3 次密钥更新');
      await expect(main).toContainText(locale === 'en' ? 'Pending decision:' : '待定：');
      expect(await main.innerText()).not.toContain('e2ee.');
      expect(
        await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)
      ).toBe(true);
      const screenshot = testInfo.outputPath('states.png');
      await page.screenshot({ path: screenshot, fullPage: true });
      await testInfo.attach('states', { path: screenshot, contentType: 'image/png' });
      const partial = main.getByRole('region', {
        name: locale === 'en' ? 'Recovery is partially complete' : '部分恢复已完成',
      });
      await partial.scrollIntoViewIfNeeded();
      await expect(partial).toBeInViewport();
      const recoveryScreenshot = testInfo.outputPath('recovery.png');
      await partial.screenshot({ path: recoveryScreenshot });
      await testInfo.attach('recovery', { path: recoveryScreenshot, contentType: 'image/png' });
      const snapshot = await main.ariaSnapshot();
      expect(snapshot).toContain(locale === 'en' ? 'Recovery by workspace' : '各工作区恢复情况');
      await expect(
        main.getByRole('button', { name: locale === 'en' ? 'Retry' : '重试', exact: true })
      ).toHaveCount(2);
    });
  }

  for (const recovery of [false, true]) {
    test(`${locale} ${recovery ? 'recovery' : 'access'} keyboard retry retains focus and never grants access`, async ({
      page,
    }) => {
      await page.goto(
        `/iframe.html?id=e2ee-status--${recovery ? 'recovery-retry' : 'retry'}&viewMode=story&globals=locale:${locale}`
      );
      const retry = page.getByRole('button', {
        name: locale === 'en' ? 'Retry' : '重试',
        exact: true,
      });
      const finish = page.getByRole('button', {
        name: locale === 'en' ? 'Simulate failed result' : '模拟返回失败',
      });
      await expect(retry).toBeVisible();
      await page.keyboard.press('Tab');
      await expect(retry).toBeFocused();
      await page.keyboard.press('Enter');
      await expect(retry).toBeFocused();
      await expect(retry).toHaveAttribute('aria-disabled', 'true');
      await page.keyboard.press('Enter');
      await expect(page.getByRole('region')).toContainText(
        locale === 'en' ? 'Waiting for a result' : '正在等待结果'
      );
      await page.keyboard.press('Tab');
      await expect(finish).toBeFocused();
      await page.keyboard.press('Space');
      await expect(finish).toBeFocused();
      await expect(retry).not.toHaveAttribute('aria-disabled', 'true');
      await expect(page.getByRole('region')).toContainText(
        recovery
          ? locale === 'en'
            ? 'Recovery could not be completed'
            : '恢复未能完成'
          : locale === 'en'
            ? 'An item could not be verified'
            : '单项内容验证失败'
      );
      await expect(page.getByRole('main')).toContainText(
        locale === 'en' ? 'Example result: still unable to verify' : '示例结果：仍无法验证'
      );
      await page.keyboard.press('Shift+Tab');
      await expect(retry).toBeFocused();
      await page.keyboard.press('Space');
      await expect(retry).toHaveAttribute('aria-disabled', 'true');
    });
  }
}
