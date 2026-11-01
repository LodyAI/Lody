import {
  applyTextRewrites,
  dropOverlappingRanges,
  sanitizeMessageTextSpans,
  type TextRewrite,
} from '@lody/shared';
import {
  sanitizeMentionRanges,
  type PersistedMentionRange,
} from '@/components/mentions/mention-persistence';
import {
  buildPastedTextRewrites,
  restoreMessageQuoteDrafts,
  type PastedTextDraft,
} from './pasted-text-draft';

export const conversationQuoteDraftKey = (workspaceId: string, sessionId: string): string =>
  `lody:conversationQuoteDraft:v1:${workspaceId}:${sessionId}`;

/** Internal mention identities move around external atoms, never into their contents. */
function projectMentionRanges(
  text: string,
  ranges: unknown,
  rewrites: readonly TextRewrite[]
): PersistedMentionRange[] {
  const edits = dropOverlappingRanges(
    rewrites.filter(
      (edit) =>
        Number.isInteger(edit.start) &&
        Number.isInteger(edit.end) &&
        edit.start >= 0 &&
        edit.end > edit.start &&
        edit.end <= text.length
    )
  );
  const shift = (offset: number) =>
    edits.reduce(
      (total, edit) =>
        total +
        (edit.end <= offset
          ? (edit.replacement?.length ?? edit.end - edit.start) - (edit.end - edit.start)
          : 0),
      0
    );
  return sanitizeMentionRanges(text, ranges).flatMap((range) =>
    edits.some((edit) => edit.start < range.end && edit.end > range.start)
      ? []
      : [{ ...range, start: range.start + shift(range.start), end: range.end + shift(range.end) }]
  );
}

/** Store readable text, never just an opaque chip label or source pointer. */
export function saveConversationQuoteDraft(
  storage: Pick<Storage, 'setItem' | 'removeItem'>,
  key: string,
  text: string,
  drafts: readonly PastedTextDraft[],
  ranges: readonly PersistedMentionRange[] = []
): boolean {
  try {
    if (!text || !drafts.some((draft) => draft.kind === 'message_quote')) storage.removeItem(key);
    else {
      const rewrites = buildPastedTextRewrites(drafts, text);
      const mentions = projectMentionRanges(text, ranges, rewrites);
      storage.setItem(
        key,
        JSON.stringify({
          ...applyTextRewrites(text, rewrites),
          ...(mentions.length ? { mentions } : {}),
        })
      );
    }
    return true;
  } catch {
    return false;
  }
}

export function loadConversationQuoteDraft(
  storage: Pick<Storage, 'getItem'>,
  key: string
): { text: string; drafts: PastedTextDraft[]; mentions?: PersistedMentionRange[] } | undefined {
  try {
    const raw = storage.getItem(key);
    if (!raw) return undefined;
    const value: unknown = JSON.parse(raw);
    if (!value || typeof value !== 'object' || !('text' in value) || typeof value.text !== 'string')
      return undefined;
    const spans = 'spans' in value ? sanitizeMessageTextSpans(value.text, value.spans) : undefined;
    const restored = restoreMessageQuoteDrafts(value.text, spans, true);
    const rewrites = (spans ?? [])
      .filter((span) => span.kind === 'message_quote' || span.kind === 'pasted_text')
      .map((span) => ({
        start: span.start,
        end: span.end,
        replacement: `\u2007${span.label}\u2007`,
      }));
    const mentions = projectMentionRanges(
      value.text,
      'mentions' in value ? value.mentions : [],
      rewrites
    );
    return { ...restored, ...(mentions.length ? { mentions } : {}) };
  } catch {
    return undefined;
  }
}
