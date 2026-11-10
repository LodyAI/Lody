import {
  $createLineBreakNode,
  $createParagraphNode,
  $createRangeSelection,
  $createTextNode,
  $getRoot,
  $getSelection,
  $isElementNode,
  $isLineBreakNode,
  $isNodeSelection,
  $isRangeSelection,
  $isTextNode,
  $setSelection,
  type ElementNode,
  type LexicalNode,
  type PointType,
} from 'lexical';
import { dropOverlappingRanges } from '@lody/shared';
import { $createMentionNode, $isMentionNode, type MentionNodeRange } from './mention-node';

/**
 * The one boundary between the composer's string model (text plus UTF-16,
 * half-open mention ranges) and its Lexical document: a single paragraph of
 * text, line breaks and mention nodes. Every offset the composer computes goes
 * through these functions, so the string and the document cannot disagree.
 */

export type ComposerMentionRange = MentionNodeRange;

export type ComposerValue<M extends ComposerMentionRange = ComposerMentionRange> = {
  text: string;
  mentions: M[];
};

export type SelectionOffsets = { start: number; end: number };

const isOffset = (value: unknown): value is number =>
  typeof value === 'number' && Number.isInteger(value) && value >= 0;

/**
 * Ranges that still describe a real region of `text`, ordered, without overlaps.
 * Same rule as persisted ranges (`sanitizeMentionRanges`), except that a kind is
 * optional here: a range committed by a menu item may carry none.
 */
export function sanitizeComposerMentions<M extends ComposerMentionRange>(
  text: string,
  mentions: readonly M[]
): M[] {
  const valid = mentions.filter(
    (mention) =>
      isOffset(mention.start) &&
      isOffset(mention.end) &&
      mention.end > mention.start &&
      mention.end <= text.length &&
      typeof mention.value === 'string' &&
      mention.value.length > 0
  );
  return dropOverlappingRanges(valid);
}

function appendPlainText(paragraph: ElementNode, text: string) {
  const lines = text.split('\n');
  lines.forEach((line, index) => {
    if (index > 0) paragraph.append($createLineBreakNode());
    if (line.length > 0) paragraph.append($createTextNode(line));
  });
}

/** Replace the whole document with `text` and its mention ranges. */
export function $writeComposerValue<M extends ComposerMentionRange>(
  text: string,
  mentions: readonly M[]
): void {
  const root = $getRoot();
  root.clear();
  const paragraph = $createParagraphNode();
  let cursor = 0;
  for (const mention of sanitizeComposerMentions(text, mentions)) {
    appendPlainText(paragraph, text.slice(cursor, mention.start));
    paragraph.append($createMentionNode(text.slice(mention.start, mention.end), mention));
    cursor = mention.end;
  }
  appendPlainText(paragraph, text.slice(cursor));
  root.append(paragraph);
}

function $paragraphs(): ElementNode[] {
  return $getRoot()
    .getChildren()
    .filter((node): node is ElementNode => $isElementNode(node));
}

function nodeLength(node: LexicalNode): number {
  if ($isLineBreakNode(node)) return 1;
  return node.getTextContentSize();
}

/** Read the document back as the composer's string and ranges. */
export function $readComposerValue<
  M extends ComposerMentionRange = ComposerMentionRange,
>(): ComposerValue<M> {
  let text = '';
  const mentions: M[] = [];
  $paragraphs().forEach((paragraph, index) => {
    // The editor keeps one paragraph; tolerate more by joining them with a
    // newline so no input is lost if one ever appears.
    if (index > 0) text += '\n';
    for (const child of paragraph.getChildren()) {
      if ($isLineBreakNode(child)) {
        text += '\n';
      } else if ($isMentionNode(child)) {
        const content = child.getTextContent();
        mentions.push({
          ...(child.getRange() as M),
          start: text.length,
          end: text.length + content.length,
        });
        text += content;
      } else {
        text += child.getTextContent();
      }
    }
  });
  return { text, mentions };
}

/** Offset of the start of `node` in the composer string. */
function $nodeStartOffset(node: LexicalNode): number {
  let offset = 0;
  const paragraphs = $paragraphs();
  for (let index = 0; index < paragraphs.length; index += 1) {
    const paragraph = paragraphs[index]!;
    if (index > 0) offset += 1;
    for (const child of paragraph.getChildren()) {
      if (child.is(node)) return offset;
      offset += nodeLength(child);
    }
    if (paragraph.is(node)) return offset - paragraph.getTextContentSize();
  }
  return offset;
}

/** Map a Lexical selection point to a composer-string offset. */
export function $pointToOffset(point: PointType): number {
  const node = point.getNode();
  if (point.type === 'text') return $nodeStartOffset(node) + point.offset;
  if ($isElementNode(node)) {
    if (node.is($getRoot())) {
      const paragraphs = $paragraphs();
      let offset = 0;
      for (let index = 0; index < point.offset && index < paragraphs.length; index += 1) {
        offset += (index > 0 ? 1 : 0) + paragraphLength(paragraphs[index]!);
      }
      return offset;
    }
    let offset = $paragraphStartOffset(node);
    const children = node.getChildren();
    for (let index = 0; index < point.offset && index < children.length; index += 1) {
      offset += nodeLength(children[index]!);
    }
    return offset;
  }
  return $nodeStartOffset(node);
}

function paragraphLength(paragraph: ElementNode): number {
  return paragraph.getChildren().reduce((sum, child) => sum + nodeLength(child), 0);
}

function $paragraphStartOffset(target: ElementNode): number {
  let offset = 0;
  const paragraphs = $paragraphs();
  for (let index = 0; index < paragraphs.length; index += 1) {
    const paragraph = paragraphs[index]!;
    if (index > 0) offset += 1;
    if (paragraph.is(target)) return offset;
    offset += paragraphLength(paragraph);
  }
  return offset;
}

type PointTarget = { key: string; offset: number; type: 'text' | 'element' };

/**
 * Map a composer-string offset to a Lexical point. An offset inside a chip moves
 * to the chip's nearer edge, as a collapsed caret never rests inside a mention.
 */
export function $offsetToPoint(rawOffset: number): PointTarget {
  const paragraphs = $paragraphs();
  if (paragraphs.length === 0) {
    const paragraph = $createParagraphNode();
    $getRoot().append(paragraph);
    paragraphs.push(paragraph);
  }
  let offset = Math.max(0, rawOffset);
  let base = 0;
  for (let index = 0; index < paragraphs.length; index += 1) {
    const paragraph = paragraphs[index]!;
    if (index > 0) base += 1;
    const children = paragraph.getChildren();
    let accumulated = base;
    for (let childIndex = 0; childIndex < children.length; childIndex += 1) {
      const child = children[childIndex]!;
      const length = nodeLength(child);
      if ($isTextNode(child) && !$isMentionNode(child)) {
        if (offset >= accumulated && offset <= accumulated + length) {
          return { key: child.getKey(), offset: offset - accumulated, type: 'text' };
        }
      } else {
        if ($isMentionNode(child) && offset > accumulated && offset < accumulated + length) {
          offset =
            offset - accumulated <= accumulated + length - offset
              ? accumulated
              : accumulated + length;
        }
        if (offset === accumulated) {
          return { key: paragraph.getKey(), offset: childIndex, type: 'element' };
        }
      }
      accumulated += length;
    }
    const isLast = index === paragraphs.length - 1;
    if (offset <= accumulated || isLast) {
      return { key: paragraph.getKey(), offset: children.length, type: 'element' };
    }
    base = accumulated;
  }
  const last = paragraphs[paragraphs.length - 1]!;
  return { key: last.getKey(), offset: last.getChildrenSize(), type: 'element' };
}

/** The current selection as composer-string offsets, or null without one. */
export function $readSelectionOffsets(): SelectionOffsets | null {
  const selection = $getSelection();
  if ($isRangeSelection(selection)) {
    const anchor = $pointToOffset(selection.anchor);
    const focus = $pointToOffset(selection.focus);
    return { start: Math.min(anchor, focus), end: Math.max(anchor, focus) };
  }
  if ($isNodeSelection(selection)) {
    const nodes = selection.getNodes();
    if (nodes.length === 0) return null;
    const starts = nodes.map((node) => $nodeStartOffset(node));
    const ends = nodes.map((node, index) => starts[index]! + nodeLength(node));
    return { start: Math.min(...starts), end: Math.max(...ends) };
  }
  return null;
}

/** Select `start..end` (composer-string offsets), clamped to the text. */
export function $setSelectionOffsets(start: number, end: number = start): void {
  const total = $readComposerValue().text.length;
  const anchor = $offsetToPoint(Math.min(start, total));
  const focus = start === end ? anchor : $offsetToPoint(Math.min(end, total));
  const selection = $createRangeSelection();
  selection.anchor.set(anchor.key, anchor.offset, anchor.type);
  selection.focus.set(focus.key, focus.offset, focus.type);
  $setSelection(selection);
}

/** Current string offsets of every mention node, by node key. */
export function $readMentionOffsets(): Record<string, SelectionOffsets> {
  const offsets: Record<string, SelectionOffsets> = {};
  let text = 0;
  $paragraphs().forEach((paragraph, index) => {
    if (index > 0) text += 1;
    for (const child of paragraph.getChildren()) {
      const length = nodeLength(child);
      if ($isMentionNode(child)) offsets[child.getKey()] = { start: text, end: text + length };
      text += length;
    }
  });
  return offsets;
}
