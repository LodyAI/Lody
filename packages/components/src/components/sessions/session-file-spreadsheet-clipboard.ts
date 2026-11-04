export interface SpreadsheetClipboard {
  readonly text: string;
  readonly html: string;
}

const escapeHtml = (value: string) =>
  value.replace(/[&<>"']/g, (character) => {
    return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character]!;
  });

/** TSV for text destinations, a table for spreadsheet apps (including embedded newlines). */
export function createSpreadsheetClipboard(
  rows: readonly (readonly string[])[]
): SpreadsheetClipboard {
  let cells = 0;
  let characters = 0;
  for (const row of rows) {
    cells += row.length;
    for (const cell of row) characters += cell.length;
    if (cells > 200_000 || characters > 10 * 1024 * 1024)
      throw new RangeError('Selection too large');
  }
  return {
    text: rows
      .map((row) =>
        row
          .map((cell) => (/[\t\r\n"]/.test(cell) ? `"${cell.replace(/"/g, '""')}"` : cell))
          .join('\t')
      )
      .join('\n'),
    html: `<table>${rows.map((row) => `<tr>${row.map((cell) => `<td style="white-space:pre-wrap">${escapeHtml(cell)}</td>`).join('')}</tr>`).join('')}</table>`,
  };
}

export async function writeSpreadsheetClipboard(
  data: SpreadsheetClipboard | Promise<SpreadsheetClipboard>
): Promise<void> {
  // Start the write during the gesture, before worker reads consume user activation in Safari.
  if (typeof ClipboardItem !== 'undefined' && typeof navigator.clipboard?.write === 'function') {
    const result = Promise.resolve(data);
    const write = navigator.clipboard.write([
      new ClipboardItem({
        'text/plain': result.then(({ text }) => new Blob([text], { type: 'text/plain' })),
        'text/html': result.then(({ html }) => new Blob([html], { type: 'text/html' })),
      }),
    ]);
    // Preserve data/read errors (such as the copy bound) instead of the browser's
    // generic ClipboardItem rejection, while still observing clipboard denial.
    await Promise.all([result, write]);
  } else {
    await navigator.clipboard.writeText((await data).text);
  }
}
