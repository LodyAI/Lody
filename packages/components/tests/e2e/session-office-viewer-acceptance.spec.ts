import { expect, test, type Page } from '@playwright/test';

const story = (name: string) =>
  `/iframe.html?id=sessions-sessionfilebinarypreview--${name}&viewMode=story`;

async function expectClipboardTable(page: Page, rows: string[][]) {
  await expect
    .poll(() =>
      page.evaluate(async () => {
        const [item] = await navigator.clipboard.read();
        if (!item?.types.includes('text/plain') || !item.types.includes('text/html')) return null;
        const text = await (await item.getType('text/plain')).text();
        const html = await (await item.getType('text/html')).text();
        const table = new DOMParser().parseFromString(html, 'text/html').querySelector('table');
        return {
          text,
          rows: table
            ? Array.from(table.rows, (row) => Array.from(row.cells, (cell) => cell.textContent))
            : null,
        };
      })
    )
    .toEqual({ text: rows.map((row) => row.join('\t')).join('\n'), rows });
}

test('DOCX opens a read-only page with responsive zoom', async ({ page }) => {
  await page.goto(story('docx-document'));
  await expect(page.getByRole('region', { name: 'DOCX viewer' })).toBeVisible();
  await expect(page.getByText('Quarterly report', { exact: true })).toBeVisible();
  await expect(page.getByText('Revenue increased across all regions.')).toBeVisible();
  await page.getByRole('combobox', { name: 'Zoom level' }).click();
  await page.getByRole('option', { name: '125%' }).click();
  await expect(page.getByRole('combobox', { name: 'Zoom level' })).toContainText('125%');
});

test('DOCX selected text and XLSX cell ranges can be annotated for chat', async ({ page }) => {
  await page.goto(story('docx-selection'));
  const text = page.getByText('Revenue increased across all regions.', { exact: true });
  await expect(text).toBeVisible();
  const box = await text.boundingBox();
  if (!box) throw new Error('Missing DOCX text');
  await page.mouse.move(box.x + 1, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width - 1, box.y + box.height / 2, { steps: 8 });
  await page.mouse.up();
  await page.getByRole('button', { name: 'Add to chat', exact: true }).click();
  expect(
    await page.evaluate(
      () => (window as Window & { documentSelection?: { text: string } }).documentSelection?.text
    )
  ).toContain('Revenue increased');

  await page.goto(story('xlsx-selection'));
  const grid = page.getByRole('grid', { name: 'Revenue worksheet grid' });
  await expect(grid).toBeVisible();
  await grid.press('ControlOrMeta+Home');
  await grid.press('Shift+ArrowDown');
  await grid.press('Shift+ArrowRight');
  await page.getByRole('button', { name: 'Annotate selected cells' }).click();
  await expect(page.getByRole('region', { name: 'Selection annotation' })).toContainText(
    'Revenue!A1:B2'
  );
  await page.getByRole('button', { name: 'Add to chat', exact: true }).click();
  expect(
    await page.evaluate(
      () => (window as Window & { documentSelection?: { text: string } }).documentSelection?.text
    )
  ).toBe('Region\tRevenue\nNorth\t125000');
});

test('XLSX resizes and copies a worker-backed selection without editing cells', async ({
  page,
  context,
}) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await page.goto(story('xlsx-workbook'));
  await expect(page.getByRole('region', { name: 'XLSX viewer' })).toBeVisible();
  const grid = page.getByRole('grid', { name: 'Revenue worksheet grid' });
  await expect(grid).toBeVisible();
  await expect(grid).toHaveAttribute('aria-readonly', 'true');
  await expect(page.getByText('1 sheet')).toBeVisible();
  await grid.press('ControlOrMeta+Home');

  // The vendor paints cells on canvas; its visible selection overlay follows cell geometry.
  const selection = grid.locator('div[style*="contain: layout paint"][style*="box-shadow"]');
  await expect(selection).toBeVisible();
  await expect
    .poll(() =>
      selection.evaluate((element) =>
        Math.abs(
          element.getBoundingClientRect().width - parseFloat((element as HTMLElement).style.width)
        )
      )
    )
    .toBeLessThan(0.5);
  const before = await selection.boundingBox();
  const viewport = await grid.boundingBox();
  if (!before || !viewport) throw new Error('Worksheet selection has no visible bounds');
  await page.mouse.move(before.x + before.width, viewport.y + 12);
  await page.mouse.down();
  await page.mouse.move(before.x + before.width + 64, viewport.y + 12, { steps: 8 });
  await page.mouse.up();
  await expect
    .poll(() => selection.evaluate((element) => element.getBoundingClientRect().width))
    .toBeGreaterThan(before.width + 48);

  await grid.press('Shift+ArrowDown');
  await grid.press('Shift+ArrowDown');
  await grid.press('Shift+ArrowRight');
  await page.getByRole('button', { name: 'Copy selection' }).click();
  await expectClipboardTable(page, [
    ['Region', 'Revenue'],
    ['North', '125000'],
    ['South', '98000'],
  ]);

  await grid.press('ControlOrMeta+Home');
  await grid.press('ArrowDown');
  await grid.press('Shift+ArrowRight');
  await grid.press('F2');
  await grid.press('Delete');
  await grid.press('x');
  await expect(grid.locator('input, textarea, [contenteditable="true"]')).toHaveCount(0);
  await grid.press('ControlOrMeta+c');
  await expectClipboardTable(page, [['North', '125000']]);
  await page.getByRole('button', { name: 'Zoom in' }).click();
  await expect(page.getByText('110%')).toBeVisible();
  await expect(page.getByText('Document preview unavailable')).toHaveCount(0);
});

test('PowerPoint opens a virtual slide with thumbnail navigation', async ({ page }) => {
  await page.goto(story('pptx-presentation'));
  await expect(page.getByRole('region', { name: 'PowerPoint viewer' })).toBeVisible();
  await expect(
    page.getByTestId('pptx-viewport').getByText('Quarterly report', { exact: true })
  ).toBeVisible();
  await expect(page.getByRole('navigation', { name: 'Slide thumbnails' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Go to slide 1' })).toBeVisible();
});

test('PowerPoint regions retain their slide number and can be canceled', async ({ page }) => {
  await page.goto(story('pptx-selection'));
  const slide = page.getByTestId('pptx-viewport').locator('[data-lody-slide="0"]');
  await expect(slide).toBeVisible();
  const box = await slide.boundingBox();
  if (!box) throw new Error('Missing slide');
  await page.getByRole('button', { name: 'Select screenshot area' }).click();
  await page.mouse.move(box.x + 20, box.y + 20);
  await page.mouse.down();
  await page.mouse.move(box.x + 220, box.y + 120, { steps: 5 });
  await page.mouse.up();
  await expect(page.getByRole('region', { name: 'Selection annotation' })).toContainText('Slide 1');
  await expect(page.getByLabel('Selected screenshot')).toBeVisible();
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(page.getByRole('region', { name: 'Selection annotation' })).toHaveCount(0);
  expect(
    await page.evaluate(
      () => (window as Window & { documentSelection?: unknown }).documentSelection
    )
  ).toBeUndefined();
});

test('CSV cell annotations carry the selected rectangle and displayed values', async ({ page }) => {
  await page.goto('/iframe.html?id=sessions-sessionfilecsvpreview--csv-selection&viewMode=story');
  const grid = page.getByRole('grid');
  await grid.getByRole('gridcell', { name: 'North', exact: true }).click();
  await grid.press('Shift+ArrowRight');
  await grid.press('Shift+ArrowDown');
  await page.getByRole('button', { name: 'Annotate selected cells' }).click();
  await expect(page.getByRole('region', { name: 'Selection annotation' })).toContainText('A2:B3');
  await page.getByRole('button', { name: 'Add to chat', exact: true }).click();
  expect(
    await page.evaluate(
      () => (window as Window & { documentSelection?: { text: string } }).documentSelection?.text
    )
  ).toBe('North\tQ1\nSouth\tQ1');
});

for (const kind of ['docx', 'xlsx'] as const) {
  test(`${kind.toUpperCase()} regions export the rendered document content`, async ({ page }) => {
    await page.goto(story(`${kind}-selection`));
    const target =
      kind === 'docx'
        ? page.getByText('Quarterly report', { exact: true })
        : page.getByRole('grid', { name: 'Revenue worksheet grid' });
    await expect(target).toBeVisible();
    const box = await target.boundingBox();
    if (!box) throw new Error('Missing document bounds');
    await page.getByRole('button', { name: 'Select screenshot area' }).click();
    const x = box.x + 10,
      y = box.y + 10;
    await page.mouse.move(x, y);
    await page.mouse.down();
    await page.mouse.move(x + 300, y + 120, { steps: 5 });
    await page.mouse.up();
    const editor = page.getByRole('region', { name: 'Selection annotation' });
    await expect(editor).toBeVisible();
    if (kind === 'docx') await expect(editor).toContainText('Page 1');
    await page.getByRole('button', { name: 'Add to chat', exact: true }).click();
    await expect(editor).toHaveCount(0);
    const image = await page.evaluate(async () => {
      const file = (window as Window & { documentSelection?: { image: File } }).documentSelection!
        .image;
      const bitmap = await createImageBitmap(file),
        canvas = document.createElement('canvas');
      canvas.width = bitmap.width;
      canvas.height = bitmap.height;
      const context = canvas.getContext('2d')!;
      context.drawImage(bitmap, 0, 0);
      bitmap.close();
      const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
      return {
        type: file.type,
        width: canvas.width,
        height: canvas.height,
        hasContent: pixels.some(
          (value, index) => index % 4 === 0 && pixels[index + 3] > 200 && value < 80
        ),
      };
    });
    expect(image).toEqual({ type: 'image/png', width: 300, height: 120, hasContent: true });
  });
}

test('CSV resizes columns, selects rectangles, and copies while keeping search and zoom', async ({
  page,
  context,
}) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await page.goto('/iframe.html?id=sessions-sessionfilecsvpreview--csv-table&viewMode=story');
  const grid = page.getByRole('grid');
  const north = grid.getByRole('gridcell', { name: 'North', exact: true });
  const cell = (row: number, column: number) =>
    grid.locator(`[role="gridcell"][aria-rowindex="${row}"][aria-colindex="${column}"]`);
  await expect(north).toBeVisible();
  await expect(grid).toHaveAttribute('aria-readonly', 'true');
  await expect(page.getByRole('button', { name: 'Copy selection' })).toBeDisabled();
  const width = await north.evaluate((element) => element.getBoundingClientRect().width);
  const handle = await page.getByRole('separator', { name: 'Resize column A' }).boundingBox();
  if (!handle) throw new Error('Column resize handle has no visible bounds');
  await page.mouse.move(handle.x + handle.width / 2, handle.y + handle.height / 2);
  await page.mouse.down();
  await page.mouse.move(handle.x + handle.width / 2 + 64, handle.y + handle.height / 2, {
    steps: 8,
  });
  await page.mouse.up();
  await expect
    .poll(() => north.evaluate((element) => element.getBoundingClientRect().width))
    .toBeGreaterThan(width + 48);

  const start = await north.boundingBox();
  const end = await cell(3, 2).boundingBox();
  if (!start || !end) throw new Error('CSV selection cells have no visible bounds');
  await page.mouse.move(start.x + start.width / 2, start.y + start.height / 2);
  await page.mouse.down();
  await page.mouse.move(end.x + end.width / 2, end.y + end.height / 2, { steps: 8 });
  await expect(grid.getByRole('gridcell', { selected: true })).toHaveCount(4);
  await page.mouse.up();
  await page.getByRole('button', { name: 'Copy selection' }).click();
  await expectClipboardTable(page, [
    ['North', 'Q1'],
    ['South', 'Q1'],
  ]);

  await north.click();
  await cell(3, 3).click({ modifiers: ['Shift'] });
  await expect(grid.getByRole('gridcell', { selected: true })).toHaveCount(6);
  await grid.press('Shift+ArrowDown');
  await expect(grid.getByRole('gridcell', { selected: true })).toHaveCount(9);
  await grid.press('ControlOrMeta+c');
  await expectClipboardTable(page, [
    ['North', 'Q1', '125000'],
    ['South', 'Q1', '98000'],
    ['East', 'Q1', '112000'],
  ]);
  await grid.press('ArrowLeft');
  await expect(grid.getByRole('gridcell', { selected: true })).toHaveCount(1);
  await expect(cell(4, 2)).toHaveAttribute('aria-selected', 'true');
  await grid.press('F2');
  await grid.press('Delete');
  await grid.press('x');
  await expect(grid.locator('input, textarea, [contenteditable="true"]')).toHaveCount(0);
  await expect(cell(4, 2)).toHaveText('Q1');

  await page.getByRole('button', { name: 'Search cells', exact: true }).click();
  await page.getByRole('searchbox', { name: 'Search cells' }).fill('South');
  await expect(page.getByText('1/1')).toBeVisible();
  await page.getByRole('button', { name: 'Zoom in' }).click();
  await expect(page.getByText('125%')).toBeVisible();
});

test('TSV selects tab-delimited cells and copies a table with the keyboard', async ({
  page,
  context,
}) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await page.goto('/iframe.html?id=sessions-sessionfilecsvpreview--tsv-table&viewMode=story');
  await expect(page.getByRole('gridcell', { name: 'South' })).toBeVisible();
  await expect(page.getByText('3 rows · 3 columns')).toBeVisible();
  const grid = page.getByRole('grid');
  await grid.getByRole('gridcell', { name: 'North' }).click();
  await grid.press('Shift+ArrowDown');
  await grid.press('Shift+ArrowRight');
  await grid.press('ControlOrMeta+c');
  await expectClipboardTable(page, [
    ['North', 'Q1'],
    ['South', 'Q1'],
  ]);
});

test('inactive Office preview does not fetch an engine or start a worker', async ({ page }) => {
  const engineRequests: string[] = [];
  page.on('request', (request) => {
    if (/react-xlsx|duke_sheets|xlsx-worker/i.test(request.url())) {
      engineRequests.push(request.url());
    }
  });
  await page.goto(story('inactive-xlsx-workbook'));
  await expect(page.getByText('Loading document…')).toBeVisible();
  expect(engineRequests).toEqual([]);
});

test('inactive CSV preview does not start its parsing worker', async ({ page }) => {
  const workerRequests: string[] = [];
  page.on('request', (request) => {
    if (/session-file-csv\.worker|papaparse/i.test(request.url())) {
      workerRequests.push(request.url());
    }
  });
  await page.goto(
    '/iframe.html?id=sessions-sessionfilecsvpreview--inactive-csv-table&viewMode=story'
  );
  await expect(page.getByText('Loading table…')).toBeVisible();
  expect(workerRequests).toEqual([]);
});

for (const kind of ['docx', 'xlsx', 'pptx', 'csv']) {
  test(`${kind.toUpperCase()} selection actions fit a narrow reading toolbar`, async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(
      kind === 'csv'
        ? '/iframe.html?id=sessions-sessionfilecsvpreview--csv-selection&viewMode=story'
        : story(`${kind}-selection`)
    );
    await expect(page.locator('[data-document-capture]')).toBeVisible({ timeout: 15000 });
    // Wait for the selected format's actual reading surface before measuring.
    if (kind === 'docx')
      await expect(page.getByText('Quarterly report', { exact: true })).toBeVisible();
    else if (kind === 'xlsx' || kind === 'csv') await expect(page.getByRole('grid')).toBeVisible();
    else await expect(page.getByTestId('pptx-viewport')).toBeVisible();
    const toolbar = page.locator('[data-document-toolbar]');
    await expect(toolbar).toHaveCount(1);
    await page.screenshot({ path: `/tmp/lody-selection-redesign-${kind}-390.png` });
    const layout = await toolbar.evaluate((element) => {
      const box = element.getBoundingClientRect();
      const controls = Array.from(element.querySelectorAll('button, input'))
        .filter(
          (control) =>
            control.getAttribute('aria-hidden') !== 'true' &&
            control.getAttribute('type') !== 'hidden'
        )
        .map((control) => control.getBoundingClientRect())
        .filter((rect) => rect.width && rect.height);
      return {
        height: box.height,
        within: controls.every(
          (rect) =>
            rect.left >= box.left &&
            rect.right <= box.right &&
            rect.top >= box.top &&
            rect.bottom <= box.bottom
        ),
      };
    });
    expect(layout).toMatchObject({ within: true });
    expect(layout.height).toBeLessThanOrEqual(40);
  });
}
