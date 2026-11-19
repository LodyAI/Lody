import type { IBuffer, IBufferLine, IBufferRange } from '@xterm/xterm';

import { isMac } from '@/lib/commands';

const MAX_SCAN_LENGTH = 2048;

export function isLinkOpenModifierPressed(event: {
  metaKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
}): boolean {
  return isMac()
    ? event.metaKey && !event.ctrlKey && !event.altKey
    : event.ctrlKey && !event.metaKey && !event.altKey;
}

export function isHttpUrl(text: string): boolean {
  try {
    const { protocol } = new URL(text);
    return protocol === 'http:' || protocol === 'https:';
  } catch {
    return false;
  }
}

function trimUrl(text: string): string {
  const stack: string[] = [];
  const pairs: Record<string, string> = { ')': '(', ']': '[', '}': '{' };
  let end = text.length;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (char === '(' || char === '[' || char === '{') stack.push(char);
    else if (pairs[char]) {
      if (stack.pop() !== pairs[char]) {
        end = index;
        break;
      }
    }
  }
  return text.slice(0, end).replace(/[.,;:!?]+$/u, '');
}

function getLineContentLength(line: IBufferLine): number {
  for (let col = line.length - 1; col >= 0; col -= 1) {
    const cell = line.getCell(col);
    if (cell && cell.getWidth() !== 0 && cell.getChars() !== '') {
      return col + cell.getWidth();
    }
  }
  return 0;
}

export function readTerminalUrlLinks(
  buffer: IBuffer,
  lineNumber: number
): Array<{ text: string; range: IBufferRange }> {
  const anchorRow = lineNumber - 1;
  const readRows = (startRow: number, direction: 1 | -1) => {
    const cells: Array<{ text: string; x: number; y: number; endX: number }> = [];
    let scannedCells = 0;
    let scannedCodeUnits = 0;
    for (let row = startRow; ; row += direction) {
      const line = buffer.getLine(row);
      if (!line) return { cells, truncated: true };
      const next = buffer.getLine(row + 1);
      const length = next?.isWrapped ? line.length : getLineContentLength(line);
      for (let offset = 0; offset < length; offset += 1) {
        const col = direction === 1 ? offset : length - offset - 1;
        const cell = line.getCell(col);
        if (!cell || cell.getWidth() === 0) continue;
        const chars = cell.getChars();
        const padding =
          !chars && col === line.length - 1 && next?.isWrapped && next.getCell(0)?.getWidth() === 2;
        const content = padding ? '' : chars || ' ';
        if (
          scannedCells + cell.getWidth() > MAX_SCAN_LENGTH ||
          scannedCodeUnits + content.length > MAX_SCAN_LENGTH
        ) {
          return { cells, truncated: true };
        }
        scannedCells += cell.getWidth();
        scannedCodeUnits += content.length;
        cells.push({ text: content, x: col + 1, y: row + 1, endX: col + cell.getWidth() });
      }
      if (direction === 1 ? !next?.isWrapped : !line.isWrapped) return { cells, truncated: false };
    }
  };
  const before = buffer.getLine(anchorRow)?.isWrapped
    ? readRows(anchorRow - 1, -1)
    : { cells: [], truncated: false };
  const after = readRows(anchorRow, 1);
  const cells = [...before.cells.reverse(), ...after.cells];
  const text = cells.map((cell) => cell.text).join('');
  const positions = cells.flatMap((cell) => Array.from({ length: cell.text.length }, () => cell));
  const links: Array<{ text: string; range: IBufferRange }> = [];
  for (const match of text.matchAll(/https?:\/\/(?:(?![<>"'`])[\u0021-\u007e])+/giu)) {
    if (
      (before.truncated && match.index === 0) ||
      (after.truncated && match.index + match[0].length === text.length)
    )
      continue;
    const url = trimUrl(match[0]);
    if (!isHttpUrl(url)) continue;
    const start = positions[match.index];
    const end = positions[match.index + url.length - 1];
    if (!start || !end || lineNumber < start.y || lineNumber > end.y) continue;
    links.push({
      text: url,
      range: { start: { x: start.x, y: start.y }, end: { x: end.endX, y: end.y } },
    });
  }
  return links;
}
