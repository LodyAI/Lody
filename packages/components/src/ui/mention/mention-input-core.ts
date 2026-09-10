import type { Mention, MentionKind } from './mention-root';

/**
 * One text edit that writes a mention, expressed as data.
 *
 * Both ways a range is born share this shape: committing a menu item replaces
 * the span from the trigger to the caret, and an external insert replaces
 * nothing at a chosen index. Keeping the arithmetic in one pure function is
 * what keeps them from drifting — the shift rule and the caret position are the
 * easy things to get subtly different in a second copy.
 *
 * `prefix` and `suffix` are written into the text but stay OUTSIDE the range:
 * separating whitespace belongs to the sentence, not to the mention.
 */
export type MentionSplice = {
  /** Start of the replaced span. */
  replaceStart: number;
  /** End of the replaced span; equal to `replaceStart` for a pure insert. */
  replaceEnd: number;
  /** Text written before the range and not covered by it. @default '' */
  prefix?: string;
  /** The mention text itself — exactly what the committed range covers. */
  text: string;
  /** Text written after the range and not covered by it. @default '' */
  suffix?: string;
  /** Payload recorded on the range. Ignored when `commitRange` is false. */
  value: string;
  kind?: MentionKind;
  data?: unknown;
  /**
   * Whether the edit records a range at all. A navigation step rewrites the
   * trigger span without committing a mention.
   */
  commitRange: boolean;
};

/**
 * The separator an inserted mention needs in front of it, if any.
 *
 * Read from the text the insert actually lands in rather than from a caller's
 * copy of it: the caller holds the controlled value, which can trail the input
 * by a keystroke, and a missing separator would glue the mention to the
 * previous word — where the `@` token scanner no longer finds it.
 */
export function resolveMentionInsertPrefix(
  value: string,
  at: number,
  separate: boolean | undefined
): string {
  if (!separate || at <= 0) return '';
  return /\s$/u.test(value.slice(0, at)) ? '' : ' ';
}

export type MentionSpliceResult = {
  value: string;
  mentions: Mention[];
  /** Where the caret belongs once the input renders `value`. */
  caret: number;
};

/**
 * Apply a splice to the text and to every existing range.
 *
 * Existing ranges move through `applyTextEditToMentions`, the same rule a typed
 * edit uses — including its "a range the edit cut into is gone" clause. Neither
 * caller can produce that today (a menu commit replaces only the trigger span
 * the user is typing in, an external insert replaces nothing), but a splice
 * landing inside a range has exactly one correct outcome, and it is the one
 * that rule already implements.
 */
export function applyMentionSplice(
  value: string,
  mentions: Mention[],
  splice: MentionSplice
): MentionSpliceResult {
  const prefix = splice.prefix ?? '';
  const suffix = splice.suffix ?? '';
  const replaceStart = Math.max(0, Math.min(value.length, splice.replaceStart));
  const replaceEnd = Math.max(replaceStart, Math.min(value.length, splice.replaceEnd));

  const inserted = `${prefix}${splice.text}${suffix}`;
  const nextValue = `${value.slice(0, replaceStart)}${inserted}${value.slice(replaceEnd)}`;
  const delta = inserted.length - (replaceEnd - replaceStart);

  const shifted = applyTextEditToMentions(mentions, replaceStart, replaceEnd, delta);
  const rangeStart = replaceStart + prefix.length;

  return {
    value: nextValue,
    mentions: splice.commitRange
      ? [
          ...shifted,
          {
            value: splice.value,
            start: rangeStart,
            end: rangeStart + splice.text.length,
            kind: splice.kind ?? 'mention',
            ...(splice.data === undefined ? {} : { data: splice.data }),
          },
        ].sort((a, b) => a.start - b.start)
      : shifted,
    caret: replaceStart + inserted.length,
  };
}

export type TextDiff = {
  start: number;
  prevEnd: number;
  nextEnd: number;
  removedLen: number;
  insertedLen: number;
  delta: number;
};

export function getTextDiff(prevValue: string, nextValue: string): TextDiff | null {
  if (prevValue === nextValue) return null;

  const prevLen = prevValue.length;
  const nextLen = nextValue.length;

  let start = 0;
  while (start < prevLen && start < nextLen && prevValue[start] === nextValue[start]) {
    start += 1;
  }

  let prevEnd = prevLen;
  let nextEnd = nextLen;
  while (prevEnd > start && nextEnd > start && prevValue[prevEnd - 1] === nextValue[nextEnd - 1]) {
    prevEnd -= 1;
    nextEnd -= 1;
  }

  return {
    start,
    prevEnd,
    nextEnd,
    removedLen: prevEnd - start,
    insertedLen: nextEnd - start,
    delta: nextEnd - prevEnd,
  };
}

export function getMentionValuesFromMentions(mentions: Mention[]) {
  const seen = new Set<string>();
  const values: string[] = [];

  for (const mention of mentions) {
    if (mention.kind === 'pasted_text') continue;
    if (seen.has(mention.value)) continue;
    seen.add(mention.value);
    values.push(mention.value);
  }

  return values;
}

export function areMentionsEqual(current: Mention[], next: Mention[]) {
  if (current === next) return true;
  if (current.length !== next.length) return false;

  for (let index = 0; index < current.length; index += 1) {
    const currentMention = current[index];
    const nextMention = next[index];

    if (
      !currentMention ||
      !nextMention ||
      currentMention.start !== nextMention.start ||
      currentMention.end !== nextMention.end ||
      currentMention.value !== nextMention.value ||
      currentMention.kind !== nextMention.kind ||
      currentMention.data !== nextMention.data
    ) {
      return false;
    }
  }

  return true;
}

export function areStringArraysEqual(current: string[] | undefined, next: string[]) {
  if (!current) return next.length === 0;
  if (current === next) return true;
  if (current.length !== next.length) return false;

  for (let index = 0; index < current.length; index += 1) {
    if (current[index] !== next[index]) {
      return false;
    }
  }

  return true;
}

export function applyTextEditToMentions(
  mentions: Mention[],
  start: number,
  prevEnd: number,
  delta: number
) {
  if (mentions.length === 0) {
    return mentions;
  }

  const next: Mention[] = [];
  let hasChanges = false;

  for (const mention of mentions) {
    const intersects = mention.start < prevEnd && mention.end > start;
    if (intersects) {
      hasChanges = true;
      continue;
    }

    if (mention.start >= prevEnd) {
      if (delta !== 0) {
        hasChanges = true;
        next.push({
          ...mention,
          start: mention.start + delta,
          end: mention.end + delta,
        });
      } else {
        next.push(mention);
      }
      continue;
    }

    next.push(mention);
  }

  if (!hasChanges) {
    return mentions;
  }

  next.sort((a, b) => a.start - b.start);
  return next;
}

type HorizontalNavigationOptions = {
  mentions: Mention[];
  value: string;
  cursorPosition: number;
  direction: 'left' | 'right';
  isWordJump: boolean;
};

export function findAdjacentMentionForHorizontalNavigation({
  mentions,
  value,
  cursorPosition,
  direction,
  isWordJump,
}: HorizontalNavigationOptions): Mention | null {
  const isLeftArrow = direction === 'left';

  return (
    mentions.find((mention) => {
      if (isLeftArrow) {
        const textBetween = value.slice(mention.end, cursorPosition);
        const isOnlySpaces = /^\s*$/.test(textBetween);

        if (isWordJump) {
          return (
            cursorPosition > mention.start &&
            (cursorPosition === mention.end || (cursorPosition > mention.end && isOnlySpaces))
          );
        }

        return (
          cursorPosition === mention.end ||
          (cursorPosition > mention.end && cursorPosition <= mention.end + 1 && isOnlySpaces)
        );
      }

      const textBetween = value.slice(cursorPosition, mention.start);
      const isOnlySpaces = /^\s*$/.test(textBetween);

      if (isWordJump) {
        return (
          (cursorPosition >= mention.start && cursorPosition < mention.end) ||
          (cursorPosition < mention.start && isOnlySpaces)
        );
      }

      return (
        cursorPosition === mention.start ||
        (cursorPosition < mention.start && cursorPosition >= mention.start - 1 && isOnlySpaces)
      );
    }) ?? null
  );
}

type BackspaceMentionOptions = {
  mentions: Mention[];
  value: string;
  cursorPosition: number;
  isCtrlOrCmd: boolean;
};

export function findMentionBeforeCursorForDeletion({
  mentions,
  value,
  cursorPosition,
  isCtrlOrCmd,
}: BackspaceMentionOptions): Mention | null {
  return (
    mentions.find((mention) => {
      if (!isCtrlOrCmd) {
        return (
          cursorPosition === mention.end ||
          (cursorPosition === mention.end + 1 && value[mention.end] === ' ') ||
          (cursorPosition > mention.start && cursorPosition <= mention.end)
        );
      }

      const textBetween = value.slice(mention.end, cursorPosition);
      return mention.end <= cursorPosition && /^\s*$/.test(textBetween);
    }) ?? null
  );
}

export function removeMentionText(value: string, mention: Mention, includeTrailingSpace: boolean) {
  return value.slice(0, mention.start) + value.slice(mention.end + (includeTrailingSpace ? 1 : 0));
}
