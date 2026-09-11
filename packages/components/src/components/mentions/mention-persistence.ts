import { dropOverlappingRanges, isTextOffset } from '@lody/shared';
import type { MentionKind } from '@/ui/mention/index';

/**
 * Mention ranges stored with a draft.
 *
 * Ranges used to be rebuilt from the draft's text on every remount, by asking
 * each source whether it recognised a token. That works only once the source
 * has loaded — the file index, the slug cache, the issue list — so a mention
 * spent the first moments of every return looking like plain text, and a source
 * that never loaded meant it never came back at all. Storing the ranges removes
 * the question: the draft already knows what its mentions were.
 *
 * Deliberately a narrow shape rather than the live `Mention`. A range carries
 * `onMentionSelect`, a function, and functions do not survive `JSON.stringify`
 * — persisting the live object would write `{}` for it and read back something
 * that looks like a range and behaves like a stranger. Only the four fields
 * that mean anything after a reload are kept.
 */
export type PersistedMentionRange = {
  start: number;
  end: number;
  value: string;
  kind: MentionKind;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * Keep only the ranges that still describe a real region of `text`.
 *
 * Persisted state is untrusted input: it may have been written by an older
 * version, hand-edited in devtools, or — the realistic one — saved against text
 * that has since been edited somewhere this component did not see. A range
 * whose offsets no longer fit would decorate the wrong characters, which is
 * worse than not decorating them, so it is dropped rather than clamped.
 *
 * Ordering and overlap resolution are the shared `dropOverlappingRanges` rule —
 * the same one `sanitizeMessageTextSpans` applies to sent-message spans — so
 * only the field validation is specific to a persisted composer range.
 */
export const sanitizeMentionRanges = (text: string, ranges: unknown): PersistedMentionRange[] => {
  if (!Array.isArray(ranges) || ranges.length === 0) return [];

  const candidates: PersistedMentionRange[] = [];
  for (const range of ranges) {
    if (!isRecord(range)) continue;
    const { start, end, value, kind } = range;
    if (!isTextOffset(start) || !isTextOffset(end)) continue;
    if (end <= start || end > text.length) continue;
    if (typeof value !== 'string' || value.length === 0) continue;
    if (typeof kind !== 'string' || kind.length === 0) continue;
    candidates.push({ start, end, value, kind });
  }

  return dropOverlappingRanges(candidates);
};

/**
 * Strip a live range down to what is worth storing.
 *
 * `pasted_text` is excluded: those ranges are derived from the pasted-text
 * drafts, which are persisted separately and are the source of truth for them.
 * Storing both would let the two disagree after an edit.
 */
export const toPersistedMentionRanges = (
  ranges: readonly { start: number; end: number; value: string; kind?: MentionKind }[]
): PersistedMentionRange[] =>
  ranges
    .filter((range) => range.kind && range.kind !== 'pasted_text' && range.value)
    .map(({ start, end, value, kind }) => ({ start, end, value, kind: kind as MentionKind }));

/**
 * Whether two persisted sets are the same.
 *
 * The composer reports ranges on every keystroke that shifts one, and the draft
 * lives in `localStorage` — writing an identical array back on each of those
 * would serialize and store the whole draft for no change.
 */
export const arePersistedMentionRangesEqual = (
  left: readonly PersistedMentionRange[],
  right: readonly PersistedMentionRange[]
): boolean =>
  left.length === right.length &&
  left.every((range, index) => {
    const other = right[index];
    return (
      other !== undefined &&
      range.start === other.start &&
      range.end === other.end &&
      range.value === other.value &&
      range.kind === other.kind
    );
  });
