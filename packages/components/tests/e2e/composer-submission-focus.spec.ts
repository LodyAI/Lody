import { expect, test } from '@playwright/test';

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
