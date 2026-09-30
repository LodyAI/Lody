import { expect, test } from '@playwright/test';

test('session command menu follows the caret while opening above it', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/iframe.html?id=chat-chatcomposer--session-mention-stress&viewMode=story');

  const input = page.getByRole('combobox', { name: 'Message' });
  await input.click();
  await page.keyboard.type('/');
  const menu = page.getByRole('listbox');
  await expect(menu).toBeVisible();
  const initial = await menu.boundingBox();
  expect(initial).not.toBeNull();

  await page.keyboard.type('command-23');
  await expect(page.getByRole('option')).toHaveCount(1);
  await expect(input).toBeFocused();
  const moved = await menu.boundingBox();
  expect(moved).not.toBeNull();

  if (process.env.MENTION_SCREENSHOT_PHASE) {
    await page.screenshot({
      path: `${process.env.MENTION_SCREENSHOT_PHASE}-session-caret.png`,
      animations: 'disabled',
    });
  }

  expect(moved!.x).toBeGreaterThan(initial!.x + 30);
  const inputBox = await input.boundingBox();
  expect(inputBox).not.toBeNull();
  expect(moved!.y + moved!.height).toBeLessThan(inputBox!.y + 40);
});

test('a wide desktop composer keeps a long menu inside its own width', async ({ page }) => {
  await page.setViewportSize({ width: 2048, height: 1098 });
  await page.goto('/iframe.html?id=chat-chatcomposer--session-mention-wide-dark&viewMode=story');
  const input = page.getByRole('combobox', { name: 'Message' });
  await input.click();
  await page.keyboard.type('/');

  const menu = page.getByRole('listbox');
  const first = page.getByRole('option').first();
  await expect(first).toBeVisible();
  await expect(page.getByRole('option')).toHaveCount(24);
  const menuBox = await menu.boundingBox();
  const firstBox = await first.boundingBox();
  const inputBox = await input.boundingBox();
  const frameBox = await page.locator('[data-mention-frame]').boundingBox();
  expect(menuBox).not.toBeNull();
  expect(firstBox).not.toBeNull();
  expect(inputBox).not.toBeNull();
  expect(frameBox).not.toBeNull();

  if (process.env.MENTION_SCREENSHOT_PHASE) {
    await page.screenshot({
      path: `${process.env.MENTION_SCREENSHOT_PHASE}-wide-desktop.png`,
      animations: 'disabled',
    });
  }

  expect(menuBox!.width).toBeLessThanOrEqual(inputBox!.width + 1);
  expect(menuBox!.x + menuBox!.width).toBeLessThanOrEqual(frameBox!.x + frameBox!.width + 1);
  expect(menuBox!.y).toBeGreaterThanOrEqual(16);
  expect(menuBox!.y + menuBox!.height).toBeLessThan(inputBox!.y + 40);
  expect(firstBox!.y + firstBox!.height).toBeLessThanOrEqual(menuBox!.y + menuBox!.height);

  for (let index = 0; index < 18; index += 1) await page.keyboard.press('ArrowDown');
  await expect
    .poll(() =>
      menu.evaluate((node) =>
        Array.from(node.querySelectorAll('div')).some(
          (child) => child.scrollHeight > child.clientHeight + 10 && child.scrollTop > 0
        )
      )
    )
    .toBe(true);
  await expect(input).toBeFocused();
  await page.keyboard.type('command-23');
  await expect(page.getByRole('option')).toHaveCount(1);
  await page.keyboard.press('Enter');
  await expect(input).toBeFocused();
  await expect(menu).toBeHidden();
});

test('a tall command list stays above the caret while filtering at desktop height', async ({
  page,
}) => {
  await page.setViewportSize({ width: 800, height: 600 });
  await page.goto('/iframe.html?id=chat-chatcomposer--session-mention-stress&viewMode=story');
  await page.locator('#storybook-root > div > div').evaluate((layout: HTMLElement) => {
    layout.style.justifyContent = 'flex-start';
    layout.style.paddingTop = '220px';
  });

  const input = page.getByRole('combobox', { name: 'Message' });
  await input.click();
  await page.keyboard.type('/');
  const menu = page.getByRole('listbox');
  await expect(page.getByRole('option')).toHaveCount(24);
  const caretBox = await input.boundingBox();
  const initialMenu = await menu.boundingBox();
  const firstOption = await page.getByRole('option').first().boundingBox();
  expect(caretBox).not.toBeNull();
  expect(initialMenu).not.toBeNull();
  expect(firstOption).not.toBeNull();
  expect(initialMenu!.y + initialMenu!.height).toBeLessThan(caretBox!.y + 40);
  expect(initialMenu!.y).toBeGreaterThanOrEqual(8);
  expect(firstOption!.y).toBeGreaterThanOrEqual(initialMenu!.y);

  if (process.env.MENTION_SCREENSHOT_PHASE) {
    await page.screenshot({
      path: `${process.env.MENTION_SCREENSHOT_PHASE}-top-cap.png`,
      animations: 'disabled',
    });
  }

  for (let index = 0; index < 18; index += 1) await page.keyboard.press('ArrowDown');
  await expect
    .poll(() =>
      menu.evaluate((node) =>
        [node, ...Array.from(node.querySelectorAll('div'))].some(
          (element) => element.scrollHeight > element.clientHeight + 10 && element.scrollTop > 0
        )
      )
    )
    .toBe(true);
  await expect(input).toBeFocused();

  await page.keyboard.type('command-2');
  await expect(page.getByRole('option')).toHaveCount(7);
  const filteredMenu = await menu.boundingBox();
  expect(filteredMenu).not.toBeNull();
  expect(filteredMenu!.y + filteredMenu!.height).toBeLessThan(caretBox!.y + 40);
  await expect(input).toBeFocused();

  for (let index = 0; index < 'command-2'.length; index += 1) {
    await page.keyboard.press('Backspace');
  }
  await expect(page.getByRole('option')).toHaveCount(24);
  await expect
    .poll(async () => {
      const currentMenu = await menu.boundingBox();
      return currentMenu ? currentMenu.y + currentMenu.height < caretBox!.y + 40 : false;
    })
    .toBe(true);
});

test('the open session menu tracks editor scale and window resize', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/iframe.html?id=chat-chatcomposer--session-mention-stress&viewMode=story');
  const input = page.getByRole('combobox', { name: 'Message' });
  await input.click();
  await page.keyboard.type('/command-23');
  const menu = page.getByRole('listbox');
  await expect(menu).toBeVisible();
  const before = await menu.boundingBox();
  expect(before).not.toBeNull();

  await page.locator('[data-mention-frame]').evaluate((frame: HTMLElement) => {
    frame.style.zoom = '1.5';
  });
  await expect.poll(async () => (await menu.boundingBox())?.x).toBeGreaterThan(before!.x + 30);
  const scaled = await menu.boundingBox();
  const scaledInput = await input.boundingBox();
  expect(scaled).not.toBeNull();
  expect(scaledInput).not.toBeNull();
  expect(scaled!.y + scaled!.height).toBeLessThan(scaledInput!.y + 20);

  await page.locator('[data-mention-frame]').evaluate((frame: HTMLElement) => {
    frame.style.zoom = '';
  });
  await page.setViewportSize({ width: 650, height: 600 });
  await expect(menu).toBeVisible();
  const resized = await menu.boundingBox();
  expect(resized).not.toBeNull();
  expect(resized!.x).toBeGreaterThanOrEqual(16);
  expect(resized!.x + resized!.width).toBeLessThanOrEqual(650);
  await expect(input).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(menu).toBeHidden();
});

test('a caret against the top edge falls back below until room appears above', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/iframe.html?id=chat-chatcomposer--session-mention-stress&viewMode=story');
  const layout = page.locator('#storybook-root > div > div');
  await layout.evaluate((node: HTMLElement) => {
    node.style.justifyContent = 'flex-start';
  });
  const input = page.getByRole('combobox', { name: 'Message' });
  await input.click();
  await page.keyboard.type('/');
  const menu = page.getByRole('listbox');
  await expect(page.getByRole('option').first()).toBeVisible();
  await expect.poll(async () => (await menu.boundingBox())?.y).toBeGreaterThan(30);

  await layout.evaluate((node: HTMLElement) => {
    node.style.justifyContent = 'flex-end';
  });
  await expect
    .poll(async () => {
      const menuBox = await menu.boundingBox();
      const inputBox = await input.boundingBox();
      return menuBox && inputBox ? menuBox.y + menuBox.height < inputBox.y : false;
    })
    .toBe(true);
  await expect(input).toBeFocused();
});

test('inline editor keeps a floating menu and focus through category selection', async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 640 });
  await page.goto('/iframe.html?id=ai-gui-usermessageeditor--with-mentions&viewMode=story');
  const input = page.getByRole('combobox', { name: 'Message' });
  await input.click();
  await page.keyboard.type('@');
  const menu = page.getByRole('listbox');
  await expect(menu).toBeVisible();
  const box = await menu.boundingBox();
  expect(box).not.toBeNull();
  expect(box!.x).toBeGreaterThanOrEqual(0);
  expect(box!.x + box!.width).toBeLessThanOrEqual(390);
  await page.getByRole('option', { name: 'Sessions' }).click();
  await expect(input).toBeFocused();
  await expect(input).toHaveValue(/@session:$/);
  await page.getByRole('option', { name: /Fix flaky scroll tests/ }).click();
  await expect(menu).toBeHidden();
  await expect(input).toBeFocused();
  await expect(input).toHaveValue(/@Fix-flaky-scroll-tests /);
});
