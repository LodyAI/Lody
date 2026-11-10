import { expect, test, type Locator, type Page } from '@playwright/test';

/*
 * Behaviour of the composer editor as a user drives it: real keyboard, pointer,
 * clipboard and IME input against the product-wired harness, asserting what the
 * composer's owner holds. These cases are implementation-agnostic on purpose:
 * they pinned the textarea composer before it was replaced and must keep
 * passing on its successor.
 */

type EditorState = {
  value: string;
  mentions: { start: number; end: number; value: string; kind?: string }[];
  clicked: string | null;
};

const BEHAVIOUR = '/iframe.html?id=mentions-mentiontwolevelmenu--editor-behaviour&viewMode=story';
const OVERFLOW = '/iframe.html?id=mentions-mentiontwolevelmenu--editor-overflow&viewMode=story';
const SKILL_TEXT = '$kill-ai-slop';

const editor = (page: Page) => page.getByRole('combobox', { name: 'composer' });

async function state(page: Page): Promise<EditorState> {
  return JSON.parse((await page.getByTestId('editor-state').textContent()) ?? '{}');
}

async function open(page: Page, url = BEHAVIOUR) {
  await page.goto(url);
  const input = editor(page);
  // The first story load also pays the dev server's cold start.
  await expect(input).toBeVisible({ timeout: 30_000 });
  await input.click();
  return input;
}

/** Type `$kill`, then pick the skill: a committed chip plus its trailing space. */
async function insertSkill(page: Page) {
  await page.keyboard.type('$kill');
  const option = page.getByRole('option', { name: /kill-ai-slop/ });
  await expect(option).toBeVisible();
  await option.click();
  await expect.poll(async () => (await state(page)).mentions.length).toBeGreaterThan(0);
}

const chip = (page: Page): Locator => page.locator('[data-mention-kind="skill"]').first();

test('typing, newlines and a committed chip reach the owner', async ({ page }) => {
  await open(page);
  await page.keyboard.type('看 ');
  await insertSkill(page);
  await page.keyboard.type('ok');
  await page.keyboard.press('Shift+Enter');
  await page.keyboard.type('次行');
  await page.keyboard.press('Enter');
  await page.keyboard.type('三');

  const value = `看 ${SKILL_TEXT} ok\n次行\n三`;
  await expect.poll(async () => (await state(page)).value).toBe(value);
  expect((await state(page)).mentions).toEqual([
    { start: 2, end: 2 + SKILL_TEXT.length, value: 'kill-ai-slop', kind: 'skill' },
  ]);
  await expect(chip(page)).toHaveText(SKILL_TEXT);
});

test('arrow keys cross a chip in one step and never stop inside it', async ({ page }) => {
  await open(page);
  await page.keyboard.type('a ');
  await insertSkill(page);
  // Caret: after the chip's trailing space. Left lands before the space, the next
  // Left crosses the whole chip.
  await page.keyboard.press('ArrowLeft');
  await page.keyboard.press('ArrowLeft');
  await page.keyboard.type('X');
  await expect.poll(async () => (await state(page)).value).toBe(`a X${SKILL_TEXT} `);
  await page.keyboard.press('ArrowRight');
  await page.keyboard.type('Y');
  await expect.poll(async () => (await state(page)).value).toBe(`a X${SKILL_TEXT}Y `);
  expect((await state(page)).mentions).toEqual([
    { start: 3, end: 3 + SKILL_TEXT.length, value: 'kill-ai-slop', kind: 'skill' },
  ]);
});

test('backspace removes a trailing space first, then the whole chip', async ({ page }) => {
  await open(page);
  await page.keyboard.type('a ');
  await insertSkill(page);
  await page.keyboard.press('Backspace');
  await expect.poll(async () => (await state(page)).value).toBe(`a ${SKILL_TEXT}`);
  expect((await state(page)).mentions).toHaveLength(1);
  await page.keyboard.press('Backspace');
  await expect.poll(async () => (await state(page)).value).toBe('a ');
  expect((await state(page)).mentions).toEqual([]);
});

test('delete before a chip removes it as one unit', async ({ page }) => {
  await open(page);
  await page.keyboard.type('a ');
  await insertSkill(page);
  await page.keyboard.type('b');
  await page.keyboard.press('ArrowLeft');
  await page.keyboard.press('ArrowLeft');
  await page.keyboard.press('ArrowLeft');
  await page.keyboard.press('Delete');
  await expect.poll(async () => (await state(page)).value).toBe('a  b');
  expect((await state(page)).mentions).toEqual([]);
});

test('a click on a chip keeps the caret at its edge and reports the chip', async ({ page }) => {
  await open(page);
  await page.keyboard.type('a ');
  await insertSkill(page);
  await page.keyboard.type('b');
  const box = (await chip(page).boundingBox())!;
  await page.mouse.click(box.x + box.width * 0.85, box.y + box.height / 2);
  await expect.poll(async () => (await state(page)).clicked).toBe('kill-ai-slop');
  await page.keyboard.type('Z');
  await expect.poll(async () => (await state(page)).value).toBe(`a ${SKILL_TEXT}Z b`);
});

test('undo restores the text and the chip together', async ({ page }) => {
  await open(page);
  await page.keyboard.type('a ');
  await insertSkill(page);
  await page.keyboard.type('tail');
  const undo = process.platform === 'darwin' ? 'Meta+z' : 'Control+z';
  const redo = process.platform === 'darwin' ? 'Meta+Shift+z' : 'Control+Shift+z';
  const before = await state(page);
  for (let step = 0; step < 8 && (await state(page)).mentions.length > 0; step += 1) {
    await page.keyboard.press(undo);
  }
  const undone = await state(page);
  expect(undone.mentions).toEqual([]);
  expect(undone.value.includes(SKILL_TEXT)).toBe(false);
  for (let step = 0; step < 8 && (await state(page)).value !== before.value; step += 1) {
    await page.keyboard.press(redo);
  }
  await expect.poll(async () => await state(page)).toEqual(before);
});

test('pasted plain text keeps its line breaks', async ({ page, context, browserName }) => {
  test.skip(browserName !== 'chromium', 'clipboard permissions are Chromium-only in Playwright');
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await open(page);
  await page.keyboard.type('x');
  await page.evaluate(() => navigator.clipboard.writeText('第一行\n第二行'));
  await page.keyboard.press(process.platform === 'darwin' ? 'Meta+v' : 'Control+v');
  await expect.poll(async () => (await state(page)).value).toBe('x第一行\n第二行');
});

test('IME composition reaches the owner only when committed', async ({ page, browserName }) => {
  test.skip(browserName !== 'chromium', 'IME is driven through the Chromium DevTools protocol');
  await open(page);
  await page.keyboard.type('a ');
  await insertSkill(page);
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Input.imeSetComposition', { text: 'ni', selectionStart: 2, selectionEnd: 2 });
  await cdp.send('Input.imeSetComposition', {
    text: 'nihao',
    selectionStart: 5,
    selectionEnd: 5,
  });
  expect((await state(page)).value).toBe(`a ${SKILL_TEXT} `);
  await cdp.send('Input.insertText', { text: '你好' });
  await expect.poll(async () => (await state(page)).value).toBe(`a ${SKILL_TEXT} 你好`);
  expect((await state(page)).mentions).toEqual([
    { start: 2, end: 2 + SKILL_TEXT.length, value: 'kill-ai-slop', kind: 'skill' },
  ]);
});

test('IME composition right before a chip keeps the chip whole', async ({ page, browserName }) => {
  test.skip(browserName !== 'chromium', 'IME is driven through the Chromium DevTools protocol');
  await open(page);
  await insertSkill(page);
  await page.keyboard.press('Home');
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Input.imeSetComposition', { text: 'zhong', selectionStart: 5, selectionEnd: 5 });
  // The chip stays painted whole while the preedit grows in front of it.
  await expect(chip(page)).toHaveText(SKILL_TEXT);
  await cdp.send('Input.insertText', { text: '中' });
  await expect.poll(async () => (await state(page)).value).toBe(`中${SKILL_TEXT} `);
  expect((await state(page)).mentions).toEqual([
    { start: 1, end: 1 + SKILL_TEXT.length, value: 'kill-ai-slop', kind: 'skill' },
  ]);
});

test('the composer exposes a labelled, expandable combobox', async ({ page }) => {
  const input = await open(page);
  await expect(input).toHaveAttribute('aria-expanded', 'false');
  await page.keyboard.type('$');
  await expect(input).toHaveAttribute('aria-expanded', 'true');
  await expect(input).toHaveAttribute('aria-autocomplete', 'list');
  await page.keyboard.press('Escape');
  await expect(input).toHaveAttribute('aria-expanded', 'false');
});

test('a click on a visible glyph puts the caret there while the composer overflows', async ({
  playwright,
  browserName,
  baseURL,
}) => {
  test.setTimeout(240_000);
  // Headless Chromium hides classic scrollbars, which also removes their layout width.
  const browser = await playwright[browserName].launch(
    browserName === 'chromium' ? { ignoreDefaultArgs: ['--hide-scrollbars'] } : {}
  );
  try {
    const page = await browser.newPage({ baseURL });
    const misplaced: string[] = [];
    // Line wrapping differs width by width, so cover a spread of composer widths.
    for (let width = 400; width <= 720; width += 16) {
      await page.setViewportSize({ width, height: 720 });
      await page.goto(OVERFLOW);
      const input = editor(page);
      await expect(input).toBeVisible({ timeout: 30_000 });
      await input.click();
      await page.keyboard.press(process.platform === 'darwin' ? 'Meta+ArrowDown' : 'Control+End');
      const { value } = await state(page);
      const target = value.length - 30;
      // Where the composer visibly paints the character at `target`.
      const box = await page.getByTestId('editor-frame').evaluate((frame, target) => {
        const walker = document.createTreeWalker(frame, NodeFilter.SHOW_TEXT);
        const text = (document.querySelector('[data-testid="editor-state"]') as HTMLElement)
          .textContent!;
        const source: string = JSON.parse(text).value;
        let seen = 0;
        const wanted = source.slice(0, target + 1).replace(/\n/g, '').length - 1;
        for (let node = walker.nextNode(); node; node = walker.nextNode()) {
          const content = (node.textContent ?? '').replace(/\n/g, '');
          if (node.parentElement?.closest('output, textarea')) continue;
          if (seen + content.length > wanted) {
            const index = wanted - seen;
            const range = document.createRange();
            range.setStart(node, index);
            range.setEnd(node, index + 1);
            const rect = range.getBoundingClientRect();
            return { x: rect.left + rect.width * 0.75, y: rect.top + rect.height / 2 };
          }
          seen += content.length;
        }
        return null;
      }, target);
      if (!box) {
        misplaced.push(`${width}px: glyph not painted`);
        continue;
      }
      await page.mouse.click(box.x, box.y);
      await page.keyboard.type('Ж');
      await expect.poll(async () => (await state(page)).value.includes('Ж')).toBe(true);
      const landed = (await state(page)).value.indexOf('Ж');
      if (landed !== target + 1)
        misplaced.push(`${width}px: caret at ${landed}, glyph ${target + 1}`);
    }
    expect(misplaced).toEqual([]);
  } finally {
    await browser.close();
  }
});
