import { expect, test } from '@playwright/test';

for (const openWith of ['click', 'keyboard'] as const) {
  test(`project search receives focus on ${openWith} and on reopening`, async ({ page }) => {
    await page.goto('/iframe.html?id=chat-unifiedprojectselector--selected-private&viewMode=story');
    const trigger = page.getByRole('button', { name: 'lody', exact: true });
    const search = page.getByPlaceholder('Search projects', { exact: true });
    for (let opening = 0; opening < 2; opening += 1) {
      if (openWith === 'keyboard') {
        await trigger.focus();
        await page.keyboard.press('Enter');
      } else {
        await trigger.click();
      }
      await expect(search).toBeFocused();
      await expect(search).toHaveValue('');
      await page.getByRole('menuitem').first().hover();
      await page.keyboard.type('loro-inspector');
      await expect(search).toHaveValue('loro-inspector');
      await expect(
        page.getByRole('menuitem', { name: 'loro-inspector', exact: true })
      ).toBeVisible();
      await expect(page.getByRole('menuitem')).toHaveCount(4);
      await page.keyboard.press('Escape');
      await expect(search).toBeHidden();
    }
  });
}

for (const openWith of ['hover', 'click', 'keyboard'] as const) {
  test(`model search receives focus on ${openWith} and on reopening`, async ({ page }) => {
    await page.goto('/iframe.html?id=sessions-composerrunconfigmenu--model-search&viewMode=story');
    const search = page.getByRole('textbox', { name: 'Search models', exact: true });
    // The story opens the submenu for its preview. Start our interactions closed.
    await expect(search).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(search).toBeHidden();
    const trigger = page.getByRole('button', { name: 'Run configuration', exact: true });
    const model = page.getByRole('menuitem', { name: /^Model/ });
    for (let opening = 0; opening < 2; opening += 1) {
      await trigger.click();
      if (openWith === 'keyboard') {
        await model.focus();
        await page.keyboard.press('ArrowRight');
      } else if (openWith === 'click') {
        await model.click();
      } else {
        await model.hover();
      }
      await expect(search).toBeFocused();
      if (openWith !== 'keyboard') {
        // A real pointer keeps moving over the trigger after the submenu opens.
        await model.hover({ position: { x: 12, y: 12 } });
        if (openWith === 'click') await model.click({ position: { x: 12, y: 12 } });
        await expect(search).toBeFocused();
      }
      await page.keyboard.type('54m');
      await expect(search).toHaveValue('54m');
      const match = page.getByRole('menuitemradio');
      await expect(match).toHaveText(['5.4-mini']);
      await page.keyboard.press('ArrowDown');
      await expect(match).toBeFocused();
      await page.keyboard.press('Escape');
      await expect(search).toBeHidden();
      await expect(trigger).toHaveAttribute('aria-expanded', 'false');
      await page.mouse.move(0, 0);
    }
  });
}

test.describe('model search on touch', () => {
  test.use({ hasTouch: true });

  test('opening the submenu does not autofocus until the field is tapped', async ({ page }) => {
    await page.goto('/iframe.html?id=sessions-composerrunconfigmenu--model-search&viewMode=story');
    const search = page.getByRole('textbox', { name: 'Search models', exact: true });
    await expect(search).toBeVisible();
    await page.keyboard.press('Escape');
    await page.getByRole('button', { name: 'Run configuration', exact: true }).tap();
    const model = page.getByRole('menuitem', { name: /^Model/ });
    await model.tap();
    await expect(search).toBeVisible();
    await expect(search).not.toBeFocused();
    await model.tap();
    await expect(search).not.toBeFocused();
    await search.tap();
    await page.keyboard.type('54m');
    await expect(search).toHaveValue('54m');
    await expect(page.getByRole('menuitemradio')).toHaveText(['5.4-mini']);
  });
});

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

test.describe('attachment upload submission', () => {
  for (const width of [390, 1280]) {
    test.describe(`viewport ${width}`, () => {
      test.use({ viewport: { width, height: 900 } });
      for (const action of ['Enter', 'Meta+Shift+Enter', 'cancel', 'failure'] as const) {
        test(`retains upload intent for ${action}`, async ({ page }) => {
          let release!: (status: number) => void;
          let started!: () => void;
          const uploadStarted = new Promise<void>((resolve) => {
            started = resolve;
          });
          const uploadResult = new Promise<number>((resolve) => {
            release = resolve;
          });
          const image = {
            type: 'image',
            imageId: 'synthetic-browser-image',
            fileName: 'sample.png',
            mimeType: 'image/png',
            sizeBytes: 68,
            width: 1,
            height: 1,
          };
          await page.route('**/session-images/upload', async (route) => {
            if (route.request().method() === 'OPTIONS') {
              await route.fulfill({
                status: 204,
                headers: {
                  'access-control-allow-origin': '*',
                  'access-control-allow-methods': 'POST',
                  'access-control-allow-headers': 'authorization,content-type',
                },
              });
              return;
            }
            started();
            const status = await uploadResult;
            await route.fulfill({
              status,
              headers: { 'access-control-allow-origin': '*' },
              json: status === 200 ? { image } : { error: 'Synthetic upload failure' },
            });
          });
          await page.addInitScript(() => {
            (window as typeof window & { submissions: unknown[] }).submissions = [];
            window.addEventListener('storybook:attachments-submitted', (event) => {
              (window as typeof window & { submissions: unknown[] }).submissions.push(
                (event as CustomEvent).detail
              );
            });
          });
          await page.goto(
            '/iframe.html?id=sessions-sessionchatinputarea--uploading-attachments-pending-acceptance&viewMode=story'
          );
          const input = page.locator('textarea');
          await input.fill('Inspect this image');
          await page.locator('input[type="file"]').setInputFiles({
            name: 'sample.png',
            mimeType: 'image/png',
            buffer: Buffer.from(
              'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jR1sAAAAASUVORK5CYII=',
              'base64'
            ),
          });
          await uploadStarted;
          await input.press(action === 'Meta+Shift+Enter' ? action : 'Enter');
          await expect(input).toBeDisabled();
          await expect(
            page.getByRole('button', { name: 'Cancel send', exact: true })
          ).toBeVisible();
          const submissions = () =>
            page.evaluate(() => (window as typeof window & { submissions: unknown[] }).submissions);
          expect(await submissions()).toEqual([]);
          if (action === 'cancel')
            await page.getByRole('button', { name: 'Cancel send', exact: true }).click();
          release(action === 'failure' ? 500 : 200);
          if (action === 'cancel' || action === 'failure') await expect(input).toBeEnabled();
          if (action === 'cancel')
            await expect(
              page.getByRole('img', { name: 'sample.png', exact: true })
            ).not.toHaveClass(/grayscale/);
          if (action === 'cancel' || action === 'failure') {
            await expect(input).toHaveValue('Inspect this image');
            expect(await submissions()).toEqual([]);
          } else {
            await expect.poll(submissions).toHaveLength(1);
            await expect(
              page.getByRole('button', { name: 'Cancel send', exact: true })
            ).toHaveCount(0);
            await expect(page.getByRole('button', { name: 'Send', exact: true })).toBeDisabled();
            await expect(
              page.getByRole('button', { name: 'Run configuration', exact: true })
            ).toBeDisabled();
            await expect(input).toBeDisabled();
            expect(await submissions()).toEqual([
              {
                blocks: [image, { type: 'text', text: 'Inspect this image' }],
                ...(action === 'Meta+Shift+Enter'
                  ? { options: { invertSubmitBehavior: true } }
                  : {}),
              },
            ]);
            await page.evaluate(() =>
              window.dispatchEvent(new Event('storybook:accept-attachments'))
            );
            await expect(input).toBeEnabled();
            await expect(input).toHaveValue('');
            await expect(
              page.getByRole('button', { name: 'Run configuration', exact: true })
            ).toBeEnabled();
          }
        });
      }
    });
  }
});
