import { expect, test } from '@playwright/test';

for (const { trigger, query, count } of [
  { trigger: '/', query: 'review', count: 2 },
  { trigger: '$', query: 'imagegen', count: 8 },
]) {
  test(`${trigger} caret measurements preserve the body's positional selector state`, async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(
      '/iframe.html?id=mentions-mentiontwolevelmenu--floating-in-composer&viewMode=story'
    );
    const input = page.getByRole('combobox');
    await expect(input).toBeVisible();
    await page.evaluate(() => {
      const samples: boolean[] = [];
      // Observe the synchronous layout boundary: a MutationObserver runs too late,
      // after the temporary mirror has already been removed. Keep real geometry.
      const original = Element.prototype.getBoundingClientRect;
      Element.prototype.getBoundingClientRect = function () {
        if (this.parentElement === document.documentElement && this.tagName === 'DIV') {
          samples.push(document.body.matches(':last-child'));
        }
        return original.call(this);
      };
      Object.assign(window, { caretBodyTailSamples: samples });
    });

    await input.fill(trigger);
    const menu = page.getByRole('listbox');
    await expect(page.getByRole('option')).toHaveCount(count);
    await input.pressSequentially(query);
    await expect(page.getByRole('option')).toHaveCount(1);
    await input.press('Enter');
    await expect(menu).toBeHidden();
    await expect(input).toHaveValue(`${trigger}${query} `);
    await expect(input).toBeFocused();
    await input.fill('');
    await input.pressSequentially(trigger);
    await expect(page.getByRole('option')).toHaveCount(count);
    await input.press('Escape');
    await expect(menu).toBeHidden();

    const samples = await page.evaluate(
      () => (window as typeof window & { caretBodyTailSamples: boolean[] }).caretBodyTailSamples
    );
    expect(samples.length).toBeGreaterThan(0);
    expect(samples.every(Boolean)).toBe(true);
    await expect(page.locator('html > div')).toHaveCount(0);
  });
}

test('caret geometry survives soft wraps, textarea scroll, transform and zoom', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto(
    '/iframe.html?id=mentions-mentiontwolevelmenu--floating-in-composer&viewMode=story'
  );
  const input = page.getByRole('combobox');
  const frame = page.locator('[data-mention-frame]');
  await frame.evaluate((node: HTMLElement) => {
    Object.assign(node.style, { position: 'fixed', top: '100px', left: '100px', width: '1000px' });
  });
  await input.evaluate((node: HTMLTextAreaElement) => {
    Object.assign(node.style, {
      font: '16px / 20px monospace',
      width: '20ch',
      height: '60px',
      minHeight: '0',
      padding: '0',
      border: '0',
      letterSpacing: '0',
    });
  });
  const menu = page.getByRole('listbox');
  const assertCaret = async (column: number, line: number) => {
    await expect(page.getByRole('option')).toHaveCount(1);
    await expect
      .poll(async () => {
        const expected = await input.evaluate(
          (node: HTMLTextAreaElement, position) => {
            const box = node.getBoundingClientRect();
            const scale = box.height / node.offsetHeight;
            return {
              x: box.x + ((position.column * node.clientWidth) / 20 - node.scrollLeft) * scale,
              y: box.y + ((position.line + 1) * 20 - node.scrollTop) * scale + 8,
            };
          },
          { column, line }
        );
        const actual = await menu.boundingBox();
        return actual
          ? Math.max(Math.abs(actual.x - expected.x), Math.abs(actual.y - expected.y))
          : Infinity;
      })
      .toBeLessThan(2);
  };

  await input.fill('aaaa $imagegen');
  await assertCaret(14, 0);
  await input.fill(`${'word '.repeat(4)}$imagegen`);
  await assertCaret(9, 1);
  await input.fill(`${'a\n'.repeat(6)}$imagegen`);
  await expect.poll(() => input.evaluate((node) => node.scrollTop)).toBeGreaterThan(0);
  await assertCaret(9, 6);
  for (const mode of ['transform', 'zoom']) {
    await frame.evaluate((node: HTMLElement, scaleMode) => {
      node.style.transformOrigin = 'top left';
      node.style.transform = scaleMode === 'transform' ? 'scale(1.25)' : '';
      node.style.zoom = scaleMode === 'zoom' ? '1.25' : '';
    }, mode);
    await assertCaret(9, 6);
  }
  await input.press('Enter');
  await expect(input).toHaveValue(/\$imagegen $/);
  await expect(menu).toBeHidden();
  await expect(input).toBeFocused();
});

test('dialog composer filters and selects a caret menu within the viewport', async ({ page }) => {
  await page.setViewportSize({ width: 800, height: 700 });
  await page.goto('/iframe.html?id=chat-chatcomposer--dialog-mention-stress&viewMode=story');
  const input = page.getByRole('combobox', { name: 'Message' });
  await input.fill('/');
  await expect(page.getByRole('option')).toHaveCount(24);
  await input.pressSequentially('command-23');
  await expect(page.getByRole('option')).toHaveCount(1);
  const menu = page.getByRole('listbox');
  const box = await menu.boundingBox();
  expect(box).not.toBeNull();
  expect(box!.x).toBeGreaterThanOrEqual(0);
  expect(box!.y).toBeGreaterThanOrEqual(0);
  expect(box!.x + box!.width).toBeLessThanOrEqual(800);
  expect(box!.y + box!.height).toBeLessThanOrEqual(700);
  await page.getByRole('option').click();
  await expect(menu).toBeHidden();
  await expect(input).toBeFocused();
});

test('No project session searches preserve candidates and report query misses', async ({
  page,
}) => {
  const phase = process.env.MENTION_SCREENSHOT_PHASE ?? 'after';
  const screenshotDir = process.env.MENTION_SCREENSHOT_DIR;
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.route('**/*', (route) => {
    const url = new URL(route.request().url());
    return url.hostname === '127.0.0.1' || url.hostname === 'localhost'
      ? route.continue()
      : route.abort();
  });
  await page.goto('/iframe.html?id=mentions-sessionmentionsearch--no-project&viewMode=story');
  const input = page.getByRole('combobox', { name: 'Message' });
  await input.fill('@');
  await page.getByRole('option', { name: 'Sessions', exact: true }).click();
  await expect(input).toHaveValue('@session:');
  await expect(page.getByRole('option')).toHaveCount(14);
  await expect(page.getByRole('button', { name: 'No project', exact: true })).toHaveAttribute(
    'aria-pressed',
    'true'
  );

  for (const query of ['zzzzunmatched', 'elsewhere']) {
    await input.fill(`@session:${query}`);
    await expect(page.getByRole('option')).toHaveCount(0);
    if (phase === 'before') {
      await expect(
        page.getByText('There are no other sessions without a project.', { exact: true })
      ).toBeVisible();
    } else {
      await expect(page.getByText(`Nothing matches “${query}”`, { exact: true })).toBeVisible();
      await expect(
        page.getByText('There are no other sessions without a project.', { exact: true })
      ).toHaveCount(0);
    }
    await expect(input).toBeFocused();
    if (screenshotDir) {
      await page.screenshot({
        path: `${screenshotDir}/${phase}-${query}.png`,
        animations: 'disabled',
        caret: 'hide',
      });
    }
    await input.fill('@session:');
    await expect(page.getByRole('option')).toHaveCount(14);
  }

  await input.fill('@session:elsewhere');
  await page.getByRole('button', { name: 'All projects', exact: true }).click();
  await expect(input).toHaveValue('@session:elsewhere');
  await expect(input).toBeFocused();
  await expect(page.getByRole('option', { name: /Elsewhere parser work/ })).toHaveCount(1);
  await input.fill('@session:');
  await expect(page.getByRole('option')).toHaveCount(15);
  await page.getByRole('button', { name: 'No project', exact: true }).click();
  await expect(page.getByRole('option')).toHaveCount(14);
  await expect(input).toBeFocused();
});

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
  await expect
    .poll(async () => {
      const resized = await menu.boundingBox();
      return resized ? resized.x >= 16 && resized.x + resized.width <= 650 : false;
    })
    .toBe(true);
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

for (const width of [960, 650]) {
  test(`Role previews retain list height through hover and scrolling at ${width}px`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 720 });
    await page.goto(
      '/iframe.html?id=mentions-mentiontwolevelmenu--main-composer-role-catalog-at-caret&viewMode=story'
    );
    const input = page.getByRole('combobox', { name: 'composer' });
    await input.fill('@role:');
    const menu = page.getByRole('listbox');
    await expect(page.getByRole('option')).toHaveCount(23);
    await expect.poll(() => menu.evaluate((node) => getComputedStyle(node).opacity)).toBe('1');
    const initialHeight = (await menu.boundingBox())!.height;

    async function expectStableHeight() {
      const heights = await menu.evaluate(
        (node) =>
          new Promise<number[]>((resolve) => {
            const frameHeights: number[] = [];
            const sample = () => {
              frameHeights.push(node.getBoundingClientRect().height);
              if (frameHeights.length === 8) resolve(frameHeights);
              else requestAnimationFrame(sample);
            };
            requestAnimationFrame(sample);
          })
      );
      for (const height of heights) expect(Math.abs(height - initialHeight)).toBeLessThan(0.5);
    }

    for (const name of ['Release Notes', 'Code Reviewer', 'Reviewer 1', 'Reviewer 2']) {
      const row = page.getByRole('option', { name: new RegExp(`^${name} Codex`) });
      await row.hover();
      await expect(row).toHaveAttribute('data-highlighted');
      if (width === 960)
        await expect(menu.locator('header').getByText(name, { exact: true })).toBeVisible();
      await expectStableHeight();
    }

    const last = page.getByRole('option', { name: /^Reviewer 16 Codex/ });
    await last.scrollIntoViewIfNeeded();
    await last.hover();
    await expect(last).toHaveAttribute('data-highlighted');
    await expectStableHeight();
    await input.press('ArrowDown');
    await expect(input).toHaveValue('@role:');
    await expectStableHeight();

    await input.fill('@role:Offline');
    await expect(page.getByRole('option')).toHaveCount(1);
    await expect(page.getByRole('option')).toHaveAttribute('aria-disabled', 'true');
    await input.press('Enter');
    await expect(input).toHaveValue('@role:Offline');

    await input.fill('@role:Release');
    await expect(page.getByRole('option')).toHaveCount(1);
    await page.getByRole('option').click();
    await expect(input).toHaveValue('@Release-Notes ');
  });
}

test.describe('prepared shortcut touch selection', () => {
  test.use({ isMobile: true, hasTouch: true });

  for (const width of [390, 820]) {
    test(`inserts a shortcut after touch focus at ${width}px`, async ({ page }) => {
      await page.setViewportSize({ width, height: 844 });
      await page.goto(
        '/iframe.html?id=mentions-mentiontwolevelmenu--prepared-shortcut&viewMode=story'
      );
      const input = page.getByRole('combobox', { name: 'composer' });
      await input.fill('/review');
      await page.getByRole('option').tap();
      await expect(input).toHaveValue('Review this change');
      await expect(input).toBeFocused();
      await expect(input).toHaveAttribute('aria-expanded', 'false');
    });
  }
});
