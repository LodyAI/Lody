export type SlashMatchFields = {
  /** The canonical text committed to the composer, without the slash. */
  token: string;
  name?: string;
  description?: string;
};

export type SlashMatchRank = {
  /** Exact, prefix, word prefix, substring, subsequence, description. */
  tier: number;
  /** Canonical token wins a tie against a display name. */
  field: number;
  position: number;
  gaps: number;
  extraLength: number;
};

const WORD_BOUNDARY_CHARS = new Set([' ', '\t', '\n', '\r', '-', '_', '/', ':', '.']);

export function normalizeSlashSearchTerm(value: string): string {
  return value
    .trim()
    .replace(/^[/、]+/, '')
    .toLowerCase();
}

export function compareSlashMatchRanks(a: SlashMatchRank, b: SlashMatchRank): number {
  return (
    a.tier - b.tier ||
    a.field - b.field ||
    a.position - b.position ||
    a.gaps - b.gaps ||
    a.extraLength - b.extraLength
  );
}

function findWordPrefixIndex(text: string, term: string): number {
  for (let index = 1; index < text.length; index += 1) {
    if (WORD_BOUNDARY_CHARS.has(text[index - 1] ?? '') && text.startsWith(term, index)) {
      return index;
    }
  }
  return -1;
}

function subsequenceMatch(text: string, term: string): { position: number; gaps: number } | null {
  let searchFrom = 0;
  let firstIndex = -1;
  let previousIndex = -1;
  let gaps = 0;
  for (const char of term) {
    const index = text.indexOf(char, searchFrom);
    if (index === -1) return null;
    if (firstIndex === -1) firstIndex = index;
    if (previousIndex !== -1) gaps += index - previousIndex - 1;
    previousIndex = index;
    searchFrom = index + 1;
  }
  return { position: firstIndex, gaps };
}

function rankName(text: string | undefined, term: string, field: number): SlashMatchRank | null {
  const normalized = text?.trim().replace(/^\/+/, '').toLowerCase();
  if (!normalized) return null;
  const extraLength = normalized.length - term.length;
  if (normalized === term) return { tier: 0, field, position: 0, gaps: 0, extraLength };
  if (normalized.startsWith(term)) {
    return { tier: 1, field, position: 0, gaps: 0, extraLength };
  }
  const wordIndex = findWordPrefixIndex(normalized, term);
  if (wordIndex !== -1) {
    return { tier: 2, field, position: wordIndex, gaps: 0, extraLength };
  }
  const substringIndex = normalized.indexOf(term);
  if (substringIndex !== -1) {
    return { tier: 3, field, position: substringIndex, gaps: 0, extraLength };
  }
  const fuzzy = subsequenceMatch(normalized, term);
  return fuzzy ? { tier: 4, field, ...fuzzy, extraLength } : null;
}

/** One ranking contract for Agent Commands and Prompt Shortcuts. */
export function rankSlashMatch(
  fields: SlashMatchFields,
  searchTerm: string
): SlashMatchRank | null {
  const term = normalizeSlashSearchTerm(searchTerm);
  if (!term) return { tier: 0, field: 0, position: 0, gaps: 0, extraLength: 0 };
  const matches = [rankName(fields.token, term, 0), rankName(fields.name, term, 1)];
  const description = fields.description?.trim().toLowerCase();
  const descriptionIndex = description?.indexOf(term) ?? -1;
  if (description && descriptionIndex !== -1) {
    matches.push({
      tier: 5,
      field: 2,
      position: descriptionIndex,
      gaps: 0,
      extraLength: description.length - term.length,
    });
  }
  return (
    matches
      .filter((match): match is SlashMatchRank => match !== null)
      .sort(compareSlashMatchRanks)[0] ?? null
  );
}

export function rankSlashItems<T>(
  items: readonly T[],
  searchTerm: string,
  fields: (item: T) => SlashMatchFields,
  limit = 50
): Array<{ item: T; rank: SlashMatchRank }> {
  const term = normalizeSlashSearchTerm(searchTerm);
  return items
    .map((item, index) => ({ item, index, rank: rankSlashMatch(fields(item), term) }))
    .filter(
      (entry): entry is { item: T; index: number; rank: SlashMatchRank } => entry.rank !== null
    )
    .sort((a, b) => (term ? compareSlashMatchRanks(a.rank, b.rank) : 0) || a.index - b.index)
    .slice(0, limit)
    .map(({ item, rank }) => ({ item, rank }));
}

export function sortRankedSlashItems<
  T extends {
    rank: SlashMatchRank;
    disabled?: boolean;
    token: string;
    id: string;
  },
>(items: readonly T[], limit = 50): T[] {
  return [...items]
    .sort(
      (a, b) =>
        Number(Boolean(a.disabled)) - Number(Boolean(b.disabled)) ||
        compareSlashMatchRanks(a.rank, b.rank) ||
        a.token.localeCompare(b.token) ||
        a.id.localeCompare(b.id)
    )
    .slice(0, limit);
}
