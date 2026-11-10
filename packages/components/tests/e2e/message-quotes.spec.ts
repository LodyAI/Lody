import { composerText, expectComposerText } from './composer-text';
import { expect, test, type Page } from '@playwright/test';

const story = (name = 'inline') => `/iframe.html?id=chat-messagequotes--${name}&viewMode=story`;
const input = (page: Page) => page.getByRole('combobox', { name: 'Message', exact: true });

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

test('native selection action does not resize or scroll the conversation, and quotes keep question order', async ({
  page,
}, testInfo) => {
  await page.goto(story());
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
  expect(value.match(/\[Quote:/g)).toHaveLength(2);
  expect(value.indexOf('Question A?')).toBeLessThan(value.lastIndexOf('[Quote:'));
  expect(value.lastIndexOf('[Quote:')).toBeLessThan(value.indexOf('Question B?'));
  // A translucent cover leaks the native placeholder brackets through the icon.
  const coverAlpha = await page
    .locator('[data-composer-editor] [data-mention-value]')
    .filter({ has: page.locator('svg') })
    .evaluateAll((chips) =>
      chips.map((chip) => {
        const context = new OffscreenCanvas(1, 1).getContext('2d')!;
        context.fillStyle = getComputedStyle(chip).backgroundColor;
        context.fillRect(0, 0, 1, 1);
        return context.getImageData(0, 0, 1, 1).data[3];
      })
    );
  expect(coverAlpha).toEqual([255, 255]);
  await page.screenshot({ path: testInfo.outputPath('inline-quotes.png') });
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await expectComposerText(input(page), '');
  const bubble = page.locator('[data-user-message-bubble]').last();
  await expect(bubble).toContainText('Question A?');
  await expect(bubble).toContainText('Question B?');
  const chips = bubble.getByRole('button').filter({ hasText: 'Quote:' });
  await expect(chips).toHaveCount(2);
  await chips.first().click();
  await expect(bubble).toContainText(first.trim());
  await chips.last().click();
  await expect(bubble).toContainText(second.trim());
});

test('the quote action flips below a selection at the viewport top edge', async ({ page }) => {
  await page.goto(story());
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
  await page.goto(story());
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
    .filter({ hasText: 'Quote:' })
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
  await page.goto(story('rejected'));
  await selectPassage(page, 11);
  await page.getByRole('button', { name: 'Quote', exact: true }).click();
  const draft = await composerText(input(page));
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await expectComposerText(input(page), draft);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

test('a continuous selection across text rows in one response is quoted in full', async ({
  page,
}) => {
  await page.goto(story());
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
    .filter({ hasText: 'Quote:' })
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
  await bubble.getByRole('button').filter({ hasText: 'Quote:' }).click();
  await expect(bubble).toContainText('Passage 11:');
  await expect(bubble).toContainText('**Critical** [guide](https://example.com/guide)');
  await expect(bubble).toContainText('A second rendered passage in the same response.');
});

test('a selection across separate message regions explains the boundary without truncating the draft', async ({
  page,
}) => {
  await page.goto(story());
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
