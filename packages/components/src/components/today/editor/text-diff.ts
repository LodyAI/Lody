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
