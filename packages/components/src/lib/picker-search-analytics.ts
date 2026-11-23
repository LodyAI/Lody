import { capturePostHogSampled, type PostHogAnalyticsClient } from '@/lib/posthog-analytics';

export type SearchPickerKind = 'model' | 'skill';

/**
 * A pick made from a search-narrowed list. Tier C: pickers are high-frequency.
 * Only the term's length leaves the client, never the term; a pick with no
 * term is not a search and is not reported.
 */
export function capturePickerSearchSelected(
  postHog: PostHogAnalyticsClient | null | undefined,
  input: { picker: SearchPickerKind; term: string; rank: number; resultCount: number }
): void {
  const termLength = input.term.trim().length;
  if (termLength === 0 || input.rank < 0) return;
  capturePostHogSampled(
    postHog,
    'picker/search_selected',
    {
      picker: input.picker,
      term_length: termLength,
      rank: input.rank,
      result_count: input.resultCount,
    },
    { tier: 'C' }
  );
}
