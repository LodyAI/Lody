import { expect, test, type Locator, type Page } from '@playwright/test';

const tiers = ['Smaller', 'Small', 'Default', 'Large', 'Larger'];
const story = '/iframe.html?id=settings-interfacetypography--unified&viewMode=story';

async function renderedFonts(page: Page, selector: string) {
  const cdp = await page.context().newCDPSession(page);
  try {
    await cdp.send('DOM.enable');
    await cdp.send('CSS.enable');
    const { root } = await cdp.send('DOM.getDocument');
    const { nodeId } = await cdp.send('DOM.querySelector', { nodeId: root.nodeId, selector });
    expect(nodeId).toBeGreaterThan(0);
    const { fonts } = await cdp.send('CSS.getPlatformFontsForNode', { nodeId });
    return fonts;
  } finally {
    await cdp.detach();
  }
}

test('bundled Latin and CJK glyphs render offline, including a portal, without replacing mono', async ({
  page,
}) => {
  await page.route('https://**/*', (route) => route.abort());
  await page.goto(story);
  await expect(page.getByTestId('typography-message').locator('p').first()).toBeVisible();
  await page.evaluate(() => document.fonts.ready);
  const prose = await renderedFonts(page, '[data-testid="typography-message"] p');
  expect(
    prose.some((font) => font.isCustomFont && /Geist/.test(font.familyName) && font.glyphCount > 0)
  ).toBe(true);
  expect(
    prose.some((font) => font.isCustomFont && /vivo/.test(font.familyName) && font.glyphCount > 0)
  ).toBe(true);
  const code = await renderedFonts(page, '[data-testid="typography-message"] pre code');
  expect(code.every((font) => !/Geist|vivo/.test(font.familyName))).toBe(true);
  await page.getByRole('button', { name: 'Popover 弹层' }).click();
  await expect(page.getByRole('heading', { name: '标题 Mixed English' })).toBeVisible();
  await page.evaluate(() => document.fonts.ready);
  const popup = await renderedFonts(page, '[role="dialog"] h2');
  expect(popup.some((font) => font.isCustomFont && /Geist/.test(font.familyName))).toBe(true);
  expect(popup.some((font) => font.isCustomFont && /vivo/.test(font.familyName))).toBe(true);
});

test('font-load failure leaves mixed text, draft and keyboard controls readable', async ({
  page,
}) => {
  await page.route(/(?:Geist|vivo-).*\.woff2/, (route) => route.abort());
  await page.route('https://**/*', (route) => route.abort());
  await page.goto(story);
  const prose = page.getByTestId('typography-message').locator('p').first();
  await expect(prose).toContainText('正文 Mixed English 与中文');
  await page.evaluate(() => document.fonts.ready);
  const fonts = await renderedFonts(page, '[data-testid="typography-message"] p');
  expect(fonts.length).toBeGreaterThan(0);
  expect(fonts.every((font) => !font.isCustomFont)).toBe(true);
  const draft = page.getByTestId('typography-composer').locator('textarea');
  await expect(draft).toHaveValue(/Mixed English 中文/);
  await draft.focus();
  await expect(draft).toBeFocused();
  await page.getByRole('button', { name: 'Popover 弹层' }).click();
  await expect(page.getByRole('heading', { name: '标题 Mixed English' })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('button', { name: 'Popover 弹层' })).toBeFocused();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

test('swap keeps CJK readable before delayed subsets arrive without changing text roles', async ({
  page,
}) => {
  let release!: () => void;
  const arrival = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route(/vivo-.*\.woff2/, async (route) => {
    await arrival;
    await route.continue();
  });
  await page.goto(story, { waitUntil: 'domcontentloaded' });
  const prose = page.getByTestId('typography-message').locator('p').first();
  try {
    await expect(prose).toBeVisible();
    await expect(prose).toContainText('中文');
    const before = await prose.evaluate((node) => {
      const style = getComputedStyle(node);
      return [style.fontSize, style.lineHeight, style.fontWeight, style.letterSpacing];
    });
    const fontsBefore = await renderedFonts(page, '[data-testid="typography-message"] p');
    expect(fontsBefore.some((font) => !font.isCustomFont && font.glyphCount > 0)).toBe(true);
    release();
    await page.evaluate(() => document.fonts.ready);
    expect(
      (await renderedFonts(page, '[data-testid="typography-message"] p')).some(
        (font) => font.isCustomFont && /vivo/.test(font.familyName)
      )
    ).toBe(true);
    expect(
      await prose.evaluate((node) => {
        const style = getComputedStyle(node);
        return [style.fontSize, style.lineHeight, style.fontWeight, style.letterSpacing];
      })
    ).toEqual(before);
  } finally {
    release();
  }
});

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
    (20 * size) / 14
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
    await metrics(message.locator('p').first(), 12, (20 * 12) / 14);
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
