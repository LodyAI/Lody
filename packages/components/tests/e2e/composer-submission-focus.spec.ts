import { expect, test } from '@playwright/test';

test('editing a sent message focuses its input with the caret at the end', async ({ page }) => {
  await page.goto('/iframe.html?id=ai-gui-usermessageeditor--from-message-edit&viewMode=story');
  await page.getByRole('button', { name: 'Edit message', exact: true }).click();
  const input = page.getByRole('textbox', { name: 'Edit message', exact: true });
  await expect(input).toBeFocused();
  await page.keyboard.type(' with more detail');
  await expect(input).toHaveValue('Clarify this instruction with more detail');
});

test('editing a queued message places the caret at the end without moving it while typing', async ({
  page,
}) => {
  await page.goto('/iframe.html?id=sessions-messagequeuedisplay--single-item&viewMode=story');
  await page.getByRole('button', { name: 'Edit queued message', exact: true }).click();
  const input = page.getByRole('textbox', { name: 'Edit queued message', exact: true });
  await expect(input).toBeFocused();
  const original = await input.inputValue();
  await page.keyboard.type(' with more detail');
  await expect(input).toHaveValue(`${original} with more detail`);
  await input.evaluate((node: HTMLTextAreaElement) => node.setSelectionRange(0, 0));
  await page.keyboard.type('Updated: ');
  await expect(input).toHaveValue(`Updated: ${original} with more detail`);
});

test.describe('queued editor footer', () => {
  test.use({ hasTouch: true });

  for (const pointer of ['mouse', 'touch'] as const) {
    test(`${pointer} on footer blank space moves the caret to the end; confirm and outside clicks still finish`, async ({
      page,
    }) => {
      await page.goto('/iframe.html?id=sessions-messagequeuedisplay--single-item&viewMode=story');
      const edit = page.getByRole('button', { name: 'Edit queued message', exact: true });
      await edit.click();
      const input = page.getByRole('textbox', { name: 'Edit queued message', exact: true });
      const original = 'First line\nSecond line\nThird line\nFourth line\nLast line';
      await input.fill(original);
      await input.evaluate((node: HTMLTextAreaElement) => {
        node.setSelectionRange(0, 0);
        node.scrollTop = 0;
      });
      const confirm = page.getByRole('button', { name: 'Save changes (Enter)', exact: true });
      const bounds = await confirm.locator('..').boundingBox();
      expect(bounds).not.toBeNull();
      const x = bounds!.x + bounds!.width / 2;
      const y = bounds!.y + bounds!.height - 2;
      if (pointer === 'touch') await page.touchscreen.tap(x, y);
      else await page.mouse.click(x, y);
      await expect(input).toBeFocused();
      expect(await input.evaluate((node) => node.scrollTop)).toBeGreaterThan(0);
      await page.keyboard.type(' with more detail');
      await expect(input).toHaveValue(`${original} with more detail`);
      await confirm.click();
      await expect(input).toHaveCount(0);

      await edit.click();
      await input.fill('Finish on an outside click');
      await page.getByText('Composer placeholder', { exact: true }).click();
      await expect(input).toHaveCount(0);
    });
  }
});

for (const state of ['running-dark', 'idle-dark'] as const) {
  test(`desktop ${state} composer bottom space focuses the prompt`, async ({ page }) => {
    await page.goto(`/iframe.html?id=sessions-sessionchatinputarea--${state}&viewMode=story`);
    const input = page.locator('textarea[data-lody-composer-input]');
    await expect(input).toBeVisible();
    const shell = page.locator('div.relative.shrink-0').filter({ has: input });
    const bounds = await shell.boundingBox();
    expect(bounds).not.toBeNull();
    await input.evaluate((node) => node.blur());
    await page.mouse.click(bounds!.x + bounds!.width / 2, bounds!.y + bounds!.height - 4);
    await expect(input).toBeFocused();
    await page.keyboard.type('Continue with this clarification');
    await expect(input).toHaveValue('Continue with this clarification');
  });
}

for (const source of ['keyboard', 'button'] as const) {
  for (const accepted of [true, false]) {
    test(`desktop ${source} send keeps focus after acceptance=${accepted}`, async ({ page }) => {
      await page.goto(
        '/iframe.html?id=sessions-sessionchatinputarea--deferred-submission&viewMode=story'
      );
      const input = page.locator('textarea[data-lody-composer-input]');
      await input.fill('Synthetic focus regression draft');
      const original = await input.elementHandle();
      if (source === 'keyboard') await input.press('Enter');
      else await page.getByRole('button', { name: 'Send', exact: true }).click();

      await expect(input).toBeDisabled();
      await expect(input).toHaveValue('');
      await expect(input).not.toBeFocused();
      await page.evaluate((result) => {
        window.dispatchEvent(new CustomEvent('storybook:submission-result', { detail: result }));
      }, accepted);

      await expect(input).toBeEnabled();
      await expect(input).toBeFocused();
      await expect(input).toHaveValue(accepted ? '' : 'Synthetic focus regression draft');
      expect(await original!.evaluate((node) => node === document.activeElement)).toBe(true);
      await page.keyboard.type(' Next message');
      await expect(input).toHaveValue(
        accepted ? ' Next message' : 'Synthetic focus regression draft Next message'
      );
    });
  }
}

for (const stopPropagation of [false, true]) {
  test(`completion preserves relinquished focus (stopPropagation=${stopPropagation})`, async ({
    page,
  }) => {
    await page.goto(
      '/iframe.html?id=sessions-sessionchatinputarea--deferred-submission&viewMode=story'
    );
    const input = page.locator('textarea[data-lody-composer-input]');
    await input.fill('Synthetic focus regression draft');
    await input.press('Enter');
    await expect(input).toBeDisabled();
    await page.evaluate((stopFocusPropagation) => {
      const other = document.createElement('input');
      document.body.appendChild(other);
      if (stopFocusPropagation)
        other.addEventListener('focusin', (event) => event.stopPropagation());
      other.focus();
      other.blur();
      other.remove();
      window.dispatchEvent(new CustomEvent('storybook:submission-result', { detail: true }));
    }, stopPropagation);
    await expect(input).toBeEnabled();
    await expect(input).not.toBeFocused();
  });
}

for (const platform of ['desktop', 'narrow-browser', 'wide-native'] as const) {
  test(`landing navigation hands off focus only on desktop (${platform})`, async ({ page }) => {
    if (platform === 'narrow-browser') await page.setViewportSize({ width: 390, height: 844 });
    if (platform === 'wide-native') {
      await page.addInitScript(() => {
        Object.defineProperty(window, '__LODY_NATIVE__', { configurable: true, value: true });
      });
    }
    await page.goto(
      '/iframe.html?id=sessions-sessionchatinputarea--landing-navigation&viewMode=story'
    );
    const input = page.locator('textarea[data-lody-composer-input]');
    await input.fill('Synthetic new conversation');
    await input.press('Enter');
    await expect(page.getByText('Preparing session')).toBeVisible();
    await page.evaluate(() => window.dispatchEvent(new Event('storybook:composer-ready')));
    await expect(input).toBeVisible();
    if (platform === 'desktop') {
      await expect(input).toBeFocused();
      await page.keyboard.type('Continue conversation');
      await expect(input).toHaveValue('Continue conversation');
    } else {
      await expect(input).not.toBeFocused();
    }
    await page.getByRole('button', { name: 'Leave session' }).click();
    await page.getByRole('button', { name: 'Back to session' }).click();
    await expect(page.getByText('Preparing session')).toBeVisible();
    await page.evaluate(() => window.dispatchEvent(new Event('storybook:composer-ready')));
    await expect(input).toBeVisible();
    await expect(input).not.toBeFocused();
  });
}
