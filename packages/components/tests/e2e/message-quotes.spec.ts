import { composerText, expectComposerText } from './composer-text';
import { expect, test, type Page } from '@playwright/test';

const story = (name = 'inline') => `/iframe.html?id=chat-messagequotes--${name}&viewMode=story`;
const input = (page: Page) => page.getByRole('combobox', { name: 'Message', exact: true });

async function openQuoteStory(page: Page, name = 'inline', globals = '') {
  await page.goto(story(name) + globals);
  // Wait for the real editor: the dev server may still be compiling the story.
  await expect(input(page)).toBeVisible({ timeout: 30_000 });
}

async function selectPassage(page: Page, index: number) {
  const paragraph = page.locator(`[data-conversation-turn-id="quote-source-${index}"] p`).first();
  await paragraph.scrollIntoViewIfNeeded();
  const box = (await paragraph.boundingBox())!;
  await page.mouse.move(box.x + 2, box.y + 8);
  await page.mouse.down();
  await page.mouse.move(box.x + Math.min(box.width - 3, 260), box.y + 8, { steps: 8 });
  await page.mouse.up();
  await expect(page.getByRole('button', { name: 'Quote', exact: true })).toBeVisible();
  return page.evaluate(() => getSelection()!.toString());
}

test('a modal covers the quote action when the background selection is restored', async ({ page }) => {
  await openQuoteStory(page, 'modal-over-selection');
  await selectPassage(page, 11);
  const range = await page.evaluateHandle(() => getSelection()!.getRangeAt(0).cloneRange());
  await page.getByRole('button', { name: 'Open settings' }).click();
  const dialog = page.getByRole('dialog', { name: 'Settings' });
  await expect(dialog).toBeVisible();
  const quote = page.getByText('Quote', { exact: true });
  await page.evaluate(() => getSelection()!.removeAllRanges());
  await expect(quote).toHaveCount(0);
  await page.evaluate((retained) => getSelection()!.addRange(retained), range);
  await expect(quote).toBeVisible();

  const bounds = (await quote.boundingBox())!;
  const panel = (await dialog.boundingBox())!;
  expect(bounds.x).toBeGreaterThanOrEqual(panel.x);
  expect(bounds.y).toBeGreaterThanOrEqual(panel.y);
  expect(bounds.x + bounds.width).toBeLessThanOrEqual(panel.x + panel.width);
  expect(bounds.y + bounds.height).toBeLessThanOrEqual(panel.y + panel.height);
  const shot = () => page.screenshot({ clip: bounds, animations: 'disabled' });
  const retained = await shot();
  await page.evaluate(() => getSelection()!.removeAllRanges());
  await expect(quote).toHaveCount(0);
  expect((await shot()).equals(retained)).toBe(true);
});

test('native selection action does not resize or scroll the conversation, and quotes keep question order', async ({
  page,
}, testInfo) => {
  await openQuoteStory(page);
  await expect(input(page)).toBeVisible();
  const viewport = page.locator('.chat-scrollbar');
  const before = await viewport.evaluate((node) => ({
    height: node.getBoundingClientRect().height,
    top: node.scrollTop,
  }));
  const first = await selectPassage(page, 11);
  expect(first.trim()).not.toBe('');
  const selectionBounds = await page.evaluate(() => {
    const rect = getSelection()!.getRangeAt(0).getClientRects()[0]!;
    return { top: rect.top, center: (rect.left + rect.right) / 2 };
  });
  const actionBounds = (await page
    .getByRole('button', { name: 'Quote', exact: true })
    .boundingBox())!;
  expect(actionBounds.y + actionBounds.height).toBeLessThan(selectionBounds.top);
  expect(actionBounds.x + actionBounds.width / 2).toBeCloseTo(selectionBounds.center, 0);
  await page.screenshot({ path: testInfo.outputPath('quote-action-above.png') });
  expect(
    await viewport.evaluate((node) => ({
      height: node.getBoundingClientRect().height,
      top: node.scrollTop,
    }))
  ).toEqual(before);
  await page.getByRole('button', { name: 'Quote', exact: true }).click();
  await expect(input(page)).toBeFocused();
  await page.keyboard.insertText(' Question A? ');
  const second = await selectPassage(page, 10);
  await page.getByRole('button', { name: 'Quote', exact: true }).click();
  await page.keyboard.insertText(' Question B? ');
  const value = await composerText(input(page));
  expect(value.match(/\[Passage /g)).toHaveLength(2);
  expect(value.indexOf('Question A?')).toBeLessThan(value.lastIndexOf('[Passage '));
  expect(value.lastIndexOf('[Passage ')).toBeLessThan(value.indexOf('Question B?'));
  const quoteStyles = await input(page)
    .locator('[data-mention-value]')
    .evaluateAll((chips) =>
      chips.map((chip) => {
        const style = getComputedStyle(chip);
        return {
          background: style.backgroundColor,
          colourMatchesLink:
            style.color ===
            getComputedStyle(chip.ownerDocument.querySelector('.markdown-renderer a')!).color,
          marginInline: Number.parseFloat(style.marginInlineStart),
          marginBlock: Number.parseFloat(style.marginBlockStart),
        };
      })
    );
  expect(quoteStyles).toHaveLength(2);
  for (const quote of quoteStyles) {
    expect(quote.background).toBe('rgba(0, 0, 0, 0)');
    expect(quote.colourMatchesLink).toBe(true);
    expect(quote.marginInline).toBe(1);
    expect(quote.marginBlock).toBe(0);
  }
  await page.screenshot({ path: testInfo.outputPath('inline-quotes.png') });
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await expectComposerText(input(page), '');
  const bubble = page.locator('[data-user-message-bubble]').last();
  await expect(bubble).toContainText('Question A?');
  await expect(bubble).toContainText('Question B?');
  const chips = bubble.getByRole('button').filter({ hasText: 'Passage ' });
  await expect(chips).toHaveCount(2);
  await chips.first().click();
  await expect(bubble).toContainText(first.trim());
  await chips.last().click();
  await expect(bubble).toContainText(second.trim());
});

test('quotes insert at the saved caret and grow the composer before typing resumes', async ({
  page,
}, testInfo) => {
  await page.setViewportSize({ width: 360, height: 780 });
  await openQuoteStory(page);
  await input(page).fill('Before the quote\nAfter the quote with trailing text');
  await input(page).press('Home');
  const before = (await input(page).boundingBox())!.height;
  await selectPassage(page, 11);
  await page.getByRole('button', { name: 'Quote', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(input(page)).toBeFocused();
  await expect.poll(async () => (await input(page).boundingBox())!.height).toBeGreaterThan(before);
  await page.screenshot({ path: testInfo.outputPath('quote-caret-and-growth.png') });
  await page.keyboard.insertText('QUESTION');
  const value = await composerText(input(page));
  expect(value).toMatch(/^Before the quote\n.*\[Passage /s);
  expect(value).toContain('QUESTIONAfter the quote with trailing text');
});

test('a capped composer reveals the insertion caret in a long draft', async ({
  page,
}, testInfo) => {
  await openQuoteStory(page, 'scrollable-draft');
  await input(page).click();
  // End/Meta+End scroll instead of moving the caret on some hosts.
  for (let line = 0; line < 20; line += 1) await input(page).press('ArrowDown');
  await selectPassage(page, 11);
  await page.getByRole('button', { name: 'Quote', exact: true }).click();
  await expect(input(page)).toBeFocused();
  expect(await composerText(input(page))).toMatch(/^(Existing draft line\n){18}.*\[Passage /s);
  // A collapsed native range immediately after a decorator has no client rect.
  // Its preceding quote's end is the visible insertion point; measure that DOM.
  const chip = input(page).locator('[data-mention-value]').last();
  await expect
    .poll(async () => {
      const [caret, bounds] = [(await chip.boundingBox())!, (await input(page).boundingBox())!];
      return caret.y >= bounds.y && caret.y + caret.height <= bounds.y + bounds.height + 1;
    })
    .toBe(true);
  await page.screenshot({ path: testInfo.outputPath('quote-scrollable-draft.png') });
  await page.keyboard.insertText('VISIBLE_CARET');
  expect(await composerText(input(page))).toMatch(/\[Passage .*VISIBLE_CARET$/s);
});

for (const theme of ['light', 'dark']) {
  test(`adjacent quotes retain spacing without overflow in ${theme} mode`, async ({
    page,
  }, testInfo) => {
    await page.setViewportSize({ width: 360, height: 780 });
    await openQuoteStory(page, 'multiple-quotes', `&globals=theme:${theme}`);
    await expect(page.locator('html')).toHaveClass(new RegExp(theme));
    const chips = input(page).locator('[data-mention-value]');
    await expect(chips).toHaveCount(3);
    const linkColour = await page
      .locator('.markdown-renderer a')
      .first()
      .evaluate((link) => getComputedStyle(link).color);
    const quoteColours = await chips.evaluateAll((nodes) =>
      nodes.map((node) => getComputedStyle(node).color)
    );
    expect(quoteColours).toEqual([linkColour, linkColour, linkColour]);
    await expect
      .poll(async () =>
        input(page).evaluate((element) => element.scrollWidth <= element.clientWidth)
      )
      .toBe(true);
    const [first, second] = await chips.evaluateAll((nodes) => [
      Array.from(nodes[0]!.getClientRects()).at(-1)!.toJSON(),
      nodes[1]!.getClientRects()[0]!.toJSON(),
    ]);
    if (Math.abs(second.top - first.top) < 1) {
      expect(second.left - first.right).toBeGreaterThanOrEqual(2);
    } else {
      expect(second.top).toBeGreaterThanOrEqual(first.bottom);
    }
    await page.screenshot({ path: testInfo.outputPath(`multiple-quotes-${theme}.png`) });
    await input(page).focus();
    await input(page).press('ControlOrMeta+a');
    await expect(input(page).locator('[data-mention-value][data-selected]')).toHaveCount(3);
    const selectionColours = await chips.evaluateAll((nodes) =>
      nodes.map((node) => ({
        actual: getComputedStyle(node).backgroundColor,
        text: getComputedStyle(node.closest('p')!, '::selection').backgroundColor,
        shadow: getComputedStyle(node).boxShadow,
      }))
    );
    for (const colour of selectionColours) {
      expect(colour.actual).toBe(colour.text);
      expect(colour.shadow).toBe('none');
    }
    await page.screenshot({ path: testInfo.outputPath(`multiple-quotes-selected-${theme}.png`) });
  });
}

for (const navigation of ['ArrowLeft', 'Home', 'pointer'] as const) {
  test(`a line-start quote accepts typing on its left via ${navigation}`, async ({
    page,
  }, testInfo) => {
    await openQuoteStory(page, 'line-start-quote');
    const composer = input(page);
    await composer.focus();
    await composer.press('ControlOrMeta+a');
    await composer.press('ArrowRight');
    if (navigation === 'pointer') {
      const chip = (await composer.locator('[data-mention-value]').boundingBox())!;
      await page.mouse.click(chip.x - 2, chip.y + chip.height / 2);
    } else await composer.press(navigation);
    const caretBoxHeight = await composer.evaluate(() => {
      const range = getSelection()?.getRangeAt(0);
      const element =
        range?.startContainer instanceof Element
          ? range.startContainer
          : range?.startContainer.parentElement;
      const style = getComputedStyle(element!);
      return {
        display: style.display,
        height: element!.getBoundingClientRect().height,
        fontSize: Number.parseFloat(style.fontSize),
        beforeContent: getComputedStyle(element!, '::before').content,
        afterContent: getComputedStyle(element!, '::after').content,
      };
    });
    expect(caretBoxHeight.display).toBe('inline');
    expect(caretBoxHeight.height).toBeGreaterThanOrEqual(caretBoxHeight.fontSize);
    expect(caretBoxHeight.beforeContent).toBe('none');
    expect(caretBoxHeight.afterContent).toBe('none');
    await page.keyboard.insertText('before');
    expect(await composerText(composer)).toMatch(/^Previous line\nbefore.*\[A quote /s);
    await expect(composer.locator('[data-mention-value]')).toHaveCount(1);
    await composer.press('ControlOrMeta+z');
    expect(await composerText(composer)).toMatch(/^Previous line\n.*\[A quote /s);
    await page.screenshot({ path: testInfo.outputPath(`left-edge-${navigation}.png`) });
  });
}

test('IME input at a line-start quote stays before the snapshot', async ({ page, browserName }) => {
  test.skip(browserName !== 'chromium', 'IME uses the Chromium DevTools protocol');
  await openQuoteStory(page, 'line-start-quote');
  const composer = input(page);
  await composer.focus();
  await composer.press('ControlOrMeta+a');
  await composer.press('ArrowRight');
  await composer.press('ArrowLeft');
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Input.imeSetComposition', { text: 'zhong', selectionStart: 5, selectionEnd: 5 });
  await expect(composer.locator('[data-mention-value]')).toHaveCount(1);
  await cdp.send('Input.insertText', { text: '中' });
  await expect.poll(() => composerText(composer)).toMatch(/^Previous line\n中.*\[A quote /s);
});

test('quote selection has no invisible tail and replaces the whole snapshot with undo', async ({
  page,
  context,
  browserName,
}, testInfo) => {
  await openQuoteStory(page, 'quote-selection');
  const composer = input(page);
  const chip = composer.locator('[data-mention-value]');
  await expect(chip).toHaveCount(1);
  const raw = await composerText(composer);
  const geometry = await chip.evaluate((node) => {
    const label = node.querySelector('[data-mention-label]')!;
    const paddingRight = Number.parseFloat(getComputedStyle(node).paddingRight);
    return {
      text: node.textContent,
      paddingRight,
      trailingWidth:
        node.getBoundingClientRect().right - label.getBoundingClientRect().right - paddingRight,
    };
  });
  expect(geometry.text).toBe('Selecting text and scrolling');
  expect(geometry.paddingRight).toBe(6);
  expect(geometry.trailingWidth).toBeLessThan(0.5);
  await composer.click();
  await composer.press('ControlOrMeta+a');
  await composer.press('ArrowRight');
  await composer.press('Shift+ArrowLeft');
  await expect(chip).toHaveAttribute('data-selected', '');
  await expect(page.getByRole('dialog')).toHaveCount(0);
  const selection = await chip.evaluate((node) => ({
    background: getComputedStyle(node).backgroundColor,
    nativeBackground: getComputedStyle(node, '::selection').backgroundColor,
    color: getComputedStyle(node).color,
    labelColor: getComputedStyle(node.querySelector('[data-mention-label]')!).color,
    textSelectionBackground: getComputedStyle(node.closest('p')!, '::selection').backgroundColor,
    textSelectionColor: getComputedStyle(node.closest('p')!, '::selection').color,
    shadow: getComputedStyle(node).boxShadow,
    radius: getComputedStyle(node).borderRadius,
  }));
  expect(selection.background).toBe(selection.textSelectionBackground);
  expect(selection.color).toBe(selection.textSelectionColor);
  expect(selection.shadow).toBe('none');
  expect(selection.radius).toBe('0px');
  expect(selection.nativeBackground).toBe('rgba(0, 0, 0, 0)');
  expect(selection.color).toBe(selection.labelColor);
  await page.screenshot({ path: testInfo.outputPath('quote-selected.png') });
  if (browserName === 'chromium') {
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    await composer.press('ControlOrMeta+c');
    expect(await page.evaluate(() => navigator.clipboard.readText())).toContain(
      '> Selecting text and scrolling'
    );
  }
  await page.keyboard.insertText('Replacement');
  await expectComposerText(composer, 'Before Replacement');
  await expect(chip).toHaveCount(0);
  await composer.press('ControlOrMeta+z');
  await expectComposerText(composer, raw);
  await expect(chip).toHaveCount(1);
  await composer.press('ControlOrMeta+a');
  await chip.click();
  await expect(page.getByRole('dialog')).toBeVisible();
  await expect(page.getByLabel('Original quote', { exact: true })).toHaveValue(
    'Selecting text and scrolling'
  );
});

test('dragging back across a quote keeps the range instead of opening its preview', async ({
  page,
}, testInfo) => {
  await openQuoteStory(page, 'quote-selection');
  const composer = input(page);
  await composer.click();
  await composer.press('ControlOrMeta+a');
  await composer.press('ArrowRight');
  await page.keyboard.insertText(' after');
  const chip = composer.locator('[data-mention-value]');
  const box = (await chip.boundingBox())!;
  const tail = await composer.locator('p').evaluate((p) => {
    const range = document.createRange();
    range.selectNodeContents(p.lastChild!);
    return range.getBoundingClientRect().toJSON();
  });
  await page.mouse.move(tail.right - 1, tail.top + tail.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2, { steps: 10 });
  await page.mouse.up();
  await expect(chip).toHaveAttribute('data-selected', '');
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await page.screenshot({ path: testInfo.outputPath('quote-drag-selection.png') });
  await page.keyboard.press('Backspace');
  await expect(chip).toHaveCount(0);
  expect(await composerText(composer)).toContain('Before ');
  await composer.press('ControlOrMeta+z');
  await expect(chip).toHaveCount(1);
  await page.mouse.click(tail.right - 1, tail.top + tail.height / 2);
  await page.keyboard.down('Shift');
  await page.mouse.click(box.x + 1, box.y + box.height / 2);
  await page.keyboard.up('Shift');
  await expect(chip).toHaveAttribute('data-selected', '');
  await expect(page.getByRole('dialog')).toHaveCount(0);
});

test('the quote action flips below a selection at the viewport top edge', async ({ page }) => {
  await openQuoteStory(page);
  const paragraph = page.locator('[data-conversation-turn-id="quote-source-8"] p').first();
  await expect(paragraph).toBeAttached();
  const viewport = page.locator('.chat-scrollbar');
  await viewport.dispatchEvent('wheel', { deltaY: -1 });
  await viewport.evaluate((element) => {
    const source = element.querySelector('[data-conversation-turn-id="quote-source-8"] p')!;
    element.scrollTop +=
      source.getBoundingClientRect().top - element.getBoundingClientRect().top - 2;
  });
  await expect.poll(async () => (await paragraph.boundingBox())!.y).toBeLessThan(10);
  await paragraph.evaluate((element) => {
    const node = element.firstChild!;
    getSelection()!.setBaseAndExtent(node, 0, node, Math.min(30, node.textContent!.length));
  });
  await expect(page.getByRole('button', { name: 'Quote', exact: true })).toBeVisible();
  const selectionBottom = await page.evaluate(
    () => getSelection()!.getRangeAt(0).getBoundingClientRect().bottom
  );
  const action = (await page.getByRole('button', { name: 'Quote', exact: true }).boundingBox())!;
  expect(action.y).toBeGreaterThan(selectionBottom);
});

test('a quote has read-only preview, explicit removal and atomic undo/redo', async ({ page }) => {
  await openQuoteStory(page);
  await selectPassage(page, 11);
  await page.getByRole('button', { name: 'Quote', exact: true }).click();
  const quoted = await composerText(input(page));
  await input(page).press('End');
  await input(page).press('Backspace');
  await expect.poll(() => composerText(input(page))).not.toBe(quoted);
  await input(page).press('ControlOrMeta+z');
  await expectComposerText(input(page), quoted);
  await input(page).press('ControlOrMeta+Shift+z');
  await expect.poll(() => composerText(input(page))).not.toBe(quoted);
  await input(page).press('ControlOrMeta+z');
  // A click inside the painted quote opens it, through the editor's chip hit testing.
  const chip = page
    .locator('[data-composer-editor] [data-mention-value]')
    .filter({ hasText: 'Passage ' })
    .first();
  const box = (await chip.boundingBox())!;
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  await expect(page.getByRole('dialog')).toBeVisible();
  await expect(page.getByLabel('Original quote', { exact: true })).toHaveAttribute('readonly', '');
  await page.getByRole('button', { name: 'Remove quote', exact: true }).click();
  await expect(page.getByRole('dialog')).not.toBeVisible();
  await expectComposerText(input(page), 'Explain this passage: ');
});

test('rejected sends preserve the narrow-screen quote draft', async ({ page }) => {
  await page.setViewportSize({ width: 360, height: 780 });
  await openQuoteStory(page, 'rejected');
  await selectPassage(page, 11);
  await page.getByRole('button', { name: 'Quote', exact: true }).click();
  const draft = await composerText(input(page));
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await expectComposerText(input(page), draft);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

test('a sent quote stays inside a narrow chat column in a wide window', async ({ page }) => {
  // Desktop split panes narrow the chat column while the window stays wide, so
  // window-width breakpoints must not lift the bubble's column bound.
  await page.setViewportSize({ width: 1280, height: 780 });
  await openQuoteStory(page);
  await selectPassage(page, 11);
  await page.getByRole('button', { name: 'Quote', exact: true }).click();
  await expect.poll(() => composerText(input(page))).toContain('[Passage ');
  await page.locator('#storybook-root').getByRole('button', { name: 'Send', exact: true }).click();
  const bubble = page.locator('[data-user-message-bubble]').last();
  await expect(bubble.getByRole('button').filter({ hasText: 'Passage ' })).toBeVisible();
  await page.evaluate(() => {
    document.body.style.width = '340px';
  });
  const metadata = page.getByTestId('user-message-metadata').last();
  await expect
    .poll(async () => {
      const [bubbleBox, stackBox] = [
        (await bubble.boundingBox())!,
        (await metadata.boundingBox())!,
      ];
      return bubbleBox.x + bubbleBox.width - (stackBox.x + stackBox.width);
    })
    .toBeLessThanOrEqual(0.5);
});

// Short, mention-only, mixed chips, collapsed, long path, long English, long CJK,
// an unbreakable URL, and mixed CJK/English/chips/URL — see `Chat/MessageTextChips`.
const SENT_ROW_COUNT = 9;
for (const wide of [false, true]) {
  for (const [width, height] of [
    [360, 780],
    [600, 780],
    [900, 780],
    [1280, 780],
    [1920, 1000],
  ] as const) {
    test(`sent bubbles hug the avatar without touching it at ${width}px${wide ? ' in wide mode' : ''}`, async ({
      page,
    }) => {
      await page.setViewportSize({ width, height });
      await page.addInitScript(
        (value) => localStorage.setItem('lody-conversation-wide-mode', value),
        String(wide)
      );
      await page.goto('/iframe.html?id=chat-messagetextchips--sent-rows&viewMode=story');
      await expect(page.locator('[data-user-message-bubble]').first()).toBeVisible({
        timeout: 15_000,
      });
      const viewport = page.locator('.chat-scrollbar');
      const scrollTop = () => viewport.evaluate((node) => node.scrollTop);
      const box = (await viewport.boundingBox())!;
      await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
      // The list is virtualized and opens at the latest row: measure the mounted
      // rows, then wheel up half a screen, until every row has been seen.
      const measured = new Set<string>();
      for (let step = 0; step < 40 && measured.size < SENT_ROW_COUNT; step += 1) {
        const rows = await page.evaluate(() =>
          [...document.querySelectorAll<HTMLElement>('[data-conversation-turn-id^="layout-user-"]')]
            .map((row) => {
              const bubble = row.querySelector('[data-user-message-bubble]');
              const stack = row.querySelector(
                '[data-testid="user-message-metadata"]'
              )?.parentElement;
              const avatar = stack?.previousElementSibling;
              if (!bubble || !stack || !avatar) return null;
              const rect = (node: Element) => node.getBoundingClientRect().toJSON() as DOMRect;
              return {
                id: row.dataset.conversationTurnId!,
                bubble: rect(bubble),
                stack: rect(stack),
                avatar: rect(avatar),
              };
            })
            .filter((row) => row !== null)
        );
        for (const { id, bubble: b, stack: s, avatar: a } of rows) {
          measured.add(id);
          expect(a.width, id).toBeGreaterThan(0);
          expect(b.right, id).toBeLessThanOrEqual(a.left - 4);
          expect(Math.abs(b.right - s.right), id).toBeLessThanOrEqual(0.5);
          expect(b.left, id).toBeGreaterThanOrEqual(s.left - 0.5);
          expect(b.width, id).toBeLessThanOrEqual(800.5);
        }
        const before = await scrollTop();
        if (before === 0) break;
        await page.mouse.wheel(0, -box.height / 2);
        // Rows measured on mount can re-anchor the offset, so wait for movement only.
        await expect.poll(scrollTop).not.toBe(before);
      }
      expect(measured.size).toBe(SENT_ROW_COUNT);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
        true
      );
    });
  }
}

test('a continuous selection across text rows in one response is quoted in full', async ({
  page,
}) => {
  await openQuoteStory(page);
  await expect(input(page)).toBeVisible();
  await page.evaluate(() => {
    const rows = document.querySelectorAll(
      '[data-conversation-turn-id="quote-source-11"] [data-message-quote-text]'
    );
    const start = rows[0]!.querySelector('p')!.firstChild!;
    const end = rows[1]!.querySelector('p')!.firstChild!;
    getSelection()!.setBaseAndExtent(start, 0, end, end.textContent!.length);
  });
  await page.getByRole('button', { name: 'Quote', exact: true }).click();
  const chip = page
    .locator('[data-composer-editor] [data-mention-value]')
    .filter({ hasText: 'Passage ' })
    .first();
  const box = (await chip.boundingBox())!;
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  const preview = page.getByLabel('Original quote', { exact: true });
  const expected = await preview.inputValue();
  expect(expected).toContain('Passage 11:');
  expect(expected).toContain('**Critical** [guide](https://example.com/guide)');
  expect(expected).toContain('* First item\n* Second item');
  expect(expected).toContain('```ts\nconst stable = true;\n```');
  expect(expected).toContain('A second rendered passage in the same response.');
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).not.toBeVisible();
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  const bubble = page.locator('[data-user-message-bubble]').last();
  await bubble.getByRole('button').filter({ hasText: 'Passage ' }).click();
  await expect(bubble).toContainText('Passage 11:');
  await expect(bubble).toContainText('**Critical** [guide](https://example.com/guide)');
  await expect(bubble).toContainText('A second rendered passage in the same response.');
});

test('a selection across separate message regions explains the boundary without truncating the draft', async ({
  page,
}) => {
  await openQuoteStory(page);
  await expect(input(page)).toBeVisible();
  const draft = await composerText(input(page));
  await page.evaluate(() => {
    const start = document.querySelector(
      '[data-conversation-turn-id="quote-source-10"] p'
    )!.firstChild!;
    const end = document.querySelector(
      '[data-conversation-turn-id="quote-source-11"] p'
    )!.firstChild!;
    getSelection()!.setBaseAndExtent(start, 0, end, end.textContent!.length);
  });
  const action = page.getByRole('button', { name: 'Quote passages separately', exact: true });
  await expect(action).toBeVisible();
  await action.click();
  await expectComposerText(input(page), draft);
});
