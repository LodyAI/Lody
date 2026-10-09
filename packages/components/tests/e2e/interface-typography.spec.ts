import { expect, test, type Locator, type Page } from '@playwright/test';

const tiers = ['Smaller', 'Small', 'Default', 'Large', 'Larger'];
const story = '/iframe.html?id=settings-interfacetypography--unified&viewMode=story';

const rhythmStory =
  '/iframe.html?id=sessions-assistantturnalignment--conversation-rhythm&viewMode=story';

for (const appTheme of ['light', 'dark'] as const) {
  for (const cardTheme of ['light', 'dark'] as const) {
    test(`share Markdown uses the card palette: ${cardTheme} card in ${appTheme} app`, async ({
      page,
    }) => {
      await page.route('https://**/*', (route) => route.abort());
      await page.emulateMedia({ colorScheme: appTheme === 'light' ? 'dark' : 'light' });
      await page.goto(
        `/iframe.html?id=sessions-chatsharecard--markdown-palette&viewMode=story&globals=theme:${appTheme}&args=theme:${cardTheme}`
      );
      await expect(page.locator('html')).toHaveClass(new RegExp(appTheme));
      const card = page.locator(`.${cardTheme}-scope`);
      const light = cardTheme === 'light';
      const reading = light ? 'rgb(29, 29, 32)' : 'rgb(228, 229, 231)';
      const strong = light ? 'rgb(26, 27, 30)' : 'rgb(240, 241, 242)';
      await expect(card.locator('.markdown-renderer')).toHaveCSS('color', reading);
      await expect(card.locator('strong')).toHaveCSS('color', strong);
      await expect(card.locator('h2')).toHaveCSS('color', strong);
      await expect(card.locator('blockquote')).toHaveCSS(
        'color',
        light ? 'rgb(107, 114, 128)' : 'rgb(156, 159, 163)'
      );
      await expect(card.locator('td').first()).toHaveCSS('color', reading);
      const code = card.locator('[data-streamdown="code-block"]');
      await expect(code).toHaveCSS('color', light ? 'rgb(26, 27, 30)' : 'rgb(215, 216, 217)');
      await expect(code).toHaveCSS(
        'background-color',
        light ? 'rgb(239, 239, 241)' : 'color(srgb 0.112915 0.120345 0.131685)'
      );
      await expect(code.locator('pre')).toHaveCSS('white-space', 'pre-wrap');
      await expect(code.getByRole('button', { name: 'Copy code' })).toBeHidden();
    });
  }

  test(`share palette switches keep the ${appTheme} app theme`, async ({ page }) => {
    await page.route('https://**/*', (route) => route.abort());
    await page.goto(
      `/iframe.html?id=sessions-chatshareimagedialog--default&viewMode=story&globals=theme:${appTheme}`
    );
    for (const [label, scope, color] of [
      ['Light', 'light-scope', 'rgb(29, 29, 32)'],
      ['Dark', 'dark-scope', 'rgb(228, 229, 231)'],
      ['Light', 'light-scope', 'rgb(29, 29, 32)'],
    ]) {
      await page.getByRole('radio', { name: label, exact: true }).click();
      await expect(page.locator(`.${scope} .markdown-renderer`).first()).toHaveCSS('color', color);
      await expect(page.locator('html')).toHaveClass(new RegExp(appTheme));
    }
  });
}

for (const appTheme of ['light', 'dark'] as const) {
  for (const cardTheme of ['light', 'dark'] as const) {
    for (const aspect of ['portrait', 'wide'] as const) {
      test(`usage share uses the card palette: ${cardTheme} ${aspect} in ${appTheme} app`, async ({
        page,
      }) => {
        await page.route('https://**/*', (route) => route.abort());
        await page.emulateMedia({ colorScheme: appTheme === 'light' ? 'dark' : 'light' });
        await page.goto(
          `/iframe.html?id=settings-usagesharecard--team-portrait&viewMode=story&globals=theme:${appTheme}&args=theme:${cardTheme};aspect:${aspect}`
        );
        const card = page.locator(`.${cardTheme}-scope`);
        const foreground = cardTheme === 'light' ? 'rgb(26, 27, 30)' : 'rgb(215, 216, 217)';
        await expect(card.getByText('1.3B', { exact: true })).toHaveCSS('color', foreground);
        await expect(card.getByText('Ada Lovelace', { exact: true })).toHaveCSS(
          'color',
          cardTheme === 'light' ? 'rgb(107, 114, 128)' : 'rgb(156, 159, 163)'
        );
        const initials = card.getByText('AD', { exact: true });
        await expect(initials).toHaveCSS('color', foreground);
        await expect(initials).toHaveCSS(
          'background-color',
          cardTheme === 'light' ? 'rgb(230, 232, 237)' : 'rgb(46, 46, 46)'
        );
        await expect(page.locator('html')).toHaveClass(new RegExp(appTheme));
      });
    }
  }

  test(`usage share without a pinned palette follows the ${appTheme} app`, async ({ page }) => {
    await page.route('https://**/*', (route) => route.abort());
    await page.goto(
      `/iframe.html?id=settings-usagesharecard--team-portrait&viewMode=story&globals=theme:${appTheme}&args=theme:!undefined`
    );
    const foreground = appTheme === 'light' ? 'rgb(26, 27, 30)' : 'rgb(215, 216, 217)';
    await expect(page.getByText('1.3B', { exact: true })).toHaveCSS('color', foreground);
    await expect(page.getByText('AD', { exact: true })).toHaveCSS('color', foreground);
    await expect(page.locator('.light-scope, .dark-scope')).toHaveCount(0);
  });

  test(`usage share palette switches keep the ${appTheme} app theme`, async ({ page }) => {
    await page.route('https://**/*', (route) => route.abort());
    await page.goto(
      `/iframe.html?id=settings-usageshareimagedialog--default&viewMode=story&globals=theme:${appTheme}`
    );
    await page.getByRole('combobox', { name: 'Card', exact: true }).click();
    await page.getByRole('option', { name: 'Workspace and members', exact: true }).click();
    for (const [label, scope, color] of [
      ['Light', 'light-scope', 'rgb(26, 27, 30)'],
      ['Dark', 'dark-scope', 'rgb(215, 216, 217)'],
      ['Light', 'light-scope', 'rgb(26, 27, 30)'],
    ]) {
      await page.getByRole('combobox', { name: 'Theme', exact: true }).click();
      await page.getByRole('option', { name: label, exact: true }).click();
      await expect(page.locator(`.${scope}`).getByText('AD', { exact: true })).toHaveCSS(
        'color',
        color
      );
      await expect(page.locator('html')).toHaveClass(new RegExp(appTheme));
    }
  });
}

for (const theme of ['light', 'dark']) {
  test(`subagent thought prose shares its activity summary and tool size: ${theme}`, async ({
    page,
  }) => {
    await page.goto(
      `/iframe.html?id=sessions-subagenttaskpanel--streamed-runs&viewMode=story&globals=theme:${theme}`
    );
    await page
      .getByRole('button', { name: 'Explore · Map the ACP capability refresh path', exact: true })
      .click();
    const dialog = page.locator('[data-subagent-task-dialog]');
    const summary = dialog.getByRole('button', {
      name: 'Ran 1 command · Read 1 file',
      exact: true,
    });
    const thought = dialog
      .locator('.markdown-renderer p')
      .filter({ hasText: 'Start from where the daemon reads capabilities.' });
    const tool = dialog.getByRole('button', { name: 'Read acp-capabilities.ts', exact: true });
    const summarySize = await summary
      .locator('span')
      .first()
      .evaluate((node) => getComputedStyle(node).fontSize);
    expect(summarySize).toBe('13px');
    await expect(thought).toHaveCSS('font-size', summarySize);
    await expect(thought).toHaveCSS('line-height', '18px');
    await expect(tool).toHaveCSS('font-size', summarySize);
  });
}

for (const [theme, width, size] of [
  ['dark', 1120, 14],
  ['light', 720, 16],
  ['dark', 420, 12],
  ['light', 1120, 13],
  ['dark', 720, 15],
] as const) {
  test(`conversation rhythm preserves text and action access: ${theme}, ${width}px, ${size}px`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 1500 });
    await page.addInitScript(
      (fontSize) => localStorage.setItem('lody-conversation-font-size', JSON.stringify(fontSize)),
      size
    );
    await page.goto(`${rhythmStory}&globals=theme:${theme}`);
    const user = page.locator('[data-conversation-turn-id="rhythm-user-1"]');
    const assistant = page.locator('[data-conversation-turn-id="rhythm-assistant-1"]');
    const worked = assistant.getByRole('button', { name: 'Finished working', exact: true });
    await worked.click();
    await assistant
      .getByRole('button', { name: 'Ran 1 command · Read 1 file', exact: true })
      .click();

    const rows = await assistant.evaluateAll((nodes) =>
      nodes.slice(0, 4).map((node) => node.getBoundingClientRect().height)
    );
    const bodyLeading = (20 * size) / 14;
    const readingLeading = (24 * size) / 14;
    const activityPitch = Math.max(24, (18 * size) / 14 + 6);
    for (const [index, height] of rows.entries()) {
      const groupGap = index === 1 ? 6 : 0;
      expect(height).toBeCloseTo(activityPitch + groupGap, 1);
    }
    const bubble = user.locator('[data-user-message-bubble]');
    const gap =
      (await worked.boundingBox())!.y -
      ((await bubble.boundingBox())!.y + (await bubble.boundingBox())!.height);
    expect(gap).toBeCloseTo(Math.max(32, bodyLeading * 1.8), 1);
    expect(
      await bubble.evaluate((node) => parseFloat(getComputedStyle(node).paddingTop))
    ).toBeCloseTo(Math.max(12, bodyLeading - 8), 2);
    expect(await bubble.innerText()).toContain('draft.\n\n验收');

    const actions = user.locator('[data-user-message-actions]');
    const actionsBox = (await actions.boundingBox())!;
    const userBox = (await user.boundingBox())!;
    expect(actionsBox.y + actionsBox.height).toBeLessThanOrEqual(userBox.y + userBox.height + 0.5);
    await user.hover();
    const copy = user.getByRole('button', { name: 'Copy message', exact: true });
    await copy.focus();
    await expect(copy).toBeFocused();
    await expect(copy).toHaveCSS('opacity', '1');
    const list = assistant.locator('.markdown-renderer ol > li');
    const positions = await list.evaluateAll((nodes) =>
      nodes.map((node) => node.getBoundingClientRect().y)
    );
    expect(positions[1] - positions[0]).toBeCloseTo(Math.max(24, readingLeading + 2), 1);
    await metrics(assistant.locator('.markdown-renderer p').first(), size, readingLeading);
    await metrics(bubble.locator('[data-search-block-id]'), size, readingLeading);
    const code = assistant.locator('[data-streamdown="code-block"]');
    await code.getByRole('button', { name: 'Wrap long lines', exact: true }).click();
    await expect(code.locator('pre')).toHaveCSS('white-space', 'pre-wrap');
    await expect(code.locator('pre')).toContainText('preserveDraft: true');
    await code.getByRole('button', { name: 'Disable line wrap', exact: true }).click();
    await expect(code.locator('pre')).toHaveCSS('white-space', 'pre');
    const quote = assistant.locator('blockquote');
    const nextBubble = page.locator(
      '[data-conversation-turn-id="rhythm-user-2"] [data-user-message-bubble]'
    );
    expect(
      (await nextBubble.boundingBox())!.y -
        ((await quote.boundingBox())!.y + (await quote.boundingBox())!.height)
    ).toBeCloseTo(Math.max(48, bodyLeading * 2.8), 1);
    await expect
      .poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth))
      .toBe(true);
    await worked.click();
    await expect(
      assistant.getByRole('button', { name: 'Ran 1 command · Read 1 file', exact: true })
    ).toHaveCount(0);
    await expect(quote).toBeVisible();
  });
}

test('a scoped StyleX conversation theme changes layout and surfaces', async ({ page }) => {
  await page.setViewportSize({ width: 1120, height: 1500 });
  await page.goto(
    `${rhythmStory.replace('--conversation-rhythm', '--conversation-rhythm-theme')}&globals=theme:dark`
  );
  const assistant = page.locator('[data-conversation-turn-id="rhythm-assistant-1"]');
  const worked = assistant.getByRole('button', { name: 'Finished working', exact: true });
  await worked.click();
  await assistant.getByRole('button', { name: 'Ran 1 command · Read 1 file', exact: true }).click();
  await expect(worked).toHaveCSS('height', '28px');
  await metrics(assistant.locator('.markdown-renderer p').first(), 14, 24);
  await metrics(
    page.locator('[data-user-message-bubble]').first().locator('[data-search-block-id]'),
    14,
    24
  );
  await metrics(assistant.locator('pre code'), 13, 18);
  await expect(page.locator('[data-user-message-bubble]').first()).toHaveCSS(
    'background-color',
    'rgb(24, 64, 80)'
  );
  await expect(assistant.locator('[data-streamdown="code-block"]')).toHaveCSS('margin-top', '24px');
  const bubble = (await page.locator('[data-user-message-bubble]').first().boundingBox())!;
  expect((await worked.boundingBox())!.y - (bubble.y + bubble.height)).toBeCloseTo(48, 1);
  const quote = (await assistant.locator('blockquote').boundingBox())!;
  const nextBubble = (await page.locator('[data-user-message-bubble]').nth(1).boundingBox())!;
  expect(nextBubble.y - (quote.y + quote.height)).toBeCloseTo(80, 1);
});

for (const [variant, hasFooter] of [
  ['without-footer', false],
  ['with-files', true],
] as const) {
  test(`conversation rhythm reserves one boundary with ${variant}`, async ({ page }) => {
    await page.setViewportSize({ width: 1120, height: 1500 });
    await page.goto(
      `${rhythmStory.replace('--conversation-rhythm', `--conversation-rhythm-${variant}`)}&globals=theme:dark`
    );
    const assistant = page.locator('[data-conversation-turn-id="rhythm-assistant-1"]');
    const quote = assistant.locator('blockquote');
    await expect(quote).toBeVisible();
    const userBubble = (await page.locator('[data-user-message-bubble]').first().boundingBox())!;
    const firstRow = (await assistant.first().boundingBox())!;
    expect(firstRow.y - (userBubble.y + userBubble.height)).toBeCloseTo(36, 1);
    const quoteBox = (await quote.boundingBox())!;
    const nextBubble = (await page.locator('[data-user-message-bubble]').nth(1).boundingBox())!;
    const gap = nextBubble.y - (quoteBox.y + quoteBox.height);
    if (hasFooter) {
      await expect(
        assistant.getByRole('button', { name: 'Copy response', exact: true })
      ).toHaveCount(1);
      await expect(assistant.getByText('search-index.test.ts', { exact: true })).toBeVisible();
      expect(gap).toBeGreaterThanOrEqual(56);
      const actions = (await assistant.locator('[data-assistant-turn-actions]').boundingBox())!;
      const metadata = (await page
        .locator('[data-testid="user-message-metadata"]')
        .nth(1)
        .boundingBox())!;
      expect(actions.y + actions.height).toBeLessThanOrEqual(metadata.y);
    } else {
      await expect(assistant.locator('[data-assistant-turn-actions]')).toHaveCount(0);
      expect(gap).toBeCloseTo(56, 1);
    }
  });
}

for (const mode of ['reading', 'reading-streaming']) {
  test(`conversation reading leading follows wrapped lines in ${mode}`, async ({ page }) => {
    await page.setViewportSize({ width: 1120, height: 1500 });
    await page.goto(
      `${rhythmStory.replace('--conversation-rhythm', `--conversation-rhythm-${mode}`)}&globals=theme:dark`
    );
    const assistant = page.locator('[data-conversation-turn-id="rhythm-assistant-1"]');
    const paragraph = assistant.locator('.markdown-renderer p').first();
    await metrics(paragraph, 14, 24);
    await expect
      .poll(() =>
        paragraph.evaluate((node) => {
          const range = document.createRange();
          range.selectNodeContents(node);
          return new Set(Array.from(range.getClientRects(), (rect) => rect.top)).size;
        })
      )
      .toBeGreaterThanOrEqual(3);
    const positions = await paragraph.evaluate((node) => {
      const range = document.createRange();
      range.selectNodeContents(node);
      return Array.from(new Set(Array.from(range.getClientRects(), (rect) => rect.top)));
    });
    for (let index = 1; index < positions.length; index += 1) {
      expect(positions[index] - positions[index - 1]).toBeCloseTo(24, 1);
    }
    await metrics(assistant.locator('pre code'), 13, 18);
    await expect(assistant.locator('.markdown-renderer p').nth(1)).toHaveCSS(
      'margin-bottom',
      '12px'
    );
  });
}

for (const mode of ['progress', 'progress-streaming']) {
  test(`progress prose and tool summaries keep reading gaps in ${mode}`, async ({ page }) => {
    await page.setViewportSize({ width: 1120, height: 1500 });
    await page.goto(
      `${rhythmStory.replace('--conversation-rhythm', `--conversation-rhythm-${mode}`)}&globals=theme:dark`
    );
    const assistant = page.locator('[data-conversation-turn-id="rhythm-assistant-1"]');
    if (mode === 'progress') {
      await assistant.getByRole('button', { name: 'Finished working', exact: true }).click();
    }
    const paragraphs = assistant.locator('.markdown-renderer p');
    const read = assistant.getByRole('button', { name: 'Read 1 file', exact: true });
    const run = assistant.getByRole('button', { name: 'Ran 1 command', exact: true });
    const blocks = [paragraphs.nth(0), read, paragraphs.nth(1), run, paragraphs.nth(2)];
    for (const [index, block] of blocks.entries()) {
      await expect(block).toBeVisible();
      if (index === 0) continue;
      const previous = (await blocks[index - 1]!.boundingBox())!;
      const current = (await block.boundingBox())!;
      expect(current.y - previous.y - previous.height).toBeCloseTo(6, 1);
    }
    await metrics(paragraphs.first(), 14, 24);
    await read.click();
    const step = assistant.getByRole('button', { name: 'Read search-index.ts', exact: true });
    await expect(step).toBeVisible();
    const headerBox = (await read.boundingBox())!;
    expect((await step.boundingBox())!.y - headerBox.y - headerBox.height).toBeCloseTo(0, 1);
    await read.click();
    await expect(step).toHaveCount(0);
    await expect(paragraphs.nth(1)).toBeVisible();
  });
}

async function metrics(element: Locator, font: number, leading?: number) {
  await expect(element).toBeVisible();
  await expect
    .poll(() => element.evaluate((node) => parseFloat(getComputedStyle(node).fontSize)))
    .toBeCloseTo(font, 2);
  if (leading !== undefined) {
    await expect
      .poll(() => element.evaluate((node) => parseFloat(getComputedStyle(node).lineHeight)))
      .toBeCloseTo(leading, 2);
  }
}

async function chooseSize(page: Page, tier: string) {
  await page.getByRole('button', { name: 'Appearance 设置', exact: true }).click();
  const picker = page.getByRole('combobox', { name: 'Font size', exact: true });
  await picker.focus();
  await expect(picker).toBeFocused();
  await picker.press('ArrowDown');
  const option = page.getByRole('option', { name: tier, exact: true });
  await option.click();
  await expect(picker).toContainText(tier);
  await page.getByRole('button', { name: 'Close', exact: true }).click();
}

async function surfaces(page: Page, size: number) {
  const control = (13 * size) / 14;
  const leading = (18 * size) / 14;
  await metrics(
    page.getByTestId('typography-sidebar').getByText('统一字号 Typography', { exact: true }),
    size,
    (20 * size) / 14
  );
  await metrics(
    page.getByTestId('typography-sidebar').getByText('Chats', { exact: true }),
    (12 * size) / 14,
    (16 * size) / 14
  );
  await metrics(
    page.getByTestId('typography-message').locator('p').first(),
    size,
    (24 * size) / 14
  );
  await metrics(
    page.getByTestId('typography-message').locator('h1'),
    (18 * size) / 14,
    (24 * size) / 14
  );
  for (const node of [
    page.getByTestId('typography-message').locator('pre code'),
    page.getByTestId('typography-message').locator('td').first(),
    page.getByTestId('typography-compact').locator('p').first(),
    page.getByTestId('typography-compact').locator('pre code'),
    page.getByTestId('typography-tool').locator('pre').first(),
    page.getByTestId('typography-terminal').locator('pre').first(),
    page.getByRole('button', { name: 'Codex Agent', exact: true }),
  ])
    await metrics(node, control, leading);
  await expect
    .poll(() =>
      page
        .getByTestId('typography-xterm')
        .locator('.xterm-char-measure-element')
        .first()
        .evaluate((node) => parseFloat(getComputedStyle(node).fontSize))
    )
    .toBeCloseTo(control, 2);
  const prompt = page.getByTestId('typography-composer').locator('textarea');
  await metrics(prompt, size, (20 * size) / 14);
  await prompt.focus();
  await expect(prompt).toBeFocused();
  expect(await prompt.evaluate((node) => node.clientHeight)).toBeGreaterThan((20 * size) / 14);
  await expect(prompt).toHaveValue(/中.*English|English.*中/);

  // Open the real toolbar popup: its portal must match the trigger, not the body parent.
  await page.getByRole('button', { name: 'Codex Agent', exact: true }).click();
  const option = page.getByRole('option', {
    name: 'Other 其他选项 Long description 中英混排选项说明',
  });
  await metrics(option, control, leading);
  const search = page.getByPlaceholder('Search 搜索');
  await metrics(search, control, leading);
  await search.fill('Other');
  await expect(option).toBeVisible();
  await search.press('Escape');

  await page.getByRole('button', { name: 'Menu 菜单' }).click();
  const menu = page.getByRole('menuitem', { name: 'Copy 复制 gypq' });
  await metrics(menu, control, leading);
  expect(await menu.evaluate((node) => node.clientHeight)).toBeGreaterThanOrEqual(leading);
  await menu.focus();
  await expect(menu).toBeFocused();
  await menu.press('Escape');
  await expect(page.getByRole('button', { name: 'Menu 菜单' })).toBeFocused();
  await page.getByRole('button', { name: 'Popover 弹层' }).click();
  await metrics(page.getByRole('dialog', { name: '标题 Mixed English' }), size, (20 * size) / 14);
  await metrics(page.getByRole('heading', { name: '标题 Mixed English' }), control, leading);
  await metrics(
    page.getByText('说明 中文 gypq', { exact: true }),
    (12 * size) / 14,
    (16 * size) / 14
  );
  await page.keyboard.press('Escape');
  await expect(page.getByRole('button', { name: 'Popover 弹层' })).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(page.getByRole('button', { name: 'Typography hint' })).toBeFocused();
  await metrics(
    page.getByTestId('typography-tooltip').locator('> div'),
    (12 * size) / 14,
    (16 * size) / 14
  );
  await page.keyboard.press('Escape');
  await metrics(page.getByTestId('typography-description'), (12 * size) / 14, (16 * size) / 14);
  await expect
    .poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth))
    .toBe(true);
}

for (const [theme, width] of [
  ['light', 1280],
  ['dark', 1280],
  ['light', 720],
] as const) {
  test(`five settings tiers scale real surfaces and portals: ${theme}, ${width}px`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 1000 });
    await page.route('https://**/*', (route) => route.abort());
    await page.goto(`${story}&globals=theme:${theme}`);
    for (const [index, tier] of tiers.entries()) {
      await chooseSize(page, tier);
      await surfaces(page, index + 12);
    }
    await expect
      .poll(() => page.evaluate(() => localStorage.getItem('lody-conversation-font-size')))
      .toBe('16');
    await page.reload();
    await surfaces(page, 16);
    await page.getByRole('button', { name: 'Appearance 设置', exact: true }).click();
    await expect(page.getByRole('combobox', { name: 'Font size', exact: true })).toContainText(
      'Larger'
    );
  });
}

test('legacy preferences retain their nearest tier across real settings and rendered surfaces', async ({
  page,
}) => {
  await page.goto(story);
  for (const [saved, size, tier] of [
    ['small', 12, 'Smaller'],
    ['large', 16, 'Larger'],
    [14.5, 15, 'Large'],
    [24, 16, 'Larger'],
  ] as const) {
    await page.evaluate(
      (value) => localStorage.setItem('lody-conversation-font-size', JSON.stringify(value)),
      saved
    );
    await page.reload();
    await surfaces(page, size);
    await page.getByRole('button', { name: 'Appearance 设置', exact: true }).click();
    await expect(page.getByRole('combobox', { name: 'Font size', exact: true })).toContainText(
      tier
    );
    await page.getByRole('button', { name: 'Close', exact: true }).click();
  }
});

test('sidebar navigation follows the same five settings tiers as session titles', async ({
  page,
}) => {
  await page.goto(story.replace('--unified', '--navigation'));
  for (const [index, tier] of tiers.entries()) {
    const size = index + 12;
    await chooseSize(page, tier);
    for (const name of ['New chat 新会话', 'Schedules 计划']) {
      const button = page.getByRole('button', { name, exact: true });
      await metrics(button, size, (20 * size) / 14);
      expect(await button.evaluate((node) => node.clientHeight)).toBeGreaterThanOrEqual(
        (20 * size) / 14
      );
      await button.focus();
      await expect(button).toBeFocused();
    }
    await surfaces(page, size);
  }
});

test('explicit message preview size is independent of the modern host scale', async ({ page }) => {
  await page.goto(story.replace('--unified', '--explicit-preview'));
  expect(
    await page.evaluate(() => CSS.supports('font-size', 'calc(14px * (12px / 14px))')),
    'The supported modern host must implement CSS typed division.'
  ).toBe(true);
  for (const [tier, hostSize] of [
    ['Larger', 16],
    ['Small', 13],
  ] as const) {
    await chooseSize(page, tier);
    const message = page.getByTestId('typography-message');
    await metrics(message.locator('p').first(), 12, (24 * 12) / 14);
    await metrics(message.locator('h1'), (18 * 12) / 14, (24 * 12) / 14);
    for (const node of [message.locator('pre code'), message.locator('td').first()])
      await metrics(node, (13 * 12) / 14, (18 * 12) / 14);
    await metrics(
      page.getByTestId('typography-composer').locator('textarea'),
      hostSize,
      (20 * hostSize) / 14
    );
    await metrics(
      page.getByTestId('typography-terminal').locator('pre').first(),
      (13 * hostSize) / 14,
      (18 * hostSize) / 14
    );
    await page.getByRole('button', { name: 'Menu 菜单' }).click();
    await metrics(
      page.getByRole('menuitem', { name: 'Copy 复制 gypq' }),
      (13 * hostSize) / 14,
      (18 * hostSize) / 14
    );
    await page.keyboard.press('Escape');
  }
});
