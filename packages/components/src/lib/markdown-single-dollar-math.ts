type TexMathDelimiter = {
  kind: 'inline' | 'display';
  index: number;
  lineStart: number;
  blockStart: boolean;
};

type TextReplacement = {
  start: number;
  end: number;
  value: string;
};

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

const isMarkdownBlockStart = (value: string, lineStart: number, position: number): boolean => {
  let cursor = lineStart;

  while (cursor < position) {
    cursor = spacesEnd(value, cursor, position, 3);
    if (cursor === position) return true;

    if (value[cursor] === '>') {
      cursor += 1;
      if (value[cursor] === ' ' || value[cursor] === '\t') cursor += 1;
      continue;
    }

    const markerEnd = listMarkerEnd(value, cursor, position);
    if (markerEnd != null && markerEnd <= position) {
      cursor = markerEnd;
      continue;
    }

    return false;
  }

  return cursor === position;
};

const markdownContinuationPrefix = (value: string, lineStart: number, position: number): string => {
  let cursor = lineStart;
  let prefix = '';

  while (cursor < position) {
    const spacesStart = cursor;
    cursor = spacesEnd(value, cursor, position, 3);
    prefix += value.slice(spacesStart, cursor);
    if (cursor === position) return prefix;

    if (value[cursor] === '>') {
      prefix += '>';
      cursor += 1;
      if (value[cursor] === ' ' || value[cursor] === '\t') {
        prefix += ' ';
        cursor += 1;
      }
      continue;
    }

    const markerEnd = listMarkerEnd(value, cursor, position);
    if (markerEnd != null && markerEnd <= position) {
      prefix += ' '.repeat(markerEnd - cursor);
      cursor = markerEnd;
      continue;
    }

    break;
  }

  return prefix;
};

const hasLineBreakAt = (value: string, index: number): boolean =>
  value[index] === '\n' || (value[index] === '\r' && value[index + 1] === '\n');

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

const markdownLinkEnd = (value: string, start: number): number | null => {
  let depth = 0;
  let labelEnd: number | null = null;

  for (let cursor = start; cursor < value.length; cursor += 1) {
    if (value[cursor] === '\\') {
      cursor += 1;
      continue;
    }
    if (value[cursor] === '[') {
      depth += 1;
    } else if (value[cursor] === ']') {
      depth -= 1;
      if (depth === 0) {
        labelEnd = cursor + 1;
        break;
      }
    }
  }

  if (labelEnd == null) return null;

  const next = value[labelEnd];
  if (next === '[') {
    for (let cursor = labelEnd + 1; cursor < value.length; cursor += 1) {
      if (value[cursor] === '\\') {
        cursor += 1;
        continue;
      }
      if (value[cursor] === ']') return cursor + 1;
    }
    return null;
  }

  if (next !== '(') return null;

  depth = 0;
  for (let cursor = labelEnd; cursor < value.length; cursor += 1) {
    if (value[cursor] === '\\') {
      cursor += 1;
      continue;
    }
    if (value[cursor] === '(') {
      depth += 1;
    } else if (value[cursor] === ')') {
      depth -= 1;
      if (depth === 0) return cursor + 1;
    }
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
 * Only complete, matching pairs outside code spans/blocks are rewritten. Inline
 * `\\(...\\)` pairs are rewritten only when the user enables inline math. Each
 * delimiter replacement remains two characters wide; multiline display pairs
 * may also add Markdown line breaks around those replacements.
 */
export const normalizeTexMathDelimiters = (value: string, inlineMathEnabled = false): string => {
  // Only an opening display or enabled inline delimiter can produce a
  // replacement, so text without one is returned unchanged. The scanner below
  // walks the string character by character and a streaming turn re-runs it
  // over the whole accumulated
  // answer on every delta, which is quadratic in the answer's length.
  if (!value.includes('\\[') && (!inlineMathEnabled || !value.includes('\\('))) return value;
  const replacements: TextReplacement[] = [];
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
      if (opening?.kind === 'inline') opening = null;
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

    if (current === '[' && opening == null) {
      const end = markdownLinkEnd(value, cursor);
      if (end != null) {
        cursor = end;
        lineStart = value.lastIndexOf('\n', cursor - 1) + 1;
        continue;
      }
    }

    if (current !== '\\') {
      cursor += 1;
      continue;
    }

    const slashSize = slashRunLength(value, cursor);
    const delimiterIndex = cursor + slashSize - 1;
    const delimiterMarker = value[delimiterIndex + 1];
    const inlineDelimiter = delimiterMarker === '(' || delimiterMarker === ')';

    // Pairs of slashes escape each other. With an odd run, only its final
    // slash participates in the TeX delimiter and any preceding pairs remain.
    if (
      slashSize % 2 === 0 ||
      (delimiterMarker !== '(' &&
        delimiterMarker !== ')' &&
        delimiterMarker !== '[' &&
        delimiterMarker !== ']') ||
      (inlineDelimiter && !inlineMathEnabled)
    ) {
      cursor += slashSize;
      continue;
    }

    const kind = inlineDelimiter ? 'inline' : 'display';
    if (delimiterMarker === '(' || delimiterMarker === '[') {
      opening = {
        kind,
        index: delimiterIndex,
        lineStart,
        blockStart:
          delimiterMarker === '[' && isMarkdownBlockStart(value, lineStart, delimiterIndex),
      };
    } else if ((delimiterMarker === ')' || delimiterMarker === ']') && opening?.kind === kind) {
      if (kind === 'display' && !opening.blockStart && opening.lineStart !== lineStart) {
        const openingPrefix = markdownContinuationPrefix(value, opening.lineStart, opening.index);
        const closingPrefix = markdownContinuationPrefix(value, lineStart, delimiterIndex);
        let openingStart = opening.index;
        while (
          openingStart > opening.lineStart &&
          (value[openingStart - 1] === ' ' || value[openingStart - 1] === '\t')
        ) {
          openingStart -= 1;
        }

        if (openingStart > 0 && !hasLineBreakAt(value, openingStart - 1)) {
          replacements.push({
            start: openingStart,
            end: opening.index + 2,
            value: `\n${openingPrefix}$$`,
          });
        } else {
          replacements.push({ start: opening.index, end: opening.index + 2, value: '$$' });
        }

        const afterDelimiter = delimiterIndex + 2;
        if (afterDelimiter < value.length && !hasLineBreakAt(value, afterDelimiter)) {
          replacements.push({
            start: afterDelimiter,
            end: afterDelimiter,
            value: `\n${closingPrefix}`,
          });
        }
      } else {
        replacements.push({ start: opening.index, end: opening.index + 2, value: '$$' });
      }

      replacements.push({ start: delimiterIndex, end: delimiterIndex + 2, value: '$$' });

      opening = null;
    }

    cursor = delimiterIndex + 2;
  }

  if (replacements.length === 0) return value;

  replacements.sort((left, right) => left.start - right.start || left.end - right.end);
  let normalized = '';
  let sourceIndex = 0;

  for (const replacement of replacements) {
    normalized += value.slice(sourceIndex, replacement.start);
    normalized += replacement.value;
    sourceIndex = replacement.end;
  }

  return normalized + value.slice(sourceIndex);
};

type MdastNode = {
  type: string;
  value?: string;
  data?: Record<string, unknown>;
  children?: MdastNode[];
};

type InlineMathNode = MdastNode & {
  type: 'inlineMath';
  value: string;
  data: {
    hName: 'code';
    hProperties: { className: ['language-math', 'math-inline'] };
    hChildren: [{ type: 'text'; value: string }];
  };
};

const SKIP_CHILDREN_NODE_TYPES = new Set([
  'code',
  'definition',
  'html',
  'image',
  'imageReference',
  'inlineCode',
  'inlineMath',
  'link',
  'linkReference',
  'math',
]);

const isEscapedAt = (value: string, index: number): boolean => {
  let slashCount = 0;

  for (let cursor = index - 1; cursor >= 0 && value[cursor] === '\\'; cursor -= 1) {
    slashCount += 1;
  }

  return slashCount % 2 === 1;
};

const isSingleDollarDelimiter = (value: string, index: number): boolean =>
  value[index] === '$' &&
  value[index - 1] !== '$' &&
  value[index + 1] !== '$' &&
  !isEscapedAt(value, index);

const createInlineMathNode = (value: string): InlineMathNode => ({
  type: 'inlineMath',
  value,
  data: {
    hName: 'code',
    hProperties: { className: ['language-math', 'math-inline'] },
    hChildren: [{ type: 'text', value }],
  },
});

const splitSingleDollarMathText = (value: string): MdastNode[] | null => {
  if (!value.includes('$')) return null;

  const nodes: MdastNode[] = [];
  let cursor = 0;

  for (let index = 0; index < value.length; index += 1) {
    if (!isSingleDollarDelimiter(value, index)) continue;

    let close = index + 1;
    while (close < value.length && !isSingleDollarDelimiter(value, close)) close += 1;
    if (close === value.length) continue;

    const mathValue = value.slice(index + 1, close);
    if (!mathValue.trim()) continue;

    if (index > cursor) nodes.push({ type: 'text', value: value.slice(cursor, index) });
    nodes.push(createInlineMathNode(mathValue));
    cursor = close + 1;
    index = close;
  }

  if (nodes.length === 0) return null;
  if (cursor < value.length) nodes.push({ type: 'text', value: value.slice(cursor) });
  return nodes;
};

export const remarkSingleDollarTextMath = () => {
  const walk = (node: MdastNode) => {
    if (!Array.isArray(node.children) || SKIP_CHILDREN_NODE_TYPES.has(node.type)) return;

    const children = node.children;
    let nextChildren: MdastNode[] | null = null;

    children.forEach((child, index) => {
      if (child.type === 'text' && typeof child.value === 'string') {
        const replacement = splitSingleDollarMathText(child.value);
        if (replacement) {
          if (!nextChildren) nextChildren = children.slice(0, index);
          nextChildren.push(...replacement);
        } else {
          nextChildren?.push(child);
        }
        return;
      }

      walk(child);
      nextChildren?.push(child);
    });

    if (nextChildren) node.children = nextChildren;
  };

  return (tree: unknown) => {
    if (typeof tree === 'object' && tree !== null && 'type' in tree) {
      walk(tree as MdastNode);
    }
  };
};
