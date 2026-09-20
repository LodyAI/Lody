import { test, expect, type Page } from '@playwright/test';

const STORY = '/iframe.html?id=sessions-conversationview--native-text-selection&viewMode=story';
const paragraph = (index: number) => `[data-conversation-turn-id="selection-${index}"] p`;

async function openAtStart(page: Page) {
  await page.goto(STORY);
  await expect(page.locator(paragraph(119)).first()).toBeVisible();
  const viewport = page.locator('.chat-scrollbar');
  await viewport.hover();
  await page.mouse.wheel(0, -100);
  await page.getByTestId('selection-start').click();
  await expect(page.locator(paragraph(0)).first()).toBeVisible();
  // Cancel any pending navigation correction before beginning manual scrolling.
  await viewport.dispatchEvent('wheel', { deltaY: -1 });
}

test('native selection and clipboard include the middle after crossing the virtualization window', async ({
  page,
  context,
}) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await openAtStart(page);
  const start = page.locator(paragraph(0)).first();
  // Native double-click uses the pointer path with Playwright's layout stability checks.
  await start.dblclick({ position: { x: 25, y: 10 } });
  await expect
    .poll(() => page.evaluate(() => getSelection()!.toString().length))
    .toBeGreaterThan(0);
  await start.evaluate((element) => {
    const node = element.firstChild!;
    Reflect.set(window, '__selectionAnchor', node);
    getSelection()!.setBaseAndExtent(node, 0, node, node.textContent!.length);
  });
  await page.locator('.chat-scrollbar').evaluate((element) => {
    element.scrollTop = 6000;
  });
  await expect(page.locator(paragraph(40)).last()).toBeAttached();
  expect(
    await page.evaluate(() => (Reflect.get(window, '__selectionAnchor') as Node).isConnected)
  ).toBe(true);
  await page
    .locator(paragraph(40))
    .last()
    .evaluate((element) => {
      const node = element.firstChild!;
      getSelection()!.setBaseAndExtent(
        Reflect.get(window, '__selectionAnchor') as Node,
        0,
        node,
        node.textContent!.length
      );
    });
  const expectedMarkers = Array.from({ length: 41 }, (_, i) => `SELECT-${i}-START`);
  await expect
    .poll(() =>
      page.evaluate(() =>
        getSelection()!
          .toString()
          .match(/SELECT-\d+-START/g)
      )
    )
    .toEqual(expectedMarkers);
  await page.keyboard.press(process.platform === 'darwin' ? 'Meta+c' : 'Control+c');
  await expect
    .poll(() => page.evaluate(() => navigator.clipboard.readText()))
    .toContain('SELECT-40-END');
  expect(
    (await page.evaluate(() => navigator.clipboard.readText())).match(/SELECT-\d+-START/g)
  ).toEqual(expectedMarkers);
  await page.getByTestId('selection-clear').click();
  await expect(page.locator(paragraph(0))).toHaveCount(0);
});

test('reverse selection retains its original node when scrolling back through old rows', async ({
  page,
}) => {
  await page.goto(STORY);
  const endIndex = 119;
  await expect(page.locator(paragraph(endIndex)).last()).toBeVisible();
  await page
    .locator(paragraph(endIndex))
    .last()
    .evaluate((element) => {
      const node = element.firstChild!;
      Reflect.set(window, '__selectionAnchor', node);
      getSelection()!.setBaseAndExtent(node, 0, node, node.textContent!.length);
    });
  await page.locator('.chat-scrollbar').evaluate((element) => {
    element.scrollTop = 0;
  });
  await expect(page.locator(paragraph(0)).first()).toBeAttached();
  await page
    .locator(paragraph(0))
    .first()
    .evaluate((element) => {
      const anchor = Reflect.get(window, '__selectionAnchor') as Node;
      getSelection()!.setBaseAndExtent(anchor, anchor.textContent!.length, element.firstChild!, 0);
    });
  await expect
    .poll(() =>
      page.evaluate(() =>
        getSelection()!
          .toString()
          .match(/SELECT-\d+-START/g)
      )
    )
    .toEqual(Array.from({ length: endIndex + 1 }, (_, i) => `SELECT-${i}-START`));
  expect(
    await page.evaluate(() => (Reflect.get(window, '__selectionAnchor') as Node).isConnected)
  ).toBe(true);
});

test('finishing a selected turn keeps its prose mounted until selection is cleared', async ({
  page,
}) => {
  await openAtStart(page);
  const first = page.locator(paragraph(0)).first();
  await first.evaluate((element) => {
    const node = element.firstChild!;
    Reflect.set(window, '__selectionAnchor', node);
    getSelection()!.setBaseAndExtent(node, 0, node, node.textContent!.length);
  });
  await expect.poll(() => page.evaluate(() => getSelection()!.toString())).toBe('SELECT-0-START');
  // Trigger a writer update without a user click clearing the selection first.
  await page
    .getByTestId('selection-finish')
    .evaluate((element: HTMLButtonElement) => element.click());
  await expect(page.getByTestId('selection-finish')).toHaveAttribute('data-finished', 'true');
  await expect.poll(() => page.evaluate(() => getSelection()!.toString())).toBe('SELECT-0-START');
  expect(
    await page.evaluate(() => (Reflect.get(window, '__selectionAnchor') as Node).isConnected)
  ).toBe(true);
  await page.getByTestId('selection-clear').click();
  await expect(page.getByText('SELECT-0-START', { exact: true })).toHaveCount(0);
  await expect(
    page.getByRole('button', { name: /worked|finished working/i }).first()
  ).toBeAttached();
});
