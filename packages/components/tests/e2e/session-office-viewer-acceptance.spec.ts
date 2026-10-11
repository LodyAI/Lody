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
