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

/** String offset of a DOM point inside `root`, counting `<br>` as one newline. */
function stringOffset(root: HTMLElement, point: { node: Node; offset: number }): number | null {
  if (!root.contains(point.node)) return null;
  let total = 0;
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT);
  for (let current = walker.nextNode(); current; current = walker.nextNode()) {
    if (current === point.node) {
      if (current.nodeType === Node.TEXT_NODE) return total + point.offset;
      // Element point: offset counts children before the caret.
      let inside = 0;
      current.childNodes.forEach((child, index) => {
        if (index < point.offset) inside += child.textContent?.length ?? 0;
      });
      return total + inside;
    }
    if (current.nodeType === Node.TEXT_NODE) total += current.textContent?.length ?? 0;
    else if ((current as Element).tagName === 'BR' && current.nextSibling) total += 1;
  }
  return total;
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
  const text = element.textContent ?? '';
  const rect = element.getBoundingClientRect();
  const lineY = y === 'top' ? rect.top + 6 : y === 'bottom' ? rect.bottom - 6 : y;
  const point = caretFromPoint(x, Math.min(Math.max(lineY, rect.top + 1), rect.bottom - 1));
  const offset = point ? stringOffset(element, point) : null;
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
