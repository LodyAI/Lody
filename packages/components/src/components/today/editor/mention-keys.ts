import { isImeKey, type OutlineKeyEvent } from './outline-keys';

/**
 * Keys around a mention (one character in the node text). Behavior:
 * specs/today-outline.md (Conversation mentions, Caret):
 * - ← with the caret right after a mention selects it; ← on a selected
 *   mention collapses before it. → is symmetric.
 * - Backspace right after a mention (Delete right before it) selects it; on a
 *   selected mention the editor deletes it. Alt/⌘+Backspace is left to the
 *   editor and deletes at once.
 * - Enter on a selected mention opens it; Alt+Enter opens its status menu.
 * The selection is a plain text range covering the mention, so typing
 * replaces it. Returns null when the key is the editor's.
 */
export type MentionKeyIntent =
  | { type: 'select'; anchor: number; focus: number }
  | { type: 'collapse'; offset: number }
  | { type: 'open'; start: number }
  | { type: 'menu'; start: number };

/** The only keys `resolveMentionKey` acts on; callers skip document reads for the rest. */
export const MENTION_KEYS: ReadonlySet<string> = new Set([
  'ArrowLeft',
  'ArrowRight',
  'Backspace',
  'Delete',
  'Enter',
]);

export function resolveMentionKey(
  event: OutlineKeyEvent,
  caret: { anchor: number; focus: number },
  mentionStarts: readonly number[]
): MentionKeyIntent | null {
  if (isImeKey(event)) return null;
  const starts = new Set(mentionStarts);
  const start = Math.min(caret.anchor, caret.focus);
  const end = Math.max(caret.anchor, caret.focus);
  const collapsed = start === end;
  const selected = end - start === 1 && starts.has(start) ? start : null;
  const plain = !event.shiftKey && !event.altKey && !event.metaKey && !event.ctrlKey;
  switch (event.key) {
    case 'ArrowLeft':
    case 'Backspace':
      if (!plain) return null;
      if (collapsed && starts.has(start - 1)) {
        // Backward, so a following Shift+← keeps extending to the left.
        return { type: 'select', anchor: start, focus: start - 1 };
      }
      if (selected !== null && event.key === 'ArrowLeft')
        return { type: 'collapse', offset: start };
      return null;
    case 'ArrowRight':
    case 'Delete':
      if (!plain) return null;
      if (collapsed && starts.has(start))
        return { type: 'select', anchor: start, focus: start + 1 };
      if (selected !== null && event.key === 'ArrowRight') return { type: 'collapse', offset: end };
      return null;
    case 'Enter':
      if (selected === null || event.shiftKey) return null;
      if (event.altKey) return { type: 'menu', start: selected };
      return { type: 'open', start: selected };
    default:
      return null;
  }
}
