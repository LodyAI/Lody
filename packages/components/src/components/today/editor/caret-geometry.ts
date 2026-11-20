/**
 * Caret geometry for the single-editor outline: where a click or a vertical
 * move lands, and whether the caret sits on a node's first or last visual line.
 * Layout APIs only; covered by browser tests, not jsdom.
 */

type CaretPoint = { node: Node; offset: number } | null;

function caretFromPoint(x: number, y: number): CaretPoint {
  const doc = document as Document & {
    caretPositionFromPoint?: (x: number, y: number) => { offsetNode: Node; offset: number } | null;
    caretRangeFromPoint?: (x: number, y: number) => Range | null;
  };
  const position = doc.caretPositionFromPoint?.(x, y);
  if (position) return { node: position.offsetNode, offset: position.offset };
  const range = doc.caretRangeFromPoint?.(x, y);
  return range ? { node: range.startContainer, offset: range.startOffset } : null;
}

const MENTION_SELECTOR = '[data-today-mention]';

const isMention = (node: Node): node is Element =>
  node.nodeType === Node.ELEMENT_NODE && (node as Element).matches(MENTION_SELECTOR);

/** Model length of a DOM subtree: text, one per `<br>` with a follower, one per mention. */
function modelLength(node: Node): number {
  if (node.nodeType === Node.TEXT_NODE) return node.textContent?.length ?? 0;
  if (isMention(node)) return 1;
  if ((node as Element).tagName === 'BR') return node.nextSibling ? 1 : 0;
  let total = 0;
  node.childNodes.forEach((child) => {
    total += modelLength(child);
  });
  return total;
}

/** The node text `root` shows, each mention read as U+FFFC. */
export function modelText(root: Node): string {
  if (root.nodeType === Node.TEXT_NODE) return root.textContent ?? '';
  if (isMention(root)) return '\uFFFC';
  if ((root as Element).tagName === 'BR') return root.nextSibling ? '\n' : '';
  let out = '';
  root.childNodes.forEach((child) => {
    out += modelText(child);
  });
  return out;
}

/**
 * String offset of a DOM point inside `root`: text counts per character, a
 * `<br>` as one newline, a mention (`[data-today-mention]`) as one character
 * whatever its title. A point inside a mention lands on the edge nearer `x`.
 */
function stringOffset(
  root: HTMLElement,
  point: { node: Node; offset: number },
  x: number
): number | null {
  if (!root.contains(point.node)) return null;
  // The outermost mention around the point (the editor nests the chip in its decorator).
  let mention: Element | null = null;
  for (
    let element =
      point.node.nodeType === Node.ELEMENT_NODE
        ? (point.node as Element)
        : point.node.parentElement;
    element && element !== root;
    element = element.parentElement
  ) {
    if (element.matches(MENTION_SELECTOR)) mention = element;
  }
  let total = 0;
  let found: number | null = null;
  const visit = (node: Node): boolean => {
    if (mention && node === mention) {
      const rect = mention.getBoundingClientRect();
      found = total + (x > rect.left + rect.width / 2 ? 1 : 0);
      return true;
    }
    if (node === point.node) {
      if (node.nodeType === Node.TEXT_NODE) {
        found = total + point.offset;
        return true;
      }
      // Element point: offset counts children before the caret.
      let inside = 0;
      node.childNodes.forEach((child, index) => {
        if (index < point.offset) inside += modelLength(child);
      });
      found = total + inside;
      return true;
    }
    if (node.nodeType === Node.TEXT_NODE || isMention(node) || (node as Element).tagName === 'BR') {
      total += modelLength(node);
      return false;
    }
    for (const child of node.childNodes) if (visit(child)) return true;
    return false;
  };
  for (const child of root.childNodes) if (visit(child)) break;
  return found ?? total;
}

const segmenter =
  typeof Intl !== 'undefined' && 'Segmenter' in Intl
    ? new Intl.Segmenter(undefined, { granularity: 'grapheme' })
    : null;

/** Snap to the nearest grapheme boundary so a caret never splits an emoji. */
function snapToGrapheme(text: string, offset: number): number {
  if (!segmenter) return offset;
  let best = 0;
  for (const segment of segmenter.segment(text)) {
    const end = segment.index + segment.segment.length;
    if (segment.index <= offset && offset < end) {
      return offset - segment.index < end - offset ? segment.index : end;
    }
    best = end;
  }
  return Math.min(offset, best);
}

/**
 * Offset under (x, y) in `element`. `y` may name the element's top or bottom
 * line, for a vertical move that keeps the caret's horizontal position.
 */
export function offsetFromPoint(
  element: HTMLElement,
  x: number,
  y: number | 'top' | 'bottom'
): number {
  const text = modelText(element);
  const rect = element.getBoundingClientRect();
  const lineY = y === 'top' ? rect.top + 6 : y === 'bottom' ? rect.bottom - 6 : y;
  const point = caretFromPoint(x, Math.min(Math.max(lineY, rect.top + 1), rect.bottom - 1));
  const offset = point ? stringOffset(element, point, x) : null;
  if (offset === null) return y === 'top' ? 0 : text.length;
  return snapToGrapheme(text, Math.min(offset, text.length));
}

/**
 * Whether the selection's moving end (its focus) is on the first/last visual
 * line of `root`, and its x. Measuring the focus, not the selection's start and
 * end, keeps "select down a few lines, then Shift+Up" from reading as the top.
 */
export function caretEdgeLines(root: HTMLElement): {
  first: boolean;
  last: boolean;
  caretX: number;
} {
  const selection = window.getSelection();
  if (!selection?.focusNode || !root.contains(selection.focusNode)) {
    return { first: true, last: true, caretX: 0 };
  }
  const range = document.createRange();
  range.setStart(selection.focusNode, selection.focusOffset);
  range.collapse(true);
  const rects = range.getClientRects();
  const caret = rects[0] ?? range.getBoundingClientRect();
  if (!caret || (caret.width === 0 && caret.height === 0)) {
    return { first: true, last: true, caretX: caret?.left ?? 0 };
  }
  const box = root.getBoundingClientRect();
  const lineHeight = Number.parseFloat(getComputedStyle(root).lineHeight) || 20;
  const lastRect = rects[rects.length - 1] ?? caret;
  return {
    first: caret.top - box.top < lineHeight * 0.75,
    last: box.bottom - lastRect.bottom < lineHeight * 0.75,
    caretX: caret.left,
  };
}
