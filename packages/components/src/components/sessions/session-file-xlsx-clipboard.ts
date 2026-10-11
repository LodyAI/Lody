import type { XlsxViewerController } from '@extend-ai/react-xlsx';
import { createSpreadsheetClipboard } from './session-file-spreadsheet-clipboard';

const MAX_COPY_CELLS = 200_000;
// The worker's public batch API reads complete rows, including unselected columns.
const MAX_READ_CELLS = 1_000_000;

type CopyController = Pick<
  XlsxViewerController,
  | 'activeCell'
  | 'activeSheet'
  | 'selection'
  | 'getRowsBatchAsync'
  | 'getActiveWorksheet'
  | 'getCellDisplayValue'
>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function cellAddress(row: number, col: number): string {
  let column = '';
  for (let index = col + 1; index > 0; index = Math.floor((index - 1) / 26)) {
    column = String.fromCharCode(65 + ((index - 1) % 26)) + column;
  }
  return `${column}${row + 1}`;
}

function displayValue(value: unknown): string {
  if (value == null) return '';
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (typeof value !== 'string') throw new Error('Invalid worksheet value');
  // Match react-xlsx's display normalization, decoding ampersands last.
  return value
    .replace(/&quot;|&#34;/g, '"')
    .replace(/&apos;|&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

/** Read displayed values without materializing a second workbook or changing the source. */
export async function readXlsxSelectionClipboard(controller: CopyController, signal?: AbortSignal) {
  signal?.throwIfAborted();
  const sheet = controller.activeSheet;
  const range =
    controller.selection ??
    (controller.activeCell ? { start: controller.activeCell, end: controller.activeCell } : null);
  if (!sheet || !range) throw new Error('No worksheet selection');

  const startRow = Math.min(range.start.row, range.end.row);
  const endRow = Math.max(range.start.row, range.end.row);
  const startCol = Math.min(range.start.col, range.end.col);
  const endCol = Math.max(range.start.col, range.end.col);
  const rowCount = endRow - startRow + 1;
  const colCount = endCol - startCol + 1;
  if (
    ![startRow, endRow, startCol, endCol].every(Number.isSafeInteger) ||
    startRow < 0 ||
    startCol < 0 ||
    rowCount * colCount > MAX_COPY_CELLS
  ) {
    throw new RangeError('Selection exceeds the copy limit');
  }

  const rows = Array.from({ length: rowCount }, () => Array<string>(colCount).fill(''));
  if (controller.getRowsBatchAsync) {
    // In 0.16.5, getClipboardData requires the main-thread workbook, which is null
    // in worker mode. Use the same formatted batches as the virtual grid instead.
    const lastReadRow = Math.min(endRow, sheet.rowCount - 1);
    const readWidth = Math.max(1, sheet.colCount);
    if (Math.max(0, lastReadRow - startRow + 1) * readWidth > MAX_READ_CELLS) {
      throw new RangeError('Worksheet row read exceeds the copy limit');
    }
    const batchSize = Math.max(1, Math.min(256, Math.floor(MAX_COPY_CELLS / readWidth)));
    for (let batchStart = startRow; batchStart <= lastReadRow; batchStart += batchSize) {
      const batch = await controller.getRowsBatchAsync(
        sheet.workbookSheetIndex,
        batchStart,
        Math.min(batchSize, lastReadRow - batchStart + 1)
      );
      signal?.throwIfAborted();
      if (!batch) throw new Error('Worksheet rows are unavailable');
      for (const row of batch) {
        if (
          !isRecord(row) ||
          typeof row.index !== 'number' ||
          !Number.isInteger(row.index) ||
          !Array.isArray(row.cells)
        ) {
          throw new Error('Invalid worksheet row');
        }
        const rowIndex = row.index;
        if (rowIndex < startRow || rowIndex > endRow) continue;
        for (const cell of row.cells) {
          if (!isRecord(cell) || typeof cell.col !== 'number' || !Number.isInteger(cell.col))
            throw new Error('Invalid worksheet cell');
          const col = cell.col;
          if (col < startCol || col > endCol || cell.isMergedSecondary === true) continue;
          let value = displayValue(cell.value);
          const cached =
            typeof cell.formula === 'string' && cell.formula
              ? sheet.cachedFormulaValues[cellAddress(rowIndex, col)]
              : undefined;
          if (cached !== undefined && value.startsWith('#')) value = cached;
          rows[rowIndex - startRow][col - startCol] = value;
        }
      }
    }
  } else {
    const worksheet = controller.getActiveWorksheet();
    if (!worksheet) throw new Error('Worksheet is unavailable');
    for (let row = startRow; row <= endRow; row += 1) {
      for (let col = startCol; col <= endCol; col += 1) {
        if (!worksheet.isMergedSecondary(row, col)) {
          rows[row - startRow][col - startCol] = controller.getCellDisplayValue({ row, col });
        }
      }
    }
  }
  signal?.throwIfAborted();
  return createSpreadsheetClipboard(rows);
}
