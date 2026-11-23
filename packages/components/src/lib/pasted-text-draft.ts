import {
  formatMessageQuote,
  readMessageQuote,
  sanitizeMessageTextSpans,
  type MessageTextSpan,
  type TextRewrite,
} from '@lody/shared';
import { getExpandedClipboardTextForSelection } from '@/lib/composer-clipboard';

export interface PastedTextDraft {
  id: string;
  text: string;
  displayText: string;
  start: number;
  end: number;
  /** Shares atomic range editing, but has a read-only snapshot and its own wire span. */
  kind?: 'message_quote';
}

export const LARGE_PASTED_TEXT_MIN_CHAR_COUNT = 1024;

/**
 * Character threshold for converting normalized, trimmed pasted text into a file.
 *
 * Above this the collapse stops helping: the chip hides the blob in the
 * composer, but the full text still rides along in every draft save, every
 * prompt rewrite, and the turn itself. A log dump this size is captured as a
 * regular text attachment so it can use the existing file path instead.
 */
export const PASTED_TEXT_FILE_MIN_CHAR_COUNT = 50_000;

export const PASTED_TEXT_FILE_NAME = 'pasted-text.txt';

/** Preserve the clipboard payload as a regular text attachment. */
export const createPastedTextFile = (text: string): File =>
  new File([text], PASTED_TEXT_FILE_NAME, { type: 'text/plain' });

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

export const isPastedTextTooLarge = (text: string): boolean =>
  getPastedTextCharacterCount(text) >= PASTED_TEXT_FILE_MIN_CHAR_COUNT;

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
      ...(draft.kind === 'message_quote' ? { kind: 'message_quote' as const } : {}),
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
  kind,
}: {
  currentValue: string;
  pastedText: string;
  displayText: string;
  id?: string;
  selectionStart: number | null;
  selectionEnd: number | null;
  kind?: 'message_quote';
}): { nextValue: string; draft: PastedTextDraft } | null => {
  const normalizedText =
    kind === 'message_quote'
      ? normalizePastedTextDraft(pastedText)
      : normalizePastedTextDraft(pastedText).trim();
  if (!normalizedText.trim()) {
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
      ...(kind ? { kind } : {}),
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
 * The optional current value rejects stale placeholders; applyTextRewrites
 * validates the resulting ranges against the string.
 *
 * The span is what makes the blob survivable in a transcript: the agent still
 * receives all four thousand characters, and the bubble collapses them back to
 * the same `Pasted N chars` label the composer showed.
 */
export const buildPastedTextRewrites = (
  drafts: readonly PastedTextDraft[],
  value?: string
): TextRewrite[] =>
  [...drafts]
    .filter(
      (draft) => value === undefined || value.slice(draft.start, draft.end) === draft.displayText
    )
    .sort((a, b) => a.start - b.start)
    .map((draft) => ({
      start: draft.start,
      end: draft.end,
      replacement: normalizePastedTextDraft(draft.text),
      span: {
        kind: draft.kind ?? 'pasted_text',
        // Trimmed: the composer pads the label with figure spaces so its inline
        // chip has an icon gutter, and a message chip has real padding instead.
        label: draft.displayText.trim(),
        target: draft.id,
        ...(draft.kind === 'message_quote' ? { quoteVersion: 1 as const } : {}),
      },
      ...(draft.kind === 'message_quote'
        ? {
            replacement: formatMessageQuote(draft.text),
          }
        : {}),
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
}): string | null =>
  getExpandedClipboardTextForSelection({
    value,
    selectionStart,
    selectionEnd,
    rewrites: buildPastedTextRewrites(sanitizePastedTextDrafts(drafts), value),
  });

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
      currentDraft.end !== nextDraft.end ||
      currentDraft.kind !== nextDraft.kind
    ) {
      return false;
    }
  }

  return true;
};

export function removePastedTextDraft(
  value: string,
  drafts: readonly PastedTextDraft[],
  id: string
): { nextValue: string; nextDrafts: PastedTextDraft[] } | null {
  const removed = drafts.find((draft) => draft.id === id);
  if (!removed || value.slice(removed.start, removed.end) !== removed.displayText) return null;
  const length = removed.end - removed.start;
  return {
    nextValue: value.slice(0, removed.start) + value.slice(removed.end),
    nextDrafts: drafts
      .filter((draft) => draft.id !== id)
      .map((draft) =>
        draft.start >= removed.end
          ? { ...draft, start: draft.start - length, end: draft.end - length }
          : draft
      ),
  };
}

/** Restore only explicitly marked quotes; ordinary user Markdown is never guessed. */
export function restoreMessageQuoteDrafts(
  text: string,
  spans: readonly MessageTextSpan[] | undefined,
  includePastedText = false
): { text: string; drafts: PastedTextDraft[] } {
  let result = '';
  let cursor = 0;
  const drafts: PastedTextDraft[] = [];
  const ids = new Set<string>();
  for (const span of sanitizeMessageTextSpans(text, spans) ?? []) {
    if (span.kind !== 'message_quote' && !(includePastedText && span.kind === 'pasted_text'))
      continue;
    const snapshot =
      span.kind === 'message_quote'
        ? readMessageQuote(text.slice(span.start, span.end), span.quoteVersion)
        : text.slice(span.start, span.end);
    if (snapshot === undefined) continue;
    result += text.slice(cursor, span.start);
    const start = result.length;
    const label = `\u2007${span.label}\u2007`;
    result += label;
    let id = span.target || createPastedTextDraftId();
    while (ids.has(id)) id += `:quote:${span.start}`;
    ids.add(id);
    drafts.push({
      id,
      text: snapshot,
      displayText: label,
      start,
      end: result.length,
      ...(span.kind === 'message_quote' ? { kind: 'message_quote' as const } : {}),
    });
    cursor = span.end;
  }
  return { text: result + text.slice(cursor), drafts };
}
