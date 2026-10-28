import { expect, test } from '@playwright/test';

test.describe('permission option wrapping', () => {
  for (const width of [320, 390, 1280]) {
    for (const story of ['long-options', 'long-chinese-options']) {
      test(`${story} stays readable at ${width}px`, async ({ page }) => {
        await page.setViewportSize({ width, height: 900 });
        await page.goto(`/iframe.html?id=sessions-permissionprompt--${story}&viewMode=story`);
        const prompt = page.getByRole('group').filter({
          has: page.getByRole('button', { name: 'Decline', exact: true }),
        });
        const refusal = prompt.getByRole('button', { name: 'Decline', exact: true });
        await expect(refusal).toBeVisible();
        await expect
          .poll(() =>
            prompt.evaluate((card) => {
              const bounds = card.getBoundingClientRect();
              return Array.from(card.querySelectorAll('button')).every((button) => {
                const box = button.getBoundingClientRect();
                return box.left >= bounds.left && box.right <= bounds.right;
              });
            })
          )
          .toBe(true);

        const expectWrapped = async (label: typeof refusal) => {
          await expect
            .poll(() =>
              label.evaluate((element) => {
                const bounds = element.getBoundingClientRect();
                const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
                const lines: DOMRect[] = [];
                while (walker.nextNode()) {
                  const text = document.createRange();
                  text.selectNodeContents(walker.currentNode);
                  lines.push(...text.getClientRects());
                }
                return (
                  lines.length > 1 &&
                  lines.every(
                    (line) =>
                      line.left >= bounds.left - 1 &&
                      line.right <= bounds.right + 1 &&
                      line.top >= bounds.top - 1 &&
                      line.bottom <= bounds.bottom + 1
                  ) &&
                  Array.from(element.querySelectorAll('*')).every(
                    (child) => child.scrollWidth <= child.clientWidth + 1
                  )
                );
              })
            )
            .toBe(true);
        };
        const controls = prompt.getByRole('button');
        for (const control of await controls.all()) {
          expect((await control.boundingBox())!.height).toBeLessThanOrEqual(32);
        }
        await expect(page.getByRole('status', { name: 'Selected option' })).toBeEmpty();

        const menus = prompt.locator('button[aria-haspopup="menu"]');
        for (let index = 0; index < (await menus.count()); index += 1) {
          await menus.nth(index).click();
          const option = page.getByRole('menuitem');
          await expect(option.first()).toBeVisible();
          for (const item of await option.all()) await expectWrapped(item);
          const box = await page.getByRole('menu').boundingBox();
          expect(box!.x).toBeGreaterThanOrEqual(0);
          expect(box!.x + box!.width).toBeLessThanOrEqual(width);
          await page.keyboard.press('Escape');
          await expect(option.first()).toBeHidden();
        }
        await refusal.focus();
        await page.keyboard.press('Enter');
        const originalRefusal = page.getByRole('menuitem', {
          name: /^(Deny this request|拒绝本次请求)/,
        });
        await expect(originalRefusal).toBeVisible();
        await expect(page.getByRole('status', { name: 'Selected option' })).toBeEmpty();
        await originalRefusal.click();
        await expect(page.getByRole('status', { name: 'Selected option' })).toHaveText('reject');
        expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
          width
        );
      });
    }
  }
});

test.describe('permission controls in the chat footer', () => {
  for (const viewport of [
    { width: 1280, height: 800 },
    { width: 390, height: 844 },
    { width: 390, height: 420 },
  ]) {
    test(`joins split buttons and opens above at ${viewport.width}x${viewport.height}`, async ({
      page,
    }) => {
      await page.setViewportSize(viewport);
      const frame = viewport.width < 640 ? 'mobile' : 'desktop';
      await page.goto(
        `/iframe.html?id=sessions-sessionconversationpage--${frame}-permission-approval&viewMode=story`
      );
      const allow = page.getByRole('button', { name: 'Allow once', exact: true });
      const more = page.getByRole('button', { name: 'More answers', exact: true });
      await expect(allow).toBeVisible();
      const segments = await allow.evaluate((button) => {
        const arrow = button.parentElement!.querySelector('button[aria-haspopup="menu"]')!;
        const mainBox = button.getBoundingClientRect();
        const arrowBox = arrow.getBoundingClientRect();
        return {
          role: button.parentElement?.getAttribute('role'),
          gap: arrowBox.left - mainBox.right,
          mainInnerRadius: parseFloat(getComputedStyle(button).borderTopRightRadius),
          arrowInnerRadius: parseFloat(getComputedStyle(arrow).borderTopLeftRadius),
          bottom: mainBox.bottom,
        };
      });
      expect(segments.role).toBe('group');
      expect(segments.gap).toBeCloseTo(1, 0);
      expect(segments.mainInnerRadius).toBe(0);
      expect(segments.arrowInnerRadius).toBe(0);
      expect(segments.bottom).toBeGreaterThan(viewport.height - 120);
      for (const trigger of [more, page.getByRole('button', { name: 'Decline', exact: true })]) {
        await trigger.click();
        const menu = page.getByRole('menu');
        await expect(menu).toBeVisible();
        await expect(menu).toHaveAttribute('data-side', 'top');
        await expect
          .poll(() =>
            more.evaluate((button) => parseFloat(getComputedStyle(button).borderTopRightRadius))
          )
          .toBeGreaterThan(0);
        await expect
          .poll(() =>
            menu.evaluate((element) => {
              const box = element.getBoundingClientRect();
              const hit = document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2);
              return (
                box.top >= 0 &&
                box.bottom <= innerHeight &&
                box.left >= 0 &&
                box.right <= innerWidth &&
                !!hit &&
                element.contains(hit)
              );
            })
          )
          .toBe(true);
        const anchor = await trigger.boundingBox();
        const popup = await menu.boundingBox();
        expect(popup!.y + popup!.height).toBeLessThanOrEqual(anchor!.y);
        await page.keyboard.press('Escape');
        await expect(menu).toBeHidden();
      }
    });
  }
});

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
      const modelMenu = page.getByRole('menu').last();
      await expect.poll(() => modelMenu.evaluate((el) => getComputedStyle(el).opacity)).toBe('1');
      await expect
        .poll(async () => {
          const submenu = await modelMenu.boundingBox();
          const viewport = page.viewportSize();
          return (
            !!submenu &&
            !!viewport &&
            submenu.y >= 0 &&
            submenu.y + submenu.height <= viewport.height &&
            submenu.height <= 329
          );
        })
        .toBe(true);
      const initialMenu = await modelMenu.boundingBox();
      expect(initialMenu).not.toBeNull();
      const expectSearchAnchored = async () => {
        await expect(search).toBeFocused();
        await expect
          .poll(async () => {
            const menu = await modelMenu.boundingBox();
            const field = await search.boundingBox();
            const row = await model.boundingBox();
            const viewport = page.viewportSize();
            if (!menu || !field || !row || !viewport) return Infinity;
            const top = Math.max(8, Math.min(row.y - 32, viewport.height - 8 - menu.height));
            return Math.max(Math.abs(menu.y - top), Math.abs(field.y - (menu.y + 4)));
          })
          .toBeLessThan(1);
      };
      if (openWith !== 'keyboard') {
        // A real pointer keeps moving over the trigger after the submenu opens.
        await model.hover({ position: { x: 12, y: 12 } });
        if (openWith === 'click') await model.click({ position: { x: 12, y: 12 } });
        await expect(search).toBeFocused();
      }
      for (const character of '54m') {
        await page.keyboard.type(character);
        await expectSearchAnchored();
      }
      await expect(search).toHaveValue('54m');
      const match = page.getByRole('menuitemradio');
      await expect(match).toHaveText(['5.4-mini']);
      const result = await match.boundingBox();
      const field = await search.boundingBox();
      expect(result).not.toBeNull();
      expect(field).not.toBeNull();
      expect(field!.y + field!.height).toBeLessThanOrEqual(result!.y);
      const modelRow = await model.boundingBox();
      expect(modelRow).not.toBeNull();
      expect(Math.abs(result!.y - (modelRow!.y + 4))).toBeLessThan(1);
      await expect
        .poll(async () => (await modelMenu.boundingBox())?.height ?? Infinity)
        .toBeLessThan(100);
      await search.fill('zzzz-no-model');
      await expect(match).toHaveCount(0);
      await expect(modelMenu.getByText('No models match', { exact: true })).toBeVisible();
      await expectSearchAnchored();
      await expect
        .poll(async () => (await modelMenu.boundingBox())?.height ?? Infinity)
        .toBeLessThan(100);
      await search.fill('');
      await expect(match).toHaveCount(10);
      await expectSearchAnchored();
      await expect
        .poll(async () => Math.abs((await modelMenu.boundingBox())!.height - initialMenu!.height))
        .toBeLessThan(1);
      await search.fill('54m');
      await expect(match).toHaveText(['5.4-mini']);
      await expectSearchAnchored();
      await page.keyboard.press('ArrowDown');
      await expect(match).toBeFocused();
      await page.keyboard.press('Escape');
      await expect(search).toBeHidden();
      await expect(trigger).toHaveAttribute('aria-expanded', 'false');
      await page.mouse.move(0, 0);
    }
  });
}

test('run-config submenus align with their own trigger rows when space permits', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1600, height: 1000 });
  await page.goto('/iframe.html?id=sessions-composerrunconfigmenu--closed&viewMode=story');
  await page.getByRole('button', { name: 'Run configuration', exact: true }).click();
  for (const name of ['Role', 'Agent', 'Model', 'Reasoning']) {
    const row = page
      .getByRole('menu')
      .first()
      .getByRole('menuitem', { name: new RegExp(`^${name}`) });
    const target = await row.boundingBox();
    expect(target).not.toBeNull();
    // Move through the submenu's pointer corridor rather than waiting for it to clear.
    await page.mouse.move(target!.x + target!.width / 2, target!.y + target!.height / 2, {
      steps: 8,
    });
    await expect(row).toHaveAttribute('aria-expanded', 'true');
    await expect(page.getByRole('menu')).toHaveCount(2);
    await expect
      .poll(async () => {
        const trigger = await row.boundingBox();
        const submenu = await page.getByRole('menu').last().boundingBox();
        if (!trigger || !submenu || submenu.x < trigger.x + trigger.width) return Infinity;
        return Math.abs(trigger.y - submenu.y);
      })
      .toBeLessThan(1);
  }
});

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

test.describe('composer selector leading column', () => {
  /* A selector's popup is spatially a child of its trigger: its painted edge
     stays on the trigger's edge, while its rows keep the shared popup inset —
     their leading icons sit on the menu's own column (inset + item pad), not
     on the trigger's mark. The trigger seats its glyph on its own geometry:
     centred on the icon-only square, one item pad in on a labeled trigger.
     An earlier lead margin that chased the row column left the icon-only
     glyph visibly off-centre once the rows kept the inset. */
  const cases = [
    // The machine selector is deliberately exempt: it keeps the popup's own
    // inset grid by owner decision, so only the run-config family is pinned.
    {
      name: 'run configuration',
      story: 'sessions-desktoprunconfigmenu--locked-agent',
      trigger: 'Run configuration',
      leadingRows: ['Plan', 'Fast'],
      iconOnly: false,
    },
    {
      name: 'permission',
      story: 'sessions-desktoprunconfigmenu--locked-agent',
      trigger: /^Permission:/,
      leadingRows: ['Read-only', 'Agent', 'Full access'],
      iconOnly: true,
    },
  ];

  for (const { name, story, trigger, leadingRows, iconOnly } of cases) {
    test(`${name} menu keeps the popup inset column`, async ({ page }) => {
      await page.goto(`/iframe.html?id=${story}&viewMode=story`);
      const triggerButton = page.getByRole('button', {
        name: trigger,
        exact: typeof trigger === 'string',
      });
      await triggerButton.click();
      const menu = page.getByRole('menu');
      await expect(menu).toBeVisible();
      // Measure the popup's resting position, not a frame of its rise.
      await page.evaluate(async () => {
        await Promise.all(
          document.getAnimations({ subtree: true }).map((a) => a.finished.catch(() => {}))
        );
      });
      // The surface must stay parented: its painted edge sits ON the
      // trigger's edge — sliding the popup to reach a column is a regression.
      const [triggerBox, popupLeft] = await Promise.all([
        triggerButton.evaluate((el) => {
          const r = el.getBoundingClientRect();
          return { left: r.left, center: r.left + r.width / 2 };
        }),
        menu.evaluate((el) => el.getBoundingClientRect().left),
      ]);
      expect(Math.abs(popupLeft - triggerBox.left)).toBeLessThanOrEqual(0.75);
      const triggerCenter = await triggerButton
        .locator('svg')
        .first()
        .evaluate((el) => {
          const r = el.getBoundingClientRect();
          return r.left + r.width / 2;
        });
      // The icon-only square centres its glyph; a labeled trigger's leading
      // glyph sits one item pad (8px) in, the centre of its 16px box.
      const expectedTriggerCenter = iconOnly ? triggerBox.center : triggerBox.left + 16;
      expect(Math.abs(triggerCenter - expectedTriggerCenter)).toBeLessThanOrEqual(0.75);
      const leadingCenters = await page.evaluate(() => {
        const items = [
          ...document.querySelectorAll<HTMLElement>(
            '[role="menuitem"],[role="menuitemradio"],[role="menuitemcheckbox"]'
          ),
        ];
        return items
          .map((item) => {
            // The leading slot is the row's first element child holding the
            // glyph itself; rows without one are skipped so a trailing
            // chevron or check cannot stand in for the column.
            const slot = item.firstElementChild;
            const glyph =
              slot?.firstElementChild instanceof SVGElement ? slot.firstElementChild : null;
            if (!glyph) return null;
            const rect = glyph.getBoundingClientRect();
            return {
              text: item.textContent?.trim() ?? '',
              center: rect.left + rect.width / 2,
            };
          })
          .filter((x): x is { text: string; center: number } => x != null);
      });
      for (const label of leadingRows) {
        const row = leadingCenters.find((r) => r.text.startsWith(label));
        expect(row, `leading icon of row "${label}"`).toBeTruthy();
      }
      // The rows keep the shared inset: every leading icon sits on the
      // menu's own column — popup edge + 4px inset + 8px item pad + half
      // the 16px icon box.
      for (const row of leadingCenters) {
        expect(Math.abs(row.center - (popupLeft + 20))).toBeLessThanOrEqual(0.75);
      }
    });
  }
});

test('a previous queued edit acknowledgement preserves the next edit and its focus', async ({
  page,
}) => {
  await page.goto('/iframe.html?id=sessions-messagequeuedisplay--deferred-editing&viewMode=story');
  await page.getByRole('button', { name: 'Edit queued message', exact: true }).first().click();
  const input = page.getByRole('textbox', { name: 'Edit queued message', exact: true });
  await input.fill('Refactor the queue; preserve existing ordering.');
  await page.getByRole('button', { name: 'Edit queued message', exact: true }).click();
  await expect(input).toHaveValue(
    'Add tests for the Loro mirror schema migrations around session history'
  );
  await input.fill('Add regression tests for message ordering and cancellation.');
  await page.evaluate(() => window.dispatchEvent(new Event('storybook:release-queue-save')));
  await expect(input).toHaveValue('Add regression tests for message ordering and cancellation.');
  await expect(input).toBeFocused();
  await input.press('Enter');
  await expect(input).toHaveCount(0);
  await expect(
    page.getByText('Refactor the queue; preserve existing ordering.', { exact: true })
  ).toBeVisible();
  await expect(
    page.getByText('Add regression tests for message ordering and cancellation.', { exact: true })
  ).toBeVisible();
});

test.describe('question request recovery', () => {
  test('shows a failed answer, retains its fields, and accepts the unchanged retry', async ({
    page,
  }) => {
    await page.addInitScript(() => {
      const writes: unknown[] = [];
      (window as typeof window & { questionWrites: unknown[] }).questionWrites = writes;
      window.addEventListener('storybook:question-write', (event) =>
        writes.push((event as CustomEvent).detail)
      );
    });
    for (const width of [390, 1000]) {
      await page.setViewportSize({ width, height: 650 });
      await page.goto(
        '/iframe.html?id=sessions-floatingpermissionrequest--question-send-recovery&viewMode=story'
      );
      const choice = page.getByRole('button', { name: 'Small change', exact: true });
      const note = page.getByRole('textbox', { name: 'Additional context', exact: true });
      await choice.click();
      await note.fill('Keep the public API stable.');
      const submit = page.getByRole('button', { name: 'Submit', exact: true });
      await submit.click();
      await expect(page.getByRole('alert')).toHaveText(
        "Your answer didn't reach the agent. Try again."
      );
      await expect(choice).toHaveAttribute('aria-pressed', 'true');
      await expect(note).toHaveValue('Keep the public API stable.');
      await expect(submit).toBeEnabled();
      const card = await note.evaluate((node) => {
        const bounds = node.closest('label')!.parentElement!.getBoundingClientRect();
        return { x: bounds.x, y: bounds.y, right: bounds.right, bottom: bounds.bottom };
      });
      const feedback = await page.getByRole('alert').boundingBox();
      const action = await submit.boundingBox();
      expect(feedback).not.toBeNull();
      expect(action).not.toBeNull();
      expect(feedback!.x).toBeGreaterThanOrEqual(card.x);
      expect(feedback!.x + feedback!.width).toBeLessThanOrEqual(card.right);
      expect(feedback!.y).toBeGreaterThanOrEqual(card.y);
      expect(feedback!.y + feedback!.height).toBeLessThanOrEqual(card.bottom);
      expect(feedback!.y + feedback!.height).toBeLessThanOrEqual(action!.y);

      await submit.click();
      await expect(page.getByText('Which constraints matter?', { exact: true })).toBeVisible();
      await expect(page.getByRole('alert')).toHaveCount(0);
      const writes = await page.evaluate(
        () => (window as typeof window & { questionWrites: unknown[] }).questionWrites
      );
      expect(writes).toEqual([
        { requestId: 'request-approach', accepted: false },
        {
          requestId: 'request-approach',
          accepted: true,
          outcome: {
            outcome: 'selected',
            optionId: 'answer',
            _meta: {
              lody: {
                elicitation: {
                  version: 1,
                  answers: {
                    approach: 'Small change',
                    approach_note: 'Keep the public API stable.',
                  },
                },
              },
            },
          },
        },
      ]);
    }
  });

  for (const touch of [false, true]) {
    test.describe(`request navigation touch=${touch}`, () => {
      test.use({ hasTouch: touch });
      test('keeps independent drafts and removes each form after its answer is accepted', async ({
        page,
      }) => {
        await page.goto(
          '/iframe.html?id=sessions-floatingpermissionrequest--parallel-questions&viewMode=story'
        );
        const press = async (locator: import('@playwright/test').Locator) =>
          touch ? locator.tap() : locator.click();
        const custom = page.getByRole('textbox', { name: 'Type a custom answer...', exact: true });
        const note = page.getByRole('textbox', { name: 'Additional context', exact: true });
        await custom.fill('Use a small, reversible change.');
        await note.fill('Keep the public API stable.');
        await press(page.getByRole('button', { name: 'Next request', exact: true }));
        await expect(page.getByText('Which constraints matter?', { exact: true })).toBeVisible();
        await press(page.getByRole('button', { name: 'Offline', exact: true }));
        await press(page.getByRole('button', { name: 'Compatibility', exact: true }));
        await note.fill('Must work without network access.');
        await press(page.getByRole('button', { name: 'Previous request', exact: true }));
        await expect(custom).toHaveValue('Use a small, reversible change.');
        await expect(note).toHaveValue('Keep the public API stable.');
        await press(page.getByRole('button', { name: 'Submit', exact: true }));
        await expect(page.getByText('Which approach should we use?', { exact: true })).toHaveCount(
          0
        );
        await expect(page.getByRole('button', { name: 'Offline', exact: true })).toHaveAttribute(
          'aria-pressed',
          'true'
        );
        await expect(
          page.getByRole('button', { name: 'Compatibility', exact: true })
        ).toHaveAttribute('aria-pressed', 'true');
        await expect(note).toHaveValue('Must work without network access.');
        await press(page.getByRole('button', { name: 'Submit', exact: true }));
        await expect(page.getByRole('textbox')).toHaveCount(0);
        await expect(page.locator('textarea,input')).toHaveCount(0);
      });
    });
  }

  test('retains a question draft across an ordinary permission prompt and cancellation', async ({
    page,
  }) => {
    await page.goto(
      '/iframe.html?id=sessions-floatingpermissionrequest--mixed-requests&viewMode=story'
    );
    const choice = page.getByRole('button', { name: 'Small change', exact: true });
    const note = page.getByRole('textbox', { name: 'Additional context', exact: true });
    await choice.click();
    await note.fill('Keep the public API stable.');
    await page.getByRole('button', { name: 'Next request', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Allow once', exact: true })).toBeVisible();
    await expect(page.getByRole('textbox')).toHaveCount(0);
    await page.getByRole('button', { name: 'Previous request', exact: true }).click();
    await expect(choice).toHaveAttribute('aria-pressed', 'true');
    await expect(note).toHaveValue('Keep the public API stable.');
    await page.getByRole('button', { name: 'Cancel', exact: true }).click();
    await expect(page.getByText('Which approach should we use?', { exact: true })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Allow once', exact: true })).toBeVisible();
  });
});

for (const imeSignal of [{ isComposing: true }, { keyCode: 229 }, { which: 229 }]) {
  test(`custom question answer retains IME candidate confirmation ${JSON.stringify(imeSignal)}`, async ({
    page,
  }) => {
    await page.goto(
      '/iframe.html?id=sessions-askuserquestioncard--legacy-custom-answer&viewMode=story'
    );
    const input = page.getByRole('textbox', { name: 'Type a custom answer...', exact: true });
    await input.fill('保留现有接口，先修改队列编辑。');
    const prevented = await input.evaluate((node, signal) => {
      const event = new KeyboardEvent('keydown', {
        key: 'Enter',
        bubbles: true,
        cancelable: true,
        ...signal,
      });
      // Chromium derives `which` from keyCode and ignores it in KeyboardEventInit.
      // Override the readonly field to exercise the legacy native-event signal.
      if (signal.which !== undefined)
        Object.defineProperty(event, 'which', { value: signal.which });
      node.dispatchEvent(event);
      return event.defaultPrevented;
    }, imeSignal);
    expect(prevented).toBe(false);
    await expect(page.getByText('Answered', { exact: true })).toHaveCount(0);
    await expect(input).toBeEnabled();
    await expect(input).toBeFocused();
    await expect(input).toHaveValue('保留现有接口，先修改队列编辑。');
    await input.press('Enter');
    await expect(page.getByText('Answered', { exact: true })).toBeVisible();
    await expect(input).toHaveValue('保留现有接口，先修改队列编辑。');
  });
}

test.describe('mobile first-send continuity', () => {
  for (const scenario of [
    { theme: 'light', width: 390, height: 844, keyboard: 0 },
    { theme: 'dark', width: 390, height: 844, keyboard: 0 },
    { theme: 'dark', width: 320, height: 568, keyboard: 0 },
    { theme: 'light', width: 430, height: 932, keyboard: 0 },
    { theme: 'dark', width: 390, height: 844, keyboard: 300 },
  ]) {
    test(`${scenario.theme} ${scenario.width}px keyboard ${scenario.keyboard}px replaces in place`, async ({
      page,
    }) => {
      await page.setViewportSize(scenario);
      await page.goto(
        `/iframe.html?id=mobile-newchattransition--send-in-place&viewMode=story&globals=theme:${scenario.theme}`
      );
      const composer = page.locator('[class~="@container/composer-box"]');
      const send = page.getByRole('button', { name: 'Send', exact: true });
      await expect(send).toBeEnabled({ timeout: 15000 });
      if (scenario.keyboard) {
        await page.evaluate(
          (height) =>
            document.documentElement.style.setProperty('--native-keyboard-height', `${height}px`),
          scenario.keyboard
        );
        await expect
          .poll(async () => {
            const box = await composer.boundingBox();
            return box ? box.y + box.height : 0;
          })
          .toBe(scenario.height - scenario.keyboard - 8);
      }
      const before = await composer.boundingBox();
      const model = page.getByRole('button', { name: 'Run configuration', exact: true });
      const modelLabel = await model.innerText();
      // Observe real surfaces through routing and 45 frames of the new page.
      const samples = page.evaluate(
        () =>
          new Promise<Array<{ boxes: number[][]; transform: string; animations: number }>>(
            (resolve) => {
              const result: Array<{ boxes: number[][]; transform: string; animations: number }> =
                [];
              let sentFrames = 0;
              const sample = () => {
                const drawer = document.querySelector('[data-vaul-drawer]');
                result.push({
                  boxes: Array.from(
                    document.querySelectorAll('[class~="@container/composer-box"]'),
                    (element) => {
                      const box = element.getBoundingClientRect();
                      return [box.x, box.y, box.width, box.height];
                    }
                  ),
                  transform: drawer ? getComputedStyle(drawer).transform : 'none',
                  animations: drawer
                    ? drawer
                        .getAnimations()
                        .filter((animation) => animation.playState === 'running').length
                    : 0,
                });
                if (drawer && ++sentFrames >= 45) resolve(result);
                else requestAnimationFrame(sample);
              };
              requestAnimationFrame(sample);
            }
          )
      );
      await send.click();
      await expect(page.getByText('请检查移动端发送消息的布局。', { exact: true })).toBeVisible();
      await expect(composer).toHaveCount(1);
      expect(await composer.boundingBox()).toEqual(before);
      expect(await model.innerText()).toBe(modelLabel);
      await expect(model).toHaveCSS('font-weight', '400');
      for (const frame of await samples) {
        expect(frame.boxes).toEqual([[before!.x, before!.y, before!.width, before!.height]]);
        expect(['none', 'matrix(1, 0, 0, 1, 0, 0)']).toContain(frame.transform);
        expect(frame.animations).toBe(0);
      }
    });
  }
});

test('mobile project choices mix sources by recency and render their icons', async ({ page }) => {
  await page.route('https://avatars.githubusercontent.com/**', (route) => route.abort());
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(
    '/iframe.html?id=mobile-mobilenewchatsheet--inline-page-review-story&viewMode=story'
  );
  await page.getByRole('button', { name: 'Project', exact: true }).click();
  const list = page.getByRole('listbox', { name: 'Project', exact: true });
  await expect(list).toBeVisible();
  const names = async () =>
    (await list.getByRole('option').allInnerTexts()).map((text) => text.split('\n')[0]);
  await expect
    .poll(names)
    .toEqual([
      'No project selected',
      'blog',
      'loro-dev/lody',
      'Loro stack',
      'lody',
      'loro-dev/loro',
      'docs',
      'loro-dev/lody-web',
    ]);
  for (const option of await list.getByRole('option').all())
    await expect(option.locator('button > span').first().locator('svg')).toHaveCount(1);
  await expect(list.getByText('High-performance CRDT framework', { exact: true })).toHaveCount(0);
  await expect(
    list.getByRole('option').filter({ hasText: 'loro-dev/loro' }).locator('svg.lucide-github')
  ).toHaveCount(1);
  await page.getByRole('textbox', { name: 'Search projects', exact: true }).fill('loro');
  await expect
    .poll(names)
    .toEqual(['loro-dev/lody', 'Loro stack', 'loro-dev/loro', 'loro-dev/lody-web']);
  await page.getByRole('textbox', { name: 'Search projects', exact: true }).fill('');
  await list.getByRole('button', { name: 'No project selected', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Project', exact: true })).toHaveText(
    'No project selected'
  );
});

for (const theme of ['light', 'dark']) {
  test(`mobile GitHub project avatars remain centered while loading and after loading in ${theme}`, async ({
    page,
  }) => {
    let release!: () => void;
    const ready = new Promise<void>((resolve) => {
      release = resolve;
    });
    await page.route('https://avatars.githubusercontent.com/**', async (route) => {
      await ready;
      await route.fulfill({
        contentType: 'image/svg+xml',
        headers: { 'Access-Control-Allow-Origin': '*' },
        body: '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16"><rect width="16" height="16" fill="#318080"/></svg>',
      });
    });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(
      `/iframe.html?id=mobile-mobilenewchatsheet--inline-page-review-story&viewMode=story&globals=theme:${theme}`
    );
    const project = page.getByRole('button', { name: 'Project', exact: true });
    const expectCentered = async (row: typeof project, name: string, icon: string) => {
      await expect
        .poll(() =>
          row.evaluate(
            (element, { name: labelName, icon: iconSelector }) => {
              const image = element.querySelector(iconSelector);
              const label = Array.from(element.querySelectorAll('span')).find(
                (span) => span.childElementCount === 0 && span.textContent === labelName
              );
              if (!image || !label) return Number.POSITIVE_INFINITY;
              const imageBox = image.getBoundingClientRect();
              const labelBox = label.getBoundingClientRect();
              return Math.abs(
                imageBox.top + imageBox.height / 2 - labelBox.top - labelBox.height / 2
              );
            },
            { name, icon }
          )
        )
        .toBeLessThanOrEqual(0.5);
    };
    await expect(project.locator('svg.lucide-github')).toBeVisible();
    await expectCentered(project, 'loro-dev/loro', 'svg.lucide-github');
    release();
    await expect(project.locator('img')).toBeVisible();
    await expect(project.locator('img')).toHaveCSS('opacity', '1');
    await expect(project.locator('svg.lucide-github')).toHaveCount(0);
    await expectCentered(project, 'loro-dev/loro', 'img');
    await project.click();
    const repo = page.getByRole('option').filter({ hasText: 'loro-dev/loro' });
    await expect(repo.locator('img')).toHaveAttribute(
      'src',
      /^(blob:|https:\/\/avatars\.githubusercontent\.com\/loro-dev\?size=80)/
    );
    await expect(repo.locator('img')).toHaveCSS('opacity', '1');
    await expect(repo.locator('svg.lucide-github')).toHaveCount(0);
    await expectCentered(repo, 'loro-dev/loro', 'img');
  });
}

test('mobile send retains its page through delayed presentation and later URL corrections', async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(
    '/iframe.html?id=mobile-newchattransition--deferred-send-in-place&viewMode=story&globals=theme:dark'
  );
  const composer = page.locator('[class~="@container/composer-box"]');
  await expect(page.getByRole('button', { name: 'Send', exact: true })).toBeEnabled();
  const before = await composer.boundingBox();
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  // Let Vaul's first-frame shortcut expire before the real surface can mount.
  await page.evaluate(
    () =>
      new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
      )
  );
  await expect(page.getByRole('button', { name: 'Project', exact: true })).toBeVisible();
  await expect(page.locator('[data-vaul-drawer]')).toHaveCount(0);
  expect(await composer.boundingBox()).toEqual(before);
  await page.evaluate(() => window.dispatchEvent(new Event('storybook:session-ready')));
  await expect(page.getByText('请检查移动端发送消息的布局。', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Project', exact: true })).toHaveCount(0);
  const drawer = page.locator('[data-vaul-drawer]');
  await expect(drawer).toHaveCSS('animation-name', 'none');
  await page.evaluate(
    () =>
      new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
      )
  );
  await page.evaluate(() => window.dispatchEvent(new Event('storybook:normalize-session-url')));
  for (let frame = 0; frame < 45; frame++) {
    const geometry = await drawer.evaluate((element) => ({
      transform: getComputedStyle(element).transform,
      animations: element.getAnimations().filter((animation) => animation.playState === 'running')
        .length,
    }));
    expect(['none', 'matrix(1, 0, 0, 1, 0, 0)']).toContain(geometry.transform);
    expect(geometry.animations).toBe(0);
    expect(await composer.boundingBox()).toEqual(before);
    await page.evaluate(
      () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
    );
  }
});

for (const dismiss of ['none', 'blur', 'native-hide'] as const) {
  test(`mobile first send dismisses the keyboard after presentation without reopening it (dismiss=${dismiss})`, async ({
    page,
  }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.addInitScript(() => {
      Object.defineProperty(window, '__LODY_NATIVE__', { value: true, configurable: true });
      Object.defineProperty(navigator, 'userAgent', { value: 'iPhone Mobile', configurable: true });
    });
    await page.goto(
      '/iframe.html?id=mobile-newchattransition--deferred-send-in-place&viewMode=story'
    );
    const source = page.locator('#chat-prompt-mobile-sheet');
    await source.focus();
    // Model the native keyboard signal from focus ownership rather than holding
    // a constant height through a blur (which hid the original regression).
    await page.evaluate(() => {
      const sync = () =>
        document.documentElement.style.setProperty(
          '--native-keyboard-height',
          document.activeElement?.matches('textarea[data-lody-composer-input]') ? '300px' : '0px'
        );
      document.addEventListener('focusin', sync);
      document.addEventListener('focusout', () => queueMicrotask(sync));
      sync();
    });
    await page.getByRole('button', { name: 'Send', exact: true }).click();
    await expect(source).toBeFocused();
    await expect(source).not.toHaveAttribute('disabled');
    await expect(source).toHaveValue('');
    await page.keyboard.type('must not replace the submitted draft');
    await expect(source).toHaveValue('');
    if (dismiss === 'blur') await source.evaluate((node: HTMLTextAreaElement) => node.blur());
    if (dismiss === 'native-hide') {
      await page.evaluate(() =>
        document.documentElement.style.setProperty('--native-keyboard-height', '0px')
      );
      await expect(source).toBeFocused();
    }
    await page.evaluate(() => window.dispatchEvent(new Event('storybook:session-ready')));
    const destination = page.locator('textarea[data-lody-composer-input]');
    await expect(destination).toHaveCount(1);
    await expect(destination).not.toBeFocused();
    await expect(page.locator('html')).toHaveCSS('--native-keyboard-height', '0px');
  });
}

test('mobile composer animates keyboard inset and safe-area padding together', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(
    '/iframe.html?id=mobile-mobilenewchatsheet--inline-page-review-story&viewMode=story'
  );
  await page.getByRole('button', { name: 'Send', exact: true }).waitFor();
  const samples = await page.evaluate(() => {
    const input = document.querySelector('textarea')!;
    let shell: HTMLElement | null = input.parentElement;
    while (shell && !getComputedStyle(shell).transitionProperty.includes('margin-bottom'))
      shell = shell.parentElement;
    if (!shell) throw new Error('Missing keyboard-aware composer shell');
    document.documentElement.style.setProperty('--safe-area-bottom', '34px');
    document.documentElement.style.setProperty('--native-keyboard-height', '300px');
    shell.getBoundingClientRect();
    for (const animation of shell.getAnimations()) animation.finish();
    shell.getBoundingClientRect();
    document.documentElement.style.setProperty('--native-keyboard-height', '0px');
    shell.getBoundingClientRect();
    const animations = shell.getAnimations();
    for (const animation of animations) animation.pause();
    const box = input.closest('[class~="@container/composer-box"]')!;
    return [0, 0.5, 1].map((progress) => {
      for (const animation of animations)
        animation.currentTime = Number(animation.effect!.getTiming().duration) * progress;
      return {
        y: box.getBoundingClientRect().y,
        padding: parseFloat(getComputedStyle(shell!).paddingBottom),
      };
    });
  });
  expect(samples[0].padding).toBeCloseTo(8);
  expect(samples[1].padding).toBeGreaterThan(8);
  expect(samples[1].padding).toBeLessThan(42);
  expect(samples[2].padding).toBeCloseTo(42);
  expect(samples[1].y).toBeGreaterThan(samples[0].y);
  expect(samples[1].y).toBeLessThan(samples[2].y);
});

test('mobile first send keeps the keyboard if the user starts the next draft before dismissal', async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(
    '/iframe.html?id=mobile-newchattransition--deferred-send-in-place&viewMode=story'
  );
  const source = page.locator('#chat-prompt-mobile-sheet');
  await source.focus();
  await page.evaluate(() => {
    document.documentElement.style.setProperty('--native-keyboard-height', '300px');
    document.addEventListener('focusin', (event) => {
      const input = event.target;
      if (input instanceof HTMLTextAreaElement && input.id !== 'chat-prompt-mobile-sheet')
        queueMicrotask(() =>
          input.dispatchEvent(
            new InputEvent('beforeinput', { bubbles: true, inputType: 'insertText', data: 'a' })
          )
        );
    });
  });
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await page.evaluate(() => window.dispatchEvent(new Event('storybook:session-ready')));
  const destination = page.locator('textarea[data-lody-composer-input]');
  await expect(destination).toHaveCount(1);
  await page.evaluate(
    () =>
      new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
      )
  );
  await expect(destination).toBeFocused();
  await page.keyboard.type('A new draft');
  await expect(destination).toHaveValue('A new draft');
});

for (const project of ['loro-dev/lody', 'blog', 'Loro stack', 'No project selected']) {
  test(`mobile new conversation restores last sent project ${project} after reopening and reload`, async ({
    page,
  }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto('/iframe.html?id=mobile-mobilenewchatsheet--remembered-project&viewMode=story');
    await page.getByRole('button', { name: 'New conversation', exact: true }).click();
    await page.getByRole('button', { name: 'Project', exact: true }).click();
    await page
      .getByRole('listbox', { name: 'Project', exact: true })
      .getByRole('option')
      .filter({ has: page.getByText(project, { exact: true }) })
      .getByRole('button')
      .click();
    await page
      .locator('textarea[data-lody-composer-input]')
      .fill('Synthetic project restoration test');
    await page.getByRole('button', { name: 'Send', exact: true }).click();
    await page.getByRole('button', { name: 'New conversation', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Project', exact: true })).toHaveText(project);
    await page.reload();
    await page.getByRole('button', { name: 'New conversation', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Project', exact: true })).toHaveText(project);
  });
}

test('mobile local branch shows a readable ref across worktree toggles', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(
    '/iframe.html?id=mobile-mobilenewchatsheet--inline-page-many-branches&viewMode=story'
  );
  const branch = page.getByRole('button', { name: 'Branch', exact: true });
  const worktree = page.getByRole('checkbox');
  await expect(branch).toHaveText('main (local)');
  await expect(worktree).toBeChecked();
  await branch.click();
  await page
    .getByRole('listbox', { name: 'Branch', exact: true })
    .getByRole('option')
    .filter({ hasText: 'feat/audit-mobile-coupling (local)' })
    .getByRole('button')
    .click();
  await expect(branch).toHaveText('feat/audit-mobile-coupling (local)');
  await worktree.click();
  await expect(branch).toBeDisabled();
  await expect(branch).toHaveText('main (local)');
  await worktree.click();
  await expect(branch).toBeEnabled();
  await expect(branch).toHaveText('feat/audit-mobile-coupling (local)');
});
