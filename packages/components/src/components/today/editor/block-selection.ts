import {
  TODAY_MENTION_CHAR,
  isTodayTodoState,
  parseTodayPasteText,
  type TodayFragment,
  type TodayMention,
  type TodayMentionTarget,
  type TodayNodeId,
  type TodayNodeView,
  type TodayRichText,
} from '@lody/shared';
import { buildSessionLink } from '@lody/shared/session-link';
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
  | { type: 'select-all' }
  | { type: 'cycle-todo' }
  | { type: 'zoom-in' }
  | { type: 'zoom-out' }
  | { type: 'undo' }
  | { type: 'redo' };

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
      if (mod && !event.shiftKey && !event.altKey) return { type: 'cycle-todo' };
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
    case 'ArrowLeft':
    case 'ArrowRight':
      if (!event.altKey || event.shiftKey || event.metaKey || event.ctrlKey) return null;
      return { type: event.key === 'ArrowRight' ? 'zoom-in' : 'zoom-out' };
    case 'a':
    case 'A':
      return mod ? { type: 'select-all' } : null;
    case 'z':
    case 'Z':
      if (!mod || event.altKey) return null;
      return { type: event.shiftKey ? 'redo' : 'undo' };
    case 'y':
    case 'Y':
      return platform === 'other' && mod && !event.shiftKey && !event.altKey
        ? { type: 'redo' }
        : null;
    default:
      return null;
  }
}

export const TODAY_CLIPBOARD_MIME = 'application/x-lody-today+json';
/** Clipboard payload version. */
export const TODAY_CLIPBOARD_VERSION = 2;

/** Plain-text form of one mention, e.g. `[@Title](lody://session/<id>?workspace=<id>)`. */
export type TodayMentionText = (mention: TodayMentionTarget) => string;

/**
 * `[@Title](lody://session/<id>?workspace=<id>)`, the MCP session reference
 * form; the title falls back to the id. Other kinds have no link form.
 */
export function todayMentionMarkdown(
  mention: TodayMentionTarget,
  context: { workspaceId: string | null; title?: string | null }
): string {
  const title = (context.title?.trim() || mention.id).replace(/[[\]\\]/g, '\\$&');
  if (mention.kind !== 'session' || !context.workspaceId) return `@${title}`;
  try {
    const link = buildSessionLink({ sessionId: mention.id, workspaceId: context.workspaceId });
    return `[@${title}](${link})`;
  } catch {
    return `@${title}`;
  }
}

/** Node text with every mention written out; placeholders (no kind) drop. */
export function todayRichToPlain(
  rich: { text: string; mentions?: readonly TodayMention[] },
  mentionText: TodayMentionText
): string {
  const byStart = new Map((rich.mentions ?? []).map((mention) => [mention.start, mention]));
  let out = '';
  for (let index = 0; index < rich.text.length; index += 1) {
    const char = rich.text[index]!;
    if (char !== TODAY_MENTION_CHAR) {
      out += char;
      continue;
    }
    const mention = byStart.get(index);
    if (mention?.kind) out += mentionText(mention);
  }
  return out;
}

/** Plain-text form: `- ` bullets, two spaces per level, mentions as links. */
export function serializeTodayFragments(
  fragments: readonly TodayFragment[],
  mentionText: TodayMentionText,
  depth = 0
): string {
  return fragments
    .map((fragment) => {
      const label = todayRichToPlain(fragment, mentionText);
      const indent = '  '.repeat(depth);
      const marker = fragment.todo ? (fragment.todo === 'done' ? '[x] ' : '[ ] ') : '';
      const line = `${indent}- ${marker}${label.replace(/\n/g, `\n${indent}  `)}`;
      const children = serializeTodayFragments(fragment.children, mentionText, depth + 1);
      return children ? `${line}\n${children}` : line;
    })
    .join('\n');
}

function isMention(value: unknown): value is TodayMention {
  if (!value || typeof value !== 'object') return false;
  const mention = value as Record<string, unknown>;
  return (
    typeof mention.start === 'number' &&
    typeof mention.kind === 'string' &&
    typeof mention.id === 'string'
  );
}

function readFragment(value: unknown): TodayFragment | null {
  if (!value || typeof value !== 'object') return null;
  const fragment = value as Record<string, unknown>;
  if (typeof fragment.text !== 'string' || !Array.isArray(fragment.children)) return null;
  const children: TodayFragment[] = [];
  for (const child of fragment.children) {
    const read = readFragment(child);
    if (!read) return null;
    children.push(read);
  }
  const collapsed = fragment.collapsed === true ? { collapsed: true } : {};
  const mentions = fragment.mentions;
  if (mentions !== undefined && (!Array.isArray(mentions) || !mentions.every(isMention))) {
    return null;
  }
  return {
    text: fragment.text,
    ...(mentions && mentions.length > 0 ? { mentions: mentions as TodayMention[] } : {}),
    ...collapsed,
    ...(isTodayTodoState(fragment.todo) ? { todo: fragment.todo } : {}),
    children,
  };
}

/** A Markdown link (`[label](url)`) or a bare `<scheme>://session/…` link. */
const SESSION_LINK_PATTERN =
  /\[(?:[^\]\\\n]|\\.)*\]\(([^)\s]+)\)|([a-zA-Z][a-zA-Z.+-]*:\/\/session\/[^\s)\]]+)/g;

/**
 * Pasted text with every conversation link `resolve` accepts (a same-workspace
 * `lody://session` link, bare or Markdown) turned into a mention in place.
 * Other links stay text; a stray U+FFFC (no mark can come with plain text) drops.
 */
export function linkifyTodayText(
  input: string,
  resolve: (link: string) => string | null
): { text: string; mentions: TodayMention[] } {
  const source = input.replaceAll(TODAY_MENTION_CHAR, '');
  let text = '';
  const mentions: TodayMention[] = [];
  let cursor = 0;
  for (const match of source.matchAll(SESSION_LINK_PATTERN)) {
    let raw = match[0];
    let link = match[1] ?? match[2] ?? '';
    if (match[2]) {
      // A bare link's trailing punctuation belongs to the sentence.
      const trimmed = link.replace(/[.,;:!?'"]+$/u, '');
      raw = raw.slice(0, raw.length - (link.length - trimmed.length));
      link = trimmed;
    }
    const id = resolve(link);
    if (!id) continue;
    text += source.slice(cursor, match.index);
    mentions.push({ start: text.length, kind: 'session', id });
    text += TODAY_MENTION_CHAR;
    cursor = match.index + raw.length;
  }
  text += source.slice(cursor);
  return { text, mentions };
}

/** Fragments with their conversation links turned into mentions (see `linkifyTodayText`). */
export function linkifyTodayFragments(
  fragments: readonly TodayFragment[],
  resolve: (link: string) => string | null
): TodayFragment[] {
  return fragments.map((fragment) => ({
    ...fragment,
    ...(fragment.mentions?.length ? {} : linkifyTodayText(fragment.text, resolve)),
    children: linkifyTodayFragments(fragment.children, resolve),
  }));
}

/** Our structured payload when present and valid, else outline-parsed text. */
export function parseTodayClipboard(data: {
  json?: string;
  text?: string;
}): TodayFragment[] | null {
  if (data.json) {
    try {
      const parsed = JSON.parse(data.json) as { v?: unknown; fragments?: unknown };
      if (parsed.v === TODAY_CLIPBOARD_VERSION && Array.isArray(parsed.fragments)) {
        const fragments = parsed.fragments.map(readFragment);
        if (fragments.every((fragment): fragment is TodayFragment => fragment !== null)) {
          return fragments;
        }
      }
    } catch {
      // Fall through to the plain text.
    }
  }
  if (!data.text) return null;
  const fragments = parseTodayPasteText(data.text);
  return fragments.length > 0 ? fragments : null;
}

/**
 * "Convert to task" prompt: the node's text, then its subtree as an indented
 * list. With `ancestors` (outermost first) the whole path is one indented
 * list, the node nested under its parents with its subtree below it.
 */
export function buildConvertPrompt(
  fragment: TodayFragment,
  mentionText: TodayMentionText,
  ancestors: readonly TodayRichText[] = []
): string {
  if (ancestors.length > 0) {
    const chain = ancestors.reduceRight<TodayFragment>(
      (child, ancestor) => ({ ...ancestor, children: [child] }),
      fragment
    );
    return serializeTodayFragments([chain], mentionText);
  }
  // Mentions reach the agent as conversation links.
  const head = todayRichToPlain(fragment, mentionText);
  const children = serializeTodayFragments(fragment.children, mentionText);
  return children ? `${head}\n${children}` : head;
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
 * The next `Mod+A` step of a block selection: the parent of a single selected
 * node, the lowest common ancestor of several, and the day's top-level nodes
 * once there is no ancestor left. Null when the day is already selected.
 * Behavior: specs/today-outline.md (Outline editing).
 */
export function escalateSelection(
  visible: readonly TodayNodeView[],
  ids: readonly TodayNodeId[]
): TodayNodeId[] | null {
  const byId = new Map(visible.map((node) => [node.id, node] as const));
  const roots = topLevelSelection(visible, ids);
  const dayRoots = visible.filter((node) => node.depth === 0).map((node) => node.id);
  const chain = (id: TodayNodeId) => {
    const out: TodayNodeId[] = [];
    for (let parent = byId.get(id)?.parentId ?? null; parent;) {
      out.push(parent);
      parent = byId.get(parent)?.parentId ?? null;
    }
    return out;
  };
  let common: TodayNodeId[] | null = null;
  for (const root of roots) {
    const ancestors = chain(root);
    common = common === null ? ancestors : common.filter((id) => ancestors.includes(id));
  }
  const ancestor = common?.[0];
  if (ancestor) return [ancestor];
  const all = new Set(roots);
  if (dayRoots.length === 0 || dayRoots.every((id) => all.has(id))) return null;
  return dayRoots;
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
