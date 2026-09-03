import type { TurnIndexRow } from '@/lib/conversation-view';

/**
 * Height a not-yet-hydrated turn is given so Virtua's scroll geometry stays
 * close to what the hydrated rows will measure. A finished assistant turn
 * folds its work into one "Worked for" row, so activity contributes one row
 * regardless of count; prose adds lines. Without a summary the item count is
 * the only signal, and without that a role-based constant.
 */
export const PLACEHOLDER_BASE_HEIGHT_PX = { user: 84, assistant: 132, system: 64 } as const;
const PROSE_CHARS_PER_LINE = 90;
const PROSE_LINE_HEIGHT_PX = 22;
const ACTIVITY_ROW_HEIGHT_PX = 40;
const ITEM_HEIGHT_PX = 28;
const MIN_HEIGHT_PX = 56;
const MAX_HEIGHT_PX = 1600;

const clamp = (value: number): number =>
  Math.min(Math.max(Math.round(value), MIN_HEIGHT_PX), MAX_HEIGHT_PX);

export function estimateTurnHeightPx(
  row: Pick<TurnIndexRow, 'role' | 'summary' | 'itemCount'>
): number {
  const base =
    row.role === 'user'
      ? PLACEHOLDER_BASE_HEIGHT_PX.user
      : row.role === 'assistant'
        ? PLACEHOLDER_BASE_HEIGHT_PX.assistant
        : PLACEHOLDER_BASE_HEIGHT_PX.system;
  const summary = row.summary;
  if (summary) {
    const proseLines = Math.ceil(Math.max(summary.textChars, 0) / PROSE_CHARS_PER_LINE);
    const activity = summary.activity;
    const activityCount =
      (activity?.commandCount ?? 0) +
      (activity?.editFileCount ?? 0) +
      (activity?.readFileCount ?? 0) +
      (activity?.searchCount ?? 0);
    return clamp(
      base + proseLines * PROSE_LINE_HEIGHT_PX + (activityCount > 0 ? ACTIVITY_ROW_HEIGHT_PX : 0)
    );
  }
  if (row.itemCount !== undefined) return clamp(base + row.itemCount * ITEM_HEIGHT_PX);
  return clamp(base);
}
