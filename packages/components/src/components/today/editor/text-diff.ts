import { sliceTodayRich, TODAY_MENTION_CHAR, type TodayRichText } from '@lody/shared';

/** One contiguous replacement in UTF-16 offsets, as LoroText and Lexical both count. */
export type TextSplice = { start: number; deleteCount: number; insert: string };

/** A Loro text event delta step. */
export type TextDeltaStep = { retain?: number; insert?: string | unknown; delete?: number };

const isHighSurrogate = (code: number) => code >= 0xd800 && code <= 0xdbff;
const isLowSurrogate = (code: number) => code >= 0xdc00 && code <= 0xdfff;

/**
 * The smallest prefix/suffix splice turning `previous` into `next`, widened so
 * it never cuts a surrogate pair: editing 😀→😁 differs only in the low half,
 * and writing that half alone would store a lone surrogate.
 */
export function safeTextDiff(previous: string, next: string): TextSplice | null {
  if (previous === next) return null;
  let start = 0;
  const shortest = Math.min(previous.length, next.length);
  while (start < shortest && previous[start] === next[start]) start += 1;
  let previousEnd = previous.length;
  let nextEnd = next.length;
  while (
    previousEnd > start &&
    nextEnd > start &&
    previous[previousEnd - 1] === next[nextEnd - 1]
  ) {
    previousEnd -= 1;
    nextEnd -= 1;
  }
  if (start > 0 && isHighSurrogate(previous.charCodeAt(start - 1))) start -= 1;
  if (previousEnd < previous.length && isLowSurrogate(previous.charCodeAt(previousEnd))) {
    previousEnd += 1;
    nextEnd += 1;
  }
  return { start, deleteCount: previousEnd - start, insert: next.slice(start, nextEnd) };
}

/** One contiguous replacement of rich text: the inserted part carries its mentions. */
export type RichSplice = { start: number; deleteCount: number; insert: TodayRichText };

/**
 * `safeTextDiff` over rich text: a position matches only when its character
 * and, for U+FFFC, its mention are the same. A plain diff cannot tell two
 * adjacent mentions apart (deleting the first would delete the second) and
 * misses a mention replaced in place (the text does not change).
 */
export function safeRichDiff(previous: TodayRichText, next: TodayRichText): RichSplice | null {
  const keyed = (rich: TodayRichText) => {
    const keys = new Map(rich.mentions.map((m) => [m.start, `${m.kind}\u0000${m.id}`]));
    return (index: number) =>
      rich.text[index] === TODAY_MENTION_CHAR
        ? `${TODAY_MENTION_CHAR}${keys.get(index) ?? ''}`
        : rich.text[index];
  };
  const a = keyed(previous);
  const b = keyed(next);
  const previousLength = previous.text.length;
  const nextLength = next.text.length;
  let start = 0;
  const shortest = Math.min(previousLength, nextLength);
  while (start < shortest && a(start) === b(start)) start += 1;
  let previousEnd = previousLength;
  let nextEnd = nextLength;
  while (previousEnd > start && nextEnd > start && a(previousEnd - 1) === b(nextEnd - 1)) {
    previousEnd -= 1;
    nextEnd -= 1;
  }
  if (start === previousEnd && start === nextEnd) return null;
  if (start > 0 && isHighSurrogate(previous.text.charCodeAt(start - 1))) start -= 1;
  if (previousEnd < previousLength && isLowSurrogate(previous.text.charCodeAt(previousEnd))) {
    previousEnd += 1;
    nextEnd += 1;
  }
  return {
    start,
    deleteCount: previousEnd - start,
    insert: sliceTodayRich(next, start, nextEnd),
  };
}

/**
 * Move a caret offset through a text delta. Text inserted exactly at the caret
 * lands after it (a peer typing at your caret does not push it); a deletion
 * covering the caret clamps it to the deletion start.
 */
export function transformOffset(offset: number, delta: readonly TextDeltaStep[]): number {
  let position = 0;
  let result = offset;
  for (const step of delta) {
    if (step.retain) position += step.retain;
    else if (typeof step.insert === 'string') {
      if (position < offset) result += step.insert.length;
    } else if (step.delete) {
      if (position < offset) result -= Math.min(step.delete, offset - position);
      position += step.delete;
    }
  }
  return result;
}
