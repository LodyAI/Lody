import type { TextRewrite } from '@lody/shared';

export interface PastedTextDraft {
  id: string;
  text: string;
  displayText: string;
  start: number;
  end: number;
}

export const LARGE_PASTED_TEXT_MIN_CHAR_COUNT = 1024;

export const createPastedTextDraftId = (): string => {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
};

export const normalizePastedTextDraft = (text: string): string => text.replace(/\r\n?/g, '\n');

export const getPastedTextCharacterCount = (text: string): number =>
  normalizePastedTextDraft(text).trim().length;

export const getPastedTextLineCount = (text: string): number => {
  const normalized = normalizePastedTextDraft(text).trim();
  if (!normalized) {
    return 0;
  }
  return normalized.split('\n').length;
};

export const isLargePastedText = (text: string): boolean => {
  const characterCount = getPastedTextCharacterCount(text);
  return characterCount > LARGE_PASTED_TEXT_MIN_CHAR_COUNT;
};

export const shouldCapturePastedTextDraft = (text: string): boolean => isLargePastedText(text);

const isPastedTextDraft = (value: unknown): value is PastedTextDraft => {
  if (!value || typeof value !== 'object') {
    return false;
  }

  const candidate = value as Partial<PastedTextDraft>;
  return (
    typeof candidate.id === 'string' &&
    typeof candidate.text === 'string' &&
    typeof candidate.displayText === 'string' &&
    typeof candidate.start === 'number' &&
    typeof candidate.end === 'number'
  );
};

export const sanitizePastedTextDrafts = (drafts: unknown): PastedTextDraft[] => {
  if (!Array.isArray(drafts)) {
    return [];
  }

  return drafts
    .filter(isPastedTextDraft)
    .map((draft) => ({
      id: draft.id,
      text: normalizePastedTextDraft(draft.text),
      displayText: draft.displayText,
      start: draft.start,
      end: draft.end,
    }))
    .filter((draft) => draft.displayText.length > 0 && draft.end >= draft.start)
    .sort((a, b) => a.start - b.start);
};

export const insertPastedTextDraft = ({
  currentValue,
  pastedText,
  displayText,
  id = createPastedTextDraftId(),
  selectionStart,
  selectionEnd,
}: {
  currentValue: string;
  pastedText: string;
  displayText: string;
  id?: string;
  selectionStart: number | null;
  selectionEnd: number | null;
}): { nextValue: string; draft: PastedTextDraft } | null => {
  const normalizedText = normalizePastedTextDraft(pastedText).trim();
  if (!normalizedText) {
    return null;
  }

  const safeStart = Math.max(
    0,
    Math.min(selectionStart ?? currentValue.length, currentValue.length)
  );
  const safeEnd = Math.max(safeStart, Math.min(selectionEnd ?? safeStart, currentValue.length));
  const nextValue = `${currentValue.slice(0, safeStart)}${displayText}${currentValue.slice(safeEnd)}`;

  return {
    nextValue,
    draft: {
      id,
      text: normalizedText,
      displayText,
      start: safeStart,
      end: safeStart + displayText.length,
    },
  };
};

export const getPastedTextDraftsAfterInsertion = ({
  drafts,
  draft,
  editStart,
  editEnd,
}: {
  drafts: readonly PastedTextDraft[];
  draft: PastedTextDraft;
  editStart: number;
  editEnd: number;
}): PastedTextDraft[] => {
  const safeStart = Math.max(0, editStart);
  const safeEnd = Math.max(safeStart, editEnd);
  const delta = draft.end - draft.start - (safeEnd - safeStart);
  const editIsCollapsed = safeStart === safeEnd;

  const nextDrafts = sanitizePastedTextDrafts(drafts).flatMap((currentDraft) => {
    const touchesEditRange = editIsCollapsed
      ? currentDraft.start < safeStart && currentDraft.end > safeStart
      : currentDraft.start < safeEnd && currentDraft.end > safeStart;

    if (touchesEditRange) {
      return [];
    }

    if (currentDraft.start >= safeEnd) {
      return [
        {
          ...currentDraft,
          start: currentDraft.start + delta,
          end: currentDraft.end + delta,
        },
      ];
    }

    return [currentDraft];
  });

  return [...nextDrafts, draft].sort((a, b) => a.start - b.start);
};

export const updatePastedTextDraftContent = ({
  currentValue,
  drafts,
  draftId,
  text,
  displayText,
}: {
  currentValue: string;
  drafts: readonly PastedTextDraft[];
  draftId: string;
  text: string;
  displayText: string;
}): { nextValue: string; nextDrafts: PastedTextDraft[] } | null => {
  if (!displayText) {
    return null;
  }

  const sortedDrafts = sanitizePastedTextDrafts(drafts);
  const targetDraft = sortedDrafts.find((draft) => draft.id === draftId);

  if (
    !targetDraft ||
    targetDraft.start < 0 ||
    targetDraft.end < targetDraft.start ||
    targetDraft.end > currentValue.length
  ) {
    return null;
  }

  const normalizedText = normalizePastedTextDraft(text);
  const nextValue = `${currentValue.slice(0, targetDraft.start)}${displayText}${currentValue.slice(
    targetDraft.end
  )}`;
  const delta = displayText.length - (targetDraft.end - targetDraft.start);

  const nextDrafts = sortedDrafts
    .map((draft) => {
      if (draft.id === draftId) {
        return {
          ...draft,
          text: normalizedText,
          displayText,
          end: draft.start + displayText.length,
        };
      }

      if (draft.start >= targetDraft.end) {
        return {
          ...draft,
          start: draft.start + delta,
          end: draft.end + delta,
        };
      }

      return draft;
    })
    .sort((a, b) => a.start - b.start);

  return { nextValue, nextDrafts };
};

/**
 * The placeholder -> full-blob rewrites these drafts imply.
 *
 * Takes no text: a draft already carries its own absolute range, and
 * `applyTextRewrites` is what validates those ranges against the string.
 *
 * The span is what makes the blob survivable in a transcript: the agent still
 * receives all four thousand characters, and the bubble collapses them back to
 * the same `Pasted N chars` label the composer showed.
 */
export const buildPastedTextRewrites = (drafts: readonly PastedTextDraft[]): TextRewrite[] =>
  [...drafts]
    .sort((a, b) => a.start - b.start)
    .map((draft) => ({
      start: draft.start,
      end: draft.end,
      replacement: normalizePastedTextDraft(draft.text),
      span: {
        kind: 'pasted_text' as const,
        // Trimmed: the composer pads the label with figure spaces so its inline
        // chip has an icon gutter, and a message chip has real padding instead.
        label: draft.displayText.trim(),
        target: draft.id,
      },
    }));

export const getPastedTextClipboardTextForSelection = ({
  value,
  drafts,
  selectionStart,
  selectionEnd,
}: {
  value: string;
  drafts: readonly PastedTextDraft[];
  selectionStart: number | null;
  selectionEnd: number | null;
}): string | null => {
  const safeStart = Math.max(0, Math.min(selectionStart ?? 0, value.length));
  const safeEnd = Math.max(safeStart, Math.min(selectionEnd ?? safeStart, value.length));

  if (safeStart === safeEnd) {
    return null;
  }

  const sortedDrafts = sanitizePastedTextDrafts(drafts);
  let cursor = safeStart;
  let clipboardText = '';
  let expandedDraftCount = 0;

  for (const draft of sortedDrafts) {
    if (draft.start >= safeEnd) {
      break;
    }

    if (
      draft.start < 0 ||
      draft.end <= draft.start ||
      draft.end > value.length ||
      draft.end <= safeStart ||
      draft.end <= cursor
    ) {
      continue;
    }

    if (draft.start < cursor && cursor !== safeStart) {
      continue;
    }

    if (draft.start > cursor) {
      clipboardText += value.slice(cursor, Math.min(draft.start, safeEnd));
    }

    clipboardText += normalizePastedTextDraft(draft.text);
    expandedDraftCount += 1;
    cursor = Math.max(cursor, Math.min(draft.end, safeEnd));
  }

  if (expandedDraftCount === 0) {
    return null;
  }

  clipboardText += value.slice(cursor, safeEnd);
  return clipboardText;
};

export const arePastedTextDraftsEqual = (
  current: readonly PastedTextDraft[],
  next: readonly PastedTextDraft[]
): boolean => {
  if (current === next) return true;
  if (current.length !== next.length) return false;

  for (let index = 0; index < current.length; index += 1) {
    const currentDraft = current[index];
    const nextDraft = next[index];

    if (
      !currentDraft ||
      !nextDraft ||
      currentDraft.id !== nextDraft.id ||
      currentDraft.text !== nextDraft.text ||
      currentDraft.displayText !== nextDraft.displayText ||
      currentDraft.start !== nextDraft.start ||
      currentDraft.end !== nextDraft.end
    ) {
      return false;
    }
  }

  return true;
};
