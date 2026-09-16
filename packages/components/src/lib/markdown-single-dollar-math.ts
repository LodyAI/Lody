type TexMathDelimiter = { index: number };

type MarkdownContainer =
  | { kind: 'blockquote' }
  | {
      kind: 'indent';
      size: number;
    };

type MarkdownFence = {
  containers: MarkdownContainer[];
  marker: '`' | '~';
  size: number;
};

const lineEndAfter = (value: string, start: number): number => {
  const newline = value.indexOf('\n', start);
  return newline === -1 ? value.length : newline + 1;
};

const lineContentEnd = (value: string, lineStart: number): number => {
  const newline = value.indexOf('\n', lineStart);
  const end = newline === -1 ? value.length : newline;
  return end > lineStart && value[end - 1] === '\r' ? end - 1 : end;
};

const indentedCodeLineEnd = (value: string, lineStart: number): number | null => {
  const contentEnd = lineContentEnd(value, lineStart);
  let column = 0;
  let cursor = lineStart;

  while (cursor < contentEnd) {
    if (value[cursor] === ' ') {
      column += 1;
    } else if (value[cursor] === '\t') {
      column += 4 - (column % 4);
    } else {
      return null;
    }

    cursor += 1;
    if (column >= 4) return lineEndAfter(value, lineStart);
  }

  return null;
};

const spacesEnd = (value: string, start: number, end: number, maximum: number): number => {
  let cursor = start;
  while (cursor < end && cursor - start < maximum && value[cursor] === ' ') cursor += 1;
  return cursor;
};

const listMarkerEnd = (value: string, start: number, end: number): number | null => {
  let cursor = start;
  const marker = value[cursor];

  if (marker === '-' || marker === '+' || marker === '*') {
    cursor += 1;
  } else {
    const digitStart = cursor;
    while (cursor < end && cursor - digitStart < 9 && /\d/.test(value[cursor])) cursor += 1;
    if (cursor === digitStart || (value[cursor] !== '.' && value[cursor] !== ')')) return null;
    cursor += 1;
  }

  if (value[cursor] !== ' ' && value[cursor] !== '\t') return null;

  const whitespaceStart = cursor;
  while (cursor < end && (value[cursor] === ' ' || value[cursor] === '\t')) cursor += 1;

  // CommonMark treats one to four spaces as list-marker padding. With five or
  // more, only the first belongs to the marker and the rest indent the content.
  return cursor - whitespaceStart <= 4 ? cursor : whitespaceStart + 1;
};

const markdownFenceAt = (value: string, lineStart: number): MarkdownFence | null => {
  const contentEnd = lineContentEnd(value, lineStart);
  let cursor = lineStart;
  const containers: MarkdownContainer[] = [];

  while (cursor < contentEnd) {
    const containerStart = cursor;
    cursor = spacesEnd(value, cursor, contentEnd, 3);

    if (value[cursor] === '>') {
      containers.push({ kind: 'blockquote' });
      cursor += 1;
      if (value[cursor] === ' ' || value[cursor] === '\t') cursor += 1;
      continue;
    }

    const markerEnd = listMarkerEnd(value, cursor, contentEnd);
    if (markerEnd != null) {
      containers.push({ kind: 'indent', size: markerEnd - containerStart });
      cursor = markerEnd;
      continue;
    }

    break;
  }

  const marker = value[cursor];
  if (marker !== '`' && marker !== '~') return null;

  let runEnd = cursor;
  while (runEnd < contentEnd && value[runEnd] === marker) runEnd += 1;
  const size = runEnd - cursor;
  if (size < 3) return null;

  // A backtick fence cannot contain another backtick in its info string.
  if (marker === '`' && value.slice(runEnd, contentEnd).includes('`')) return null;

  return { containers, marker, size };
};

const markdownContainerContentStart = (
  value: string,
  lineStart: number,
  contentEnd: number,
  containers: readonly MarkdownContainer[]
): number | null => {
  let cursor = lineStart;

  for (const container of containers) {
    if (container.kind === 'blockquote') {
      cursor = spacesEnd(value, cursor, contentEnd, 3);
      if (value[cursor] !== '>') return null;
      cursor += 1;
      if (value[cursor] === ' ' || value[cursor] === '\t') cursor += 1;
      continue;
    }

    for (let index = 0; index < container.size; index += 1) {
      if (value[cursor] !== ' ') return null;
      cursor += 1;
    }
  }

  return cursor;
};

const isClosingMarkdownFence = (
  value: string,
  lineStart: number,
  fence: MarkdownFence
): boolean => {
  const contentEnd = lineContentEnd(value, lineStart);
  const contentStart = markdownContainerContentStart(
    value,
    lineStart,
    contentEnd,
    fence.containers
  );
  if (contentStart == null) return false;
  let cursor = spacesEnd(value, contentStart, contentEnd, 3);

  const runStart = cursor;
  while (cursor < contentEnd && value[cursor] === fence.marker) cursor += 1;
  if (cursor - runStart < fence.size) return false;

  while (cursor < contentEnd && (value[cursor] === ' ' || value[cursor] === '\t')) {
    cursor += 1;
  }
  return cursor === contentEnd;
};

const fencedCodeEnd = (value: string, lineStart: number, fence: MarkdownFence): number => {
  let cursor = lineEndAfter(value, lineStart);

  while (cursor < value.length) {
    const nextLine = lineEndAfter(value, cursor);
    if (isClosingMarkdownFence(value, cursor, fence)) return nextLine;
    cursor = nextLine;
  }

  return value.length;
};

const backtickRunLength = (value: string, start: number): number => {
  let cursor = start;
  while (cursor < value.length && value[cursor] === '`') cursor += 1;
  return cursor - start;
};

const inlineCodeEnd = (value: string, start: number, size: number): number | null => {
  let cursor = start + size;

  while (cursor < value.length) {
    const next = value.indexOf('`', cursor);
    if (next === -1) return null;

    const nextSize = backtickRunLength(value, next);
    if (nextSize === size) return next + nextSize;
    cursor = next + nextSize;
  }

  return null;
};

const slashRunLength = (value: string, start: number): number => {
  let cursor = start;
  while (cursor < value.length && value[cursor] === '\\') cursor += 1;
  return cursor - start;
};

/**
 * Normalizes TeX's display `\\[...\\]` delimiters to the double-dollar form
 * understood by remark-math. This must run before Streamdown splits the
 * Markdown into blocks: otherwise a display formula containing a line such as
 * `=` can already have been classified as a Markdown heading.
 *
 * Only complete, matching display pairs outside code spans/blocks are rewritten.
 * Inline `\\(...\\)` delimiters deliberately remain literal because conversation
 * Markdown does not support inline formula rendering. Each rewritten delimiter
 * remains two characters wide, so source offsets used by later Markdown transforms
 * stay valid.
 */
export const normalizeTexMathDelimiters = (value: string): string => {
  // Only an opening `\[` can produce a replacement, so text without one is
  // returned unchanged. The scanner below walks the string character by
  // character and a streaming turn re-runs it over the whole accumulated
  // answer on every delta, which is quadratic in the answer's length.
  if (!value.includes('\\[')) return value;
  const replacements: number[] = [];
  let opening: TexMathDelimiter | null = null;
  let cursor = 0;
  let lineStart = 0;

  while (cursor < value.length) {
    if (cursor === lineStart) {
      const codeLineEnd = opening == null ? indentedCodeLineEnd(value, lineStart) : null;
      if (codeLineEnd != null) {
        cursor = codeLineEnd;
        lineStart = cursor;
        continue;
      }

      const fence = markdownFenceAt(value, lineStart);
      if (fence) {
        opening = null;
        cursor = fencedCodeEnd(value, lineStart, fence);
        lineStart = cursor;
        continue;
      }
    }

    const current = value[cursor];
    if (current === '\n') {
      cursor += 1;
      lineStart = cursor;
      continue;
    }

    if (current === '`') {
      const size = backtickRunLength(value, cursor);
      const end = inlineCodeEnd(value, cursor, size);
      if (end != null) {
        opening = null;
        cursor = end;
        lineStart = value.lastIndexOf('\n', cursor - 1) + 1;
        continue;
      }
      cursor += size;
      continue;
    }

    if (current !== '\\') {
      cursor += 1;
      continue;
    }

    const slashSize = slashRunLength(value, cursor);
    const delimiterIndex = cursor + slashSize - 1;
    const delimiterMarker = value[delimiterIndex + 1];

    // Pairs of slashes escape each other. With an odd run, only its final
    // slash participates in the TeX delimiter and any preceding pairs remain.
    if (
      slashSize % 2 === 0 ||
      (delimiterMarker !== '(' &&
        delimiterMarker !== ')' &&
        delimiterMarker !== '[' &&
        delimiterMarker !== ']')
    ) {
      cursor += slashSize;
      continue;
    }

    if (delimiterMarker === '[') {
      opening = { index: delimiterIndex };
    } else if (delimiterMarker === ']' && opening) {
      replacements.push(opening.index, delimiterIndex);
      opening = null;
    }

    cursor = delimiterIndex + 2;
  }

  if (replacements.length === 0) return value;

  const normalized = value.split('');
  replacements.forEach((index) => {
    normalized[index] = '$';
    normalized[index + 1] = '$';
  });
  return normalized.join('');
};
