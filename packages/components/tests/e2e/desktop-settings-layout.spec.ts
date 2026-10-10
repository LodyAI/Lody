import { expect, test, type Locator } from '@playwright/test';

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
    test(`separates Provider quota, forecast and management: ${story}, ${locale}`, async ({
      page,
    }) => {
      await page.goto(
        `/iframe.html?id=codexreset-codexresetforecastentry--${story}&viewMode=story&globals=locale:${locale};theme:dark`
      );
      const quota = page.getByRole('button', { name: /Codex (quota details|额度详情)/ });
      const manage = page.getByRole('button', { name: /Manage Codex|管理 Codex/ });
      const row = quota.locator('xpath=../../..');
      await expectInside(quota, row);
      await expect(quota).toHaveText(/^(Quota details|额度详情)$/);
      await expectInside(manage, row);
      await expect(row.getByText(/Reset forecast|重置预测/)).toHaveCount(0);
      if (story !== 'no-active-watch-with-actions') {
        await expect(row).toContainText(/Remaining|剩余/);
        await expect(row).toContainText('5h');
        await expect(row).toContainText('59%');
        await expect(row).toContainText('7d');
        await expect(row).toContainText('71%');
        await expect(row).not.toContainText('65%');
      }
      await page.evaluate(() => document.fonts.ready);
      const idleQuota = await quota.boundingBox();
      const idleManage = await manage.boundingBox();
      await row.hover();
      expect(await quota.boundingBox()).toEqual(idleQuota);
      expect(await manage.boundingBox()).toEqual(idleManage);
      await quota.focus();
      await page.keyboard.press('Enter');
      const details = page.getByRole('dialog', { name: /Codex (quota details|额度详情)/ });
      await expect(details).toBeVisible();
      if (story !== 'no-active-watch-with-actions') {
        await expect(details.getByRole('progressbar', { name: /5h.*59%/ })).toHaveAttribute(
          'aria-valuenow',
          '59'
        );
        await expect(details.getByRole('progressbar', { name: /7d.*71%/ })).toHaveAttribute(
          'aria-valuenow',
          '71'
        );
      } else {
        await expect(details.getByText(/did not report usage|未提供此套餐/)).toBeVisible();
      }
      await expect(details.getByText(/Third-party reset forecast|第三方重置预测/)).toBeVisible();
      await details.getByRole('button', { name: /^(Reset forecast|重置预测)$/ }).click();
      const forecast = page.getByRole('dialog', { name: /Codex reset forecast|Codex 重置预测/ });
      await expect(forecast).toBeVisible();
      await expect
        .poll(() => forecast.evaluate((el) => el.contains(document.activeElement)))
        .toBe(true);
      await expect(details).toBeHidden();
      if (story !== 'no-active-watch-with-actions') await expect(forecast).toContainText('65%');
      await page.keyboard.press('Escape');
      await expect(forecast).toBeHidden();
      await expect(quota).toBeFocused();
      await manage.click();
      const menu = page.getByRole('menu');
      await expect(menu.getByText('Codex', { exact: true })).toBeVisible();
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
  test(`keeps additional Provider quota windows in details at narrow widths: ${locale}`, async ({
    page,
  }) => {
    await page.goto(
      `/iframe.html?id=settings-providerrow--claude-with-rate-limit-narrow&viewMode=story&globals=locale:${locale};theme:dark`
    );
    const quota = page.getByRole('button', { name: /Claude Code (quota details|额度详情)/ });
    const row = quota.locator('xpath=../../..');
    await expectInside(quota, row);
    await expectInside(
      page.getByRole('button', { name: /Manage Claude Code|管理 Claude Code/ }),
      row
    );
    await expect(row).toContainText('+1');
    await expect(quota).toHaveAccessibleDescription(/5h.*45%.*7d.*68%.*Fable.*33%/);
    await quota.click();
    const details = page.getByRole('dialog', { name: /Claude Code (quota details|额度详情)/ });
    await expect(details.getByRole('progressbar')).toHaveCount(3);
    await expect(details.getByRole('progressbar', { name: /Fable.*33%/ })).toBeVisible();
    await expect(details.getByText(/Reset forecast|重置预测/)).toHaveCount(0);
  });
}
