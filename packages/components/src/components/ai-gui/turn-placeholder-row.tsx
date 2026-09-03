import { memo } from 'react';
import type { TurnIndexRow } from '@/lib/conversation-view';
import { ConversationColumn } from '@/components/shared/conversation-column';

/**
 * The row a turn renders while it is not hydrated: a quiet block whose height
 * approximates the hydrated turn so Virtua's offsets are close before the real
 * rows replace it, and whose head text keeps far-scrolled regions legible.
 *
 * Heights are estimates, not measurements — the hydrated rows re-measure the
 * moment they mount, which is the same path group expansion already exercises.
 */

const LINE_PX = 22;
const CHARS_PER_LINE = 88;

export function estimatePlaceholderHeight(row: TurnIndexRow): number {
  const summary = row.summary;
  if (row.role === 'user') {
    const lines = summary ? Math.min(12, Math.ceil(summary.textChars / CHARS_PER_LINE)) : 2;
    return 44 + Math.max(1, lines) * LINE_PX;
  }
  if (row.role === 'assistant') {
    if (!summary) return 96 + Math.min(row.itemCount ?? 0, 12) * 28;
    const proseLines = Math.min(60, Math.ceil(summary.textChars / CHARS_PER_LINE));
    const activityRows = Math.min(8, summary.toolCalls + summary.thoughts);
    return 64 + proseLines * LINE_PX + activityRows * 28;
  }
  return 56;
}

export const TurnPlaceholderRow = memo(function TurnPlaceholderRow({ row }: { row: TurnIndexRow }) {
  const head = row.summary?.headText.replace(/\s+/g, ' ').trim().slice(0, 140) ?? '';
  return (
    <ConversationColumn className="py-2 sm:py-3">
      <div
        data-turn-placeholder={row.role}
        aria-hidden
        className="rounded-md border border-transparent"
        style={{ minHeight: estimatePlaceholderHeight(row) }}
      >
        {head ? (
          <div className="truncate text-[13px] leading-snug text-muted-foreground/60">{head}</div>
        ) : null}
      </div>
    </ConversationColumn>
  );
});
