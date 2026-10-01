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
  const navigation = settings.getByRole('navigation', { name: 'Settings' });
  await expect(navigation).toBeVisible();
  const labels = await navigation.locator('button[data-settings-tab-id]').allTextContents();
  await page.setViewportSize({ width: 500, height: 800 });
  const tabs = page.getByRole('tablist', { name: 'Settings' });
  await expect(tabs.getByRole('tab')).toHaveText([
    'Account',
    ...labels.map((label) => label.trim()),
  ]);
  const viewport = page.locator('[data-settings-tab-viewport]');
  await expectInside(tabs.getByRole('tab', { name: 'Agent Roles', exact: true }), viewport);
  await tabs.getByRole('tab', { name: 'About', exact: true }).click();
  await expect(page.getByRole('dialog', { name: 'About', exact: true })).toBeVisible();
  await expectInside(tabs.getByRole('tab', { name: 'About', exact: true }), viewport);
  await tabs.getByRole('tab', { name: 'Agent Roles', exact: true }).click();
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
  await expectInside(tabs.getByRole('tab', { name: 'Agent Roles', exact: true }), viewport);
});

test('scrolls overflow categories without changing the page and supports keyboard tab selection', async ({
  page,
}) => {
  await page.setViewportSize({ width: 500, height: 800 });
  await page.goto(rolesStory);
  const tabs = page.getByRole('tablist', { name: 'Settings' });
  const viewport = page.locator('[data-settings-tab-viewport]');
  const roles = tabs.getByRole('tab', { name: 'Agent Roles', exact: true });
  await expectInside(roles, viewport);
  const previous = page.getByRole('button', { name: 'Previous settings categories' });
  const next = page.getByRole('button', { name: 'Next settings categories' });
  await expect(previous).toBeEnabled();
  await expect(next).toBeEnabled();
  const initialScroll = await viewport.evaluate((el) => el.scrollLeft);
  await previous.click();
  await expect.poll(() => viewport.evaluate((el) => el.scrollLeft)).toBeLessThan(initialScroll);
  await expect(roles).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByRole('dialog', { name: 'Agent Roles', exact: true })).toBeVisible();
  await next.click();
  await expect.poll(() => viewport.evaluate((el) => el.scrollLeft)).toBeGreaterThan(0);
  await roles.focus();
  await page.keyboard.press('ArrowRight');
  const mcp = tabs.getByRole('tab', { name: 'MCP', exact: true });
  await expect(mcp).toBeFocused();
  await expect(mcp).toHaveAttribute('aria-selected', 'true');
  await expectInside(mcp, viewport);
  await page.keyboard.press('ArrowLeft');
  await expect(roles).toBeFocused();
  await expect(roles).toHaveAttribute('aria-selected', 'true');
  await page.keyboard.press('End');
  const about = tabs.getByRole('tab', { name: 'About', exact: true });
  await expect(about).toBeFocused();
  await expect(about).toHaveAttribute('aria-selected', 'true');
  await expectInside(about, viewport);
  await expect(next).toBeDisabled();
  const panelId = await about.getAttribute('aria-controls');
  expect(panelId).toBeTruthy();
  await expect(page.locator(`[id="${panelId}"]`)).toHaveAttribute('role', 'tabpanel');
});

test('keeps the selected category visible in a single row in a short window', async ({ page }) => {
  await page.setViewportSize({ width: 707, height: 394 });
  await page.goto(rolesStory);
  const tabs = page.getByRole('tablist', { name: 'Settings' });
  const viewport = page.locator('[data-settings-tab-viewport]');
  const settings = page.getByRole('dialog', { name: 'Agent Roles', exact: true });
  await expectInside(tabs.getByRole('tab', { name: 'Agent Roles', exact: true }), viewport);
  const categoryRows = await tabs
    .getByRole('tab')
    .evaluateAll((elements) => new Set(elements.map((el) => el.getBoundingClientRect().top)).size);
  expect(categoryRows).toBe(1);
  await expectInside(viewport, settings);
  await expectInside(settings.getByRole('button', { name: 'Add role', exact: true }), settings);
  await tabs.getByRole('tab', { name: 'About', exact: true }).click();
  await expectInside(tabs.getByRole('tab', { name: 'About', exact: true }), viewport);
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
