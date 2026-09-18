import type { TextRewrite } from '@lody/shared';

/**
 * Clipboard text for a composer selection: expand every rewrite that intersects
 * the selection the same way send does (full replacement, even on a partial
 * mention select). Returns `null` when nothing expands so the browser keeps its
 * native copy of the composer text.
 *
 * Mirrors `getPastedTextClipboardTextForSelection` for arbitrary expanding
 * rewrites (session, skill, agent role, pasted text).
 */
export function getExpandedClipboardTextForSelection({
  value,
  selectionStart,
  selectionEnd,
  rewrites,
}: {
  value: string;
  selectionStart: number | null;
  selectionEnd: number | null;
  rewrites: readonly TextRewrite[];
}): string | null {
  const safeStart = Math.max(0, Math.min(selectionStart ?? 0, value.length));
  const safeEnd = Math.max(safeStart, Math.min(selectionEnd ?? safeStart, value.length));

  if (safeStart === safeEnd) {
    return null;
  }

  const expanding = [...rewrites]
    .filter(
      (rewrite) =>
        typeof rewrite.replacement === 'string' &&
        rewrite.end > rewrite.start &&
        rewrite.start >= 0 &&
        rewrite.end <= value.length
    )
    .sort((a, b) => a.start - b.start || a.end - b.end);

  let cursor = safeStart;
  let clipboardText = '';
  let expandedCount = 0;

  for (const rewrite of expanding) {
    if (rewrite.start >= safeEnd) {
      break;
    }

    if (rewrite.end <= safeStart || rewrite.end <= cursor) {
      continue;
    }

    if (rewrite.start < cursor && cursor !== safeStart) {
      continue;
    }

    if (rewrite.start > cursor) {
      clipboardText += value.slice(cursor, Math.min(rewrite.start, safeEnd));
    }

    clipboardText += rewrite.replacement!;
    expandedCount += 1;
    cursor = Math.max(cursor, Math.min(rewrite.end, safeEnd));
  }

  if (expandedCount === 0) {
    return null;
  }

  clipboardText += value.slice(cursor, safeEnd);
  return clipboardText;
}
