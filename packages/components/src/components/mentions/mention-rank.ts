import { scoreFuzzy } from '@/components/mentions/vscode-fuzzy-score';

/**
 * Shared matching for file, session, Agent Role, issue, and PR candidates.
 *
 * This uses the vendored VS Code Quick Open scorer: a query such as `filename`
 * finds `file name`, `file-name`, and `file-generated-name`, with the same
 * consecutive, separator, path, case, and camel-case bonuses as VS Code.
 *
 * A leaf module on purpose: the registry imports the sources, so the sources
 * cannot import the registry.
 */
export function scoreMentionMatch(term: string, text: string): number | null {
  const query = term.trim();
  if (!query) return 0;
  const [score] = scoreFuzzy(text, query, query.toLowerCase(), true);
  return score > 0 ? score : null;
}

export function rankMentionCandidates<T>(
  items: readonly T[],
  term: string,
  options: {
    /** Every row is an arrow-key stop, so a source must never return more. */
    limit: number;
    fields: (item: T) => readonly string[];
    /** Applied between equally-scored items; source order otherwise. */
    tieBreak?: (left: T, right: T) => number;
  }
): T[] {
  const query = term.trim();
  if (!query) return items.slice(0, options.limit);
  const { tieBreak } = options;
  return items
    .map((item, index) => {
      let score: number | null = null;
      for (const field of options.fields(item)) {
        const fieldScore = scoreMentionMatch(query, field);
        if (fieldScore !== null && (score === null || fieldScore > score)) score = fieldScore;
      }
      return { item, index, score };
    })
    .filter((entry): entry is { item: T; index: number; score: number } => entry.score !== null)
    .sort((left, right) => {
      if (left.score !== right.score) return right.score - left.score;
      const tied = tieBreak?.(left.item, right.item) ?? 0;
      return tied || left.index - right.index;
    })
    .slice(0, options.limit)
    .map((entry) => entry.item);
}
