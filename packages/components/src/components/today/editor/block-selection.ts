import {
  parseTodayPasteText,
  type TodayFragment,
  type TodayNodeId,
  type TodayNodeView,
} from '@lody/shared';
import { isImeKey, type OutlineKeyEvent } from './outline-keys';

/**
 * Whole-node selection: what a drag or Shift+arrow covers, which keys act on
 * the selected nodes, and the clipboard format. Behavior:
 * specs/today-outline.md (Outline editing).
 */

/** Visible rows from `anchor` to `focus` inclusive, in document order. */
export function blockRange(
  visible: readonly TodayNodeView[],
  anchor: TodayNodeId,
  focus: TodayNodeId
): TodayNodeId[] {
  const a = visible.findIndex((node) => node.id === anchor);
  const b = visible.findIndex((node) => node.id === focus);
  if (a < 0 || b < 0) return [];
  const [from, to] = a <= b ? [a, b] : [b, a];
  return visible.slice(from, to + 1).map((node) => node.id);
}

/**
 * Drop nodes whose ancestor is also selected: a selected parent carries its
 * subtree (folded children included), so operations apply to it once.
 */
export function topLevelSelection(
  visible: readonly TodayNodeView[],
  ids: readonly TodayNodeId[]
): TodayNodeId[] {
  const selected = new Set(ids);
  const byId = new Map(visible.map((node) => [node.id, node] as const));
  return visible
    .filter((node) => selected.has(node.id))
    .filter((node) => {
      for (let parent = node.parentId; parent; parent = byId.get(parent)?.parentId ?? null) {
        if (selected.has(parent)) return false;
      }
      return true;
    })
    .map((node) => node.id);
}

export type BlockIntent =
  | { type: 'clear' }
  | { type: 'edit' }
  | { type: 'delete' }
  | { type: 'step'; step: -1 | 1 }
  | { type: 'extend'; step: -1 | 1 }
  | { type: 'indent' }
  | { type: 'outdent' }
  | { type: 'move-up' }
  | { type: 'move-down' }
  | { type: 'select-all' };

/** Keys on a block selection. Plain characters are ignored, never replacing a subtree. */
export function resolveBlockKey(
  event: OutlineKeyEvent,
  platform: 'mac' | 'other'
): BlockIntent | null {
  if (isImeKey(event)) return null;
  const mod = platform === 'mac' ? event.metaKey : event.ctrlKey;
  switch (event.key) {
    case 'Escape':
      return { type: 'clear' };
    case 'Enter':
      return mod || event.shiftKey ? null : { type: 'edit' };
    case 'Backspace':
    case 'Delete':
      return mod ? null : { type: 'delete' };
    case 'Tab':
      return event.shiftKey ? { type: 'outdent' } : { type: 'indent' };
    case 'ArrowUp':
    case 'ArrowDown': {
      const step = event.key === 'ArrowUp' ? -1 : 1;
      if ((mod || event.altKey) && event.shiftKey)
        return { type: step < 0 ? 'move-up' : 'move-down' };
      if (event.shiftKey) return { type: 'extend', step };
      if (mod || event.altKey) return null;
      return { type: 'step', step };
    }
    case 'a':
    case 'A':
      return mod ? { type: 'select-all' } : null;
    default:
      return null;
  }
}

export const TODAY_CLIPBOARD_MIME = 'application/x-lody-today+json';

/** Plain-text form: `- ` bullets, two spaces per level, sessions as links. */
export function serializeTodayFragments(
  fragments: readonly TodayFragment[],
  sessionLink: (sessionId: string) => string,
  depth = 0
): string {
  return fragments
    .map((fragment) => {
      const label = fragment.sessionId ? sessionLink(fragment.sessionId) : fragment.text;
      const indent = '  '.repeat(depth);
      const line = `${indent}- ${label.replace(/\n/g, `\n${indent}  `)}`;
      const children = serializeTodayFragments(fragment.children, sessionLink, depth + 1);
      return children ? `${line}\n${children}` : line;
    })
    .join('\n');
}

function isFragment(value: unknown): value is TodayFragment {
  if (!value || typeof value !== 'object') return false;
  const fragment = value as Record<string, unknown>;
  return (
    typeof fragment.text === 'string' &&
    (fragment.sessionId === undefined || typeof fragment.sessionId === 'string') &&
    Array.isArray(fragment.children) &&
    fragment.children.every(isFragment)
  );
}

/** Our structured payload when present and valid, else outline-parsed text. */
export function parseTodayClipboard(data: {
  json?: string;
  text?: string;
}): TodayFragment[] | null {
  if (data.json) {
    try {
      const parsed = JSON.parse(data.json) as { v?: unknown; fragments?: unknown };
      if (parsed.v === 1 && Array.isArray(parsed.fragments) && parsed.fragments.every(isFragment)) {
        return parsed.fragments;
      }
    } catch {
      // Fall through to the plain text.
    }
  }
  if (!data.text) return null;
  const fragments = parseTodayPasteText(data.text);
  return fragments.length > 0 ? fragments : null;
}

/** "Convert to task" prompt: the node's text, then its subtree as an indented list. */
export function buildConvertPrompt(fragment: TodayFragment): string {
  const children = serializeTodayFragments(fragment.children, (sessionId) => sessionId);
  return children ? `${fragment.text}\n${children}` : fragment.text;
}

/**
 * Every visible row a block selection acts on: the selected rows plus all
 * descendants of each selected row (deleting, moving or copying a parent takes
 * its subtree, so the highlight must show it too).
 */
export function selectionCovers(
  visible: readonly TodayNodeView[],
  ids: readonly TodayNodeId[]
): Set<TodayNodeId> {
  const selected = new Set(ids);
  const covered = new Set<TodayNodeId>();
  let subtreeDepth: number | null = null;
  for (const node of visible) {
    if (subtreeDepth !== null && node.depth > subtreeDepth) {
      covered.add(node.id);
      continue;
    }
    subtreeDepth = null;
    if (selected.has(node.id)) {
      covered.add(node.id);
      subtreeDepth = node.depth;
    }
  }
  return covered;
}

/**
 * The next focus row when Shift+Up/Down extends a block selection. Moving away
 * from the anchor downwards skips rows a selected ancestor already covers;
 * shrinking towards the anchor and flipping past it step one row. Null at the
 * day's edge: a block selection never crosses days.
 */
export function extendFocus(
  visible: readonly TodayNodeView[],
  anchor: TodayNodeId,
  focus: TodayNodeId,
  step: -1 | 1
): TodayNodeId | null {
  const anchorIndex = visible.findIndex((node) => node.id === anchor);
  const focusIndex = visible.findIndex((node) => node.id === focus);
  if (anchorIndex < 0 || focusIndex < 0) return null;
  let next = focusIndex + step;
  if (step > 0 && focusIndex >= anchorIndex) {
    const covered = selectionCovers(visible, blockRange(visible, anchor, focus));
    while (next < visible.length && covered.has(visible[next]!.id)) next += 1;
  }
  return visible[next]?.id ?? null;
}
