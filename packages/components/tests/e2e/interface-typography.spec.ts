import { expect, test, type Locator, type Page } from '@playwright/test';

const tiers = ['Smaller', 'Small', 'Default', 'Large', 'Larger'];
const story = '/iframe.html?id=settings-interfacetypography--unified&viewMode=story';

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
