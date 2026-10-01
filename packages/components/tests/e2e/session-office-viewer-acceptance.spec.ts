import { expect, test } from '@playwright/test';

const story = (name: string) =>
  `/iframe.html?id=sessions-sessionfilebinarypreview--${name}&viewMode=story`;

test('DOCX opens a read-only page with responsive zoom', async ({ page }) => {
  await page.goto(story('docx-document'));
  await expect(page.getByRole('region', { name: 'DOCX viewer' })).toBeVisible();
  await expect(page.getByText('Quarterly report', { exact: true })).toBeVisible();
  await expect(page.getByText('Revenue increased across all regions.')).toBeVisible();
  await page.getByRole('combobox', { name: 'Zoom level' }).click();
  await page.getByRole('option', { name: '125%' }).click();
  await expect(page.getByRole('combobox', { name: 'Zoom level' })).toContainText('125%');
});

test('XLSX opens a worker-backed worksheet without editing controls', async ({ page }) => {
  await page.goto(story('xlsx-workbook'));
  await expect(page.getByRole('region', { name: 'XLSX viewer' })).toBeVisible();
  await expect(page.getByRole('grid', { name: 'Revenue worksheet grid' })).toBeVisible();
  await expect(page.getByText('1 sheet')).toBeVisible();
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

test('CSV displays cells, searches them, and keeps source-independent zoom', async ({ page }) => {
  await page.goto('/iframe.html?id=sessions-sessionfilecsvpreview--csv-table&viewMode=story');
  await expect(page.getByRole('gridcell', { name: 'North' })).toBeVisible();
  await page.getByRole('searchbox', { name: 'Search cells' }).fill('South');
  await expect(page.getByText('1/1')).toBeVisible();
  await page.getByRole('button', { name: 'Zoom in' }).click();
  await expect(page.getByText('125%')).toBeVisible();
});

test('TSV uses tab-delimited cells', async ({ page }) => {
  await page.goto('/iframe.html?id=sessions-sessionfilecsvpreview--tsv-table&viewMode=story');
  await expect(page.getByRole('gridcell', { name: 'South' })).toBeVisible();
  await expect(page.getByText('3 rows · 3 columns')).toBeVisible();
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
  await page.goto('/iframe.html?id=sessions-sessionfilecsvpreview--inactive-csv-table&viewMode=story');
  await expect(page.getByText('Loading table…')).toBeVisible();
  expect(workerRequests).toEqual([]);
});
