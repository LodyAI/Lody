import { expect, test, type Locator } from '@playwright/test';
import { OPEN_SOURCE_ATTRIBUTION_BUNDLE } from '../../src/lib/open-source-attributions.generated';

const rolesStory = '/iframe.html?id=settings-desktopsettingsmodal--agent-roles-tab&viewMode=story';

async function expectInside(element: Locator, container: Locator) {
  await expect(element).toBeVisible();
  const outer = await container.boundingBox();
  const inner = await element.boundingBox();
  expect(outer).not.toBeNull();
  expect(inner).not.toBeNull();
  expect(inner!.x).toBeGreaterThanOrEqual(outer!.x - 1);
  expect(inner!.x + inner!.width).toBeLessThanOrEqual(outer!.x + outer!.width + 1);
  expect(inner!.y).toBeGreaterThanOrEqual(outer!.y - 1);
  expect(inner!.y + inner!.height).toBeLessThanOrEqual(outer!.y + outer!.height + 1);
}

for (const viewportSize of [
  { width: 1180, height: 800 },
  { width: 707, height: 394 },
  { width: 400, height: 360 },
]) {
  test(`scrolls to the last open-source notice at ${viewportSize.width}×${viewportSize.height}`, async ({
    page,
  }) => {
    await page.setViewportSize(viewportSize);
    await page.goto(
      '/iframe.html?id=settings-desktopsettingsmodal--about-tab&viewMode=story&globals=locale:en'
    );
    const about = page.getByRole('dialog', { name: 'About', exact: true });
    await about.getByRole('button', { name: 'Open Source Licenses', exact: true }).click();
    const notices = page.getByRole('dialog', { name: 'Open Source Licenses', exact: true });
    await expect(notices).toBeVisible();
    const viewport = notices.locator('[data-radix-scroll-area-viewport]');
    await expect
      .poll(() =>
        viewport.evaluate((el) => el.clientHeight > 0 && el.scrollHeight > el.clientHeight)
      )
      .toBe(true);
    await expectInside(viewport, notices);
    await expectInside(notices, page.locator('body'));

    await viewport.hover();
    await page.mouse.wheel(0, 500);
    await expect.poll(() => viewport.evaluate((el) => el.scrollTop)).toBeGreaterThan(0);
    await viewport.evaluate((el) => {
      el.scrollTop = el.scrollHeight;
    });
    const bundled = OPEN_SOURCE_ATTRIBUTION_BUNDLE.entries.filter(
      (entry) => entry.kind === 'vendored'
    );
    await expect(notices.getByText(bundled.at(-1)!.name, { exact: true })).toBeInViewport({
      ratio: 1,
    });

    await notices.getByRole('button', { name: /^Dependencies/ }).click();
    const mitEntries = OPEN_SOURCE_ATTRIBUTION_BUNDLE.entries.filter(
      (entry) => entry.kind === 'package' && entry.license === 'MIT'
    );
    await notices.getByRole('combobox').click();
    await page.getByRole('option', { name: `MIT (${mitEntries.length})`, exact: true }).click();
    await viewport.evaluate((el) => {
      el.scrollTop = el.scrollHeight;
    });
    await expect(notices.getByText(mitEntries.at(-1)!.name, { exact: true })).toBeInViewport({
      ratio: 1,
    });
    await expectInside(notices.getByRole('button', { name: 'Close', exact: true }), notices);
    await page.keyboard.press('Escape');
    await expect(notices).toBeHidden();
    await expect(
      about.getByRole('button', { name: 'Open Source Licenses', exact: true })
    ).toBeFocused();
  });
}

for (const width of [400, 500, 707, 900, 1180]) {
  test(`keeps Role content and actions inside the settings panel at ${width}px`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 800 });
    await page.goto(rolesStory);
    const settings = page.getByRole('dialog', { name: 'Agent Roles', exact: true });
    const add = settings.getByRole('button', { name: 'Add role', exact: true });
    await expectInside(add, settings);
    await expectInside(settings.getByRole('button', { name: 'Remove', exact: true }), settings);
    const name = settings.getByText('Code Reviewer', { exact: true });
    await expectInside(name, settings);
    await expect(name).toHaveJSProperty('scrollWidth', await name.evaluate((el) => el.clientWidth));
    await expectInside(settings.getByText('Prompt', { exact: true }), settings);
    await expectInside(settings.getByRole('button', { name: 'Close', exact: true }), settings);
    await add.click();
    await expect(page.getByRole('dialog', { name: 'New Agent Role', exact: true })).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(settings).toBeVisible();
  });
}

test('offers every existing navigation entry and keeps the editor draft across resizes', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1180, height: 800 });
  await page.goto(rolesStory);
  const settings = page.getByRole('dialog', { name: 'Agent Roles', exact: true });
  const navigation = page.getByRole('navigation', { name: 'Settings' });
  await expect(navigation).toBeVisible();
  const labels = await navigation.locator('button[data-settings-tab-id]').allTextContents();
  await page.setViewportSize({ width: 500, height: 800 });
  // The same navigation stays mounted; it just answers with its icon rail.
  const entries = await navigation.locator('button[data-settings-tab-id]').allTextContents();
  expect(entries.map((label) => label.trim())).toEqual(labels.map((label) => label.trim()));
  const railBox = await navigation.boundingBox();
  expect(railBox).not.toBeNull();
  expect(railBox!.width).toBeLessThanOrEqual(60);
  const viewport = page.locator('[data-settings-nav-viewport]');
  const roles = navigation.locator('button[data-settings-tab-id="agent-roles"]');
  await expectInside(roles, viewport);
  const about = navigation.locator('button[data-settings-tab-id="about"]');
  await about.click();
  await expect(page.getByRole('dialog', { name: 'About', exact: true })).toBeVisible();
  await expect(about).toHaveAttribute('aria-current', 'page');
  await expectInside(about, viewport);
  await roles.click();
  await settings.getByRole('button', { name: 'Edit', exact: true }).click();
  const editor = page.getByRole('dialog', { name: 'Edit Agent Role', exact: true });
  const name = editor.getByRole('textbox', { name: 'Name', exact: true });
  await name.fill('Draft survives resize');
  await page.setViewportSize({ width: 1180, height: 800 });
  await expect(name).toHaveValue('Draft survives resize');
  await page.setViewportSize({ width: 500, height: 800 });
  await expect(name).toHaveValue('Draft survives resize');
  await expectInside(editor, page.locator('body'));
  await page.keyboard.press('Escape');
  await expect(editor).toBeHidden();
  await expect(settings).toBeVisible();
  await expectInside(roles, viewport);
});

test('scrolls overflow categories on the rail without changing the page and supports arrow keys', async ({
  page,
}) => {
  // A short window overflows the icon rail; the rail scrolls vertically.
  await page.setViewportSize({ width: 500, height: 360 });
  await page.goto(rolesStory);
  const navigation = page.getByRole('navigation', { name: 'Settings' });
  const viewport = page.locator('[data-settings-nav-viewport]');
  const roles = navigation.locator('button[data-settings-tab-id="agent-roles"]');
  await expectInside(roles, viewport);
  const canScroll = await viewport.evaluate((el) => el.scrollHeight > el.clientHeight);
  expect(canScroll).toBe(true);
  const initialScroll = await viewport.evaluate((el) => el.scrollTop);
  await viewport.evaluate((el) => {
    el.scrollTop = el.scrollHeight;
  });
  await expect.poll(() => viewport.evaluate((el) => el.scrollTop)).toBeGreaterThan(initialScroll);
  // Scrolling the rail alone changes neither the selection nor the page.
  await expect(roles).toHaveAttribute('aria-current', 'page');
  await expect(page.getByRole('dialog', { name: 'Agent Roles', exact: true })).toBeVisible();
  await roles.click();
  await page.keyboard.press('ArrowDown');
  const mcp = navigation.locator('button[data-settings-tab-id="mcp"]');
  await expect(mcp).toBeFocused();
  await expect(mcp).toHaveAttribute('aria-current', 'page');
  await page.keyboard.press('ArrowUp');
  await expect(roles).toBeFocused();
  await expect(roles).toHaveAttribute('aria-current', 'page');
  await page.keyboard.press('End');
  const about = navigation.locator('button[data-settings-tab-id="about"]');
  await expect(about).toBeFocused();
  await expect(about).toHaveAttribute('aria-current', 'page');
  // Selecting below the fold reveals the row inside the rail, not the page.
  await expectInside(about, viewport);
  await expect(page.getByRole('dialog', { name: 'About', exact: true })).toBeVisible();
});

test('moves through sidebar categories with arrow keys inside the dialog', async ({ page }) => {
  await page.setViewportSize({ width: 1180, height: 800 });
  await page.goto(rolesStory);
  const navigation = page.getByRole('navigation', { name: 'Settings' });
  const roles = navigation.locator('button[data-settings-tab-id="agent-roles"]');
  await roles.click();
  // A dialog popup stops composite keys at the portal edge; the scope element
  // still has to move the selection on them.
  await page.keyboard.press('ArrowDown');
  const mcp = navigation.locator('button[data-settings-tab-id="mcp"]');
  await expect(mcp).toBeFocused();
  await expect(mcp).toHaveAttribute('aria-current', 'page');
  await expect(page.getByRole('dialog', { name: 'MCP', exact: true })).toBeVisible();
  await page.keyboard.press('ArrowUp');
  await expect(roles).toBeFocused();
  await expect(roles).toHaveAttribute('aria-current', 'page');
  await page.keyboard.press('End');
  const about = navigation.locator('button[data-settings-tab-id="about"]');
  await expect(about).toBeFocused();
  await expect(about).toHaveAttribute('aria-current', 'page');
});

test('keeps the selected category visible in a single column in a short window', async ({
  page,
}) => {
  await page.setViewportSize({ width: 707, height: 394 });
  await page.goto(rolesStory);
  const navigation = page.getByRole('navigation', { name: 'Settings' });
  const viewport = page.locator('[data-settings-nav-viewport]');
  const settings = page.getByRole('dialog', { name: 'Agent Roles', exact: true });
  await expectInside(navigation.locator('button[data-settings-tab-id="agent-roles"]'), viewport);
  const categoryRows = await navigation
    .locator('button[data-settings-tab-id]')
    .evaluateAll((elements) => new Set(elements.map((el) => el.getBoundingClientRect().left)).size);
  expect(categoryRows).toBe(1);
  await expectInside(viewport, settings);
  await expectInside(settings.getByRole('button', { name: 'Add role', exact: true }), settings);
  await navigation.locator('button[data-settings-tab-id="about"]').click();
  await expectInside(navigation.locator('button[data-settings-tab-id="about"]'), viewport);
});

test('keeps nested Role editor focus contained and short-height scrolling above its footer', async ({
  page,
}) => {
  await page.setViewportSize({ width: 707, height: 394 });
  await page.goto(rolesStory);
  const settings = page.getByRole('dialog', { name: 'Agent Roles', exact: true });
  const edit = settings.getByRole('button', { name: 'Edit', exact: true });
  await edit.click();
  const editor = page.getByRole('dialog', { name: 'Edit Agent Role', exact: true });
  await expect(editor).toBeVisible();
  const cancel = editor.getByRole('button', { name: 'Cancel', exact: true });
  const save = editor.getByRole('button', { name: 'Save', exact: true });
  await expectInside(cancel, editor);
  await expectInside(save, editor);

  const focusable = editor.locator(
    'button:enabled, input:enabled, textarea:enabled, [role="switch"]'
  );
  const first = focusable.first();
  const last = focusable.last();
  await first.focus();
  await page.keyboard.press('Shift+Tab');
  await expect(last).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(first).toBeFocused();

  const scroller = editor.locator('form > div').first();
  await expect.poll(() => scroller.evaluate((el) => el.scrollHeight > el.clientHeight)).toBe(true);
  await scroller.evaluate((el) => {
    el.scrollTop = el.scrollHeight;
  });
  await expect.poll(() => scroller.evaluate((el) => el.scrollTop)).toBeGreaterThan(0);
  await expectInside(editor.getByRole('switch', { name: 'Share with workspace' }), editor);
  await expectInside(cancel, editor);
  await expectInside(save, editor);
  await page.keyboard.press('Escape');
  await expect(editor).toBeHidden();
  await expect(settings).toBeVisible();
  await expect(edit).toBeFocused();
});

test('fits translated header actions in a narrow dark settings panel', async ({ page }) => {
  await page.setViewportSize({ width: 500, height: 800 });
  await page.goto(`${rolesStory}&globals=locale:zh_CN;theme:dark`);
  const settings = page.getByRole('dialog', { name: 'Agent 角色', exact: true });
  await expectInside(settings.getByRole('button', { name: '添加角色', exact: true }), settings);
  await expectInside(settings.getByRole('button', { name: '关闭', exact: true }), settings);
});

for (const locale of ['en', 'zh_CN']) {
  for (const story of [
    'active-forecast-with-actions',
    'active-forecast-narrow-with-actions',
    'no-active-watch-with-actions',
  ]) {
    test(`opens the Provider forecast directly and keeps quota separate: ${story}, ${locale}`, async ({
      page,
    }) => {
      await page.goto(
        `/iframe.html?id=codexreset-codexresetforecastentry--${story}&viewMode=story&globals=locale:${locale};theme:dark`
      );
      const entry = page.getByRole('button', { name: /^(Reset forecast|重置预测)$/ });
      const manage = page.getByRole('button', { name: /Manage Codex|管理 Codex/ });
      const row = entry.locator('xpath=../../..');
      await expectInside(entry, row);
      await expectInside(manage, row);
      await expect(page.getByRole('button', { name: /quota details|额度详情/ })).toHaveCount(0);
      await expect(page.getByRole('dialog')).toHaveCount(0);
      const quota = row.getByRole('group', { name: /Codex (remaining quota|剩余额度)/ });
      if (story !== 'no-active-watch-with-actions') {
        await expect(quota).toContainText(/Remaining|剩余/);
        await expect(quota.getByRole('meter', { name: /5h.*59%/ })).toHaveAttribute(
          'aria-valuenow',
          '59'
        );
        await expect(quota.getByRole('meter', { name: /7d.*71%/ })).toHaveAttribute(
          'aria-valuenow',
          '71'
        );
      } else {
        await expect(quota).toHaveCount(0);
      }
      await expect(row).not.toContainText('65%');
      await page.evaluate(() => document.fonts.ready);
      if (story === 'active-forecast-with-actions') {
        const baselines = await row.evaluate((el) => {
          const group = el.querySelector('[role="group"]')!;
          const button = el.querySelector('button[aria-haspopup="dialog"]')!;
          const labels = [
            group.firstElementChild!,
            ...Array.from(group.querySelectorAll('[role="meter"]')).flatMap((meter) => [
              meter.firstElementChild!,
              meter.lastElementChild!,
            ]),
            button.querySelector('span')!,
          ];
          // A zero-size inline marker sits on the actual text baseline,
          // unlike the center or bottom of a font's bounding rectangle.
          return labels.map((label) => {
            const marker = document.createElement('span');
            marker.style.cssText =
              'display:inline-block;width:0;height:0;padding:0;margin:0;border:0;vertical-align:baseline;';
            label.append(marker);
            const baseline = marker.getBoundingClientRect().top;
            marker.remove();
            return baseline;
          });
        });
        expect(baselines).toHaveLength(6);
        expect(Math.max(...baselines) - Math.min(...baselines)).toBeLessThan(0.25);
      }
      const idleEntry = await entry.boundingBox();
      const idleManage = await manage.boundingBox();
      await row.hover();
      expect(await entry.boundingBox()).toEqual(idleEntry);
      expect(await manage.boundingBox()).toEqual(idleManage);
      await entry.focus();
      await page.keyboard.press('Enter');
      const forecast = page.getByRole('dialog', { name: /Codex reset forecast|Codex 重置预测/ });
      await expect(forecast).toBeVisible();
      await expect(page.getByRole('dialog')).toHaveCount(1);
      await expect
        .poll(() => forecast.evaluate((el) => el.contains(document.activeElement)))
        .toBe(true);
      if (story !== 'no-active-watch-with-actions') await expect(forecast).toContainText('65%');
      await page.keyboard.press('Escape');
      await expect(forecast).toBeHidden();
      await expect(entry).toBeFocused();
      await entry.click();
      await expect(forecast).toBeVisible();
      await page.keyboard.press('Escape');
      await expect(forecast).toBeHidden();
      await manage.click();
      const menu = page.getByRole('menu');
      await expect(menu.getByText('Codex', { exact: true })).toHaveCount(0);
      await expect(menu.getByRole('menuitem')).toHaveCount(2);
      await menu.getByRole('menuitem', { name: /Refresh models and modes|刷新模型和模式/ }).click();
      await expect(page.getByRole('status', { name: 'Provider action result' })).toHaveText(
        'Refreshed Codex'
      );
      await manage.click();
      await page.getByRole('menuitem', { name: /^(Delete|删除)$/ }).click();
      await expect(page.getByRole('alertdialog')).toBeVisible();
      await expect(page.getByRole('alertdialog')).toContainText('Codex');
    });
  }
}

for (const locale of ['en', 'zh_CN']) {
  test(`shows every Provider quota window at narrow widths: ${locale}`, async ({ page }) => {
    await page.goto(
      `/iframe.html?id=settings-providerrow--claude-with-rate-limit-narrow&viewMode=story&globals=locale:${locale};theme:dark`
    );
    const manage = page.getByRole('button', { name: /Manage Claude Code|管理 Claude Code/ });
    await expect(manage).toBeVisible();
    const row = manage.locator('xpath=../..');
    const quota = row.getByRole('group', { name: /Claude Code (remaining quota|剩余额度)/ });
    await expectInside(quota, row);
    await expectInside(manage, row);
    await expect(quota.getByRole('meter')).toHaveCount(3);
    for (const meter of await quota.getByRole('meter').all()) await expectInside(meter, row);
    await expect(quota.getByRole('meter', { name: /Fable.*33%/ })).toBeVisible();
    await expect(
      row.getByRole('button', { name: /quota details|额度详情|Reset forecast|重置预测/ })
    ).toHaveCount(0);
  });
}

for (const { locale, triggerName, onlineName, mineName } of [
  { locale: 'en', triggerName: 'Filter machines', onlineName: 'Online', mineName: 'My machines' },
  { locale: 'zh_CN', triggerName: '过滤机器', onlineName: '在线', mineName: '我的机器' },
]) {
  test(`machine filters keep labels unindented in a compact menu (${locale})`, async ({ page }) => {
    await page.setViewportSize({ width: 900, height: 600 });
    await page.goto(
      `/iframe.html?id=settings-machinetablist--default&viewMode=story&globals=theme:dark;locale:${locale}`
    );
    const trigger = page.getByRole('button', { name: triggerName, exact: true });
    const machines = page.locator('button[data-settings-machine-id]');
    await expect(machines).toHaveCount(4);
    await trigger.click();
    const menu = page.getByRole('menu');
    const online = menu.getByRole('menuitemcheckbox', { name: onlineName, exact: true });
    const mine = menu.getByRole('menuitemcheckbox', { name: mineName, exact: true });
    await expect(online).toBeVisible();
    await expect(mine).toHaveAttribute('aria-checked', 'false');
    const box = await menu.boundingBox();
    expect(box!.width).toBeLessThanOrEqual(182);
    expect(box!.height).toBeLessThanOrEqual(72);
    const labelLeft = await online.evaluate(
      (row) => row.firstElementChild!.getBoundingClientRect().left
    );
    expect(labelLeft - box!.x).toBeLessThanOrEqual(14);
    await online.click();
    await expect(online).toHaveAttribute('aria-checked', 'true');
    await expect(machines).toHaveCount(2);
    await expect(online.locator(':scope > span:last-child svg')).toBeVisible();
    expect(
      await online.evaluate((row) => row.firstElementChild!.getBoundingClientRect().left)
    ).toBe(labelLeft);
    await mine.click();
    await expect(mine).toHaveAttribute('aria-checked', 'true');
    await expect(machines).toHaveCount(1);
    await page.keyboard.press('ArrowUp');
    await expect(online).toBeFocused();
    await page.keyboard.press('Space');
    await expect(online).toHaveAttribute('aria-checked', 'false');
    await expect(machines).toHaveCount(2);
    await page.keyboard.press('Escape');
    await expect(menu).toBeHidden();
    await trigger.click();
    await expect(mine).toHaveAttribute('aria-checked', 'true');
    await mine.click();
    await expect(machines).toHaveCount(4);
    await expect(menu).toBeVisible();
  });
}
