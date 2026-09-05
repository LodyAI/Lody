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

test('completion does not reclaim focus after the user moves away and blurs', async ({ page }) => {
  await page.goto(
    '/iframe.html?id=sessions-sessionchatinputarea--deferred-submission&viewMode=story'
  );
  const input = page.locator('textarea[data-lody-composer-input]');
  await input.fill('Synthetic focus regression draft');
  await input.press('Enter');
  await expect(input).toBeDisabled();
  await page.evaluate(() => {
    const other = document.createElement('input');
    document.body.appendChild(other);
    other.focus();
    other.blur();
    other.remove();
    window.dispatchEvent(new CustomEvent('storybook:submission-result', { detail: true }));
  });
  await expect(input).toBeEnabled();
  await expect(input).not.toBeFocused();
});
