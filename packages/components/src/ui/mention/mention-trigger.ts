export type TriggerCandidate = {
  trigger: string;
  index: number;
};

export function findTriggerCandidates(
  value: string,
  triggers: string[],
  fromIndex: number,
): TriggerCandidate[] {
  const clampedFromIndex = Math.max(0, Math.min(fromIndex, value.length));
  const candidates: TriggerCandidate[] = [];

  for (const trigger of triggers) {
    if (!trigger) continue;
    const index = value.lastIndexOf(trigger, clampedFromIndex);
    if (index !== -1) candidates.push({ trigger, index });
  }

  candidates.sort((a, b) => b.index - a.index);
  return candidates;
}

const NAMESPACE_SEARCH_RE = /^([a-z][a-z0-9-]*):(.*)$/;

/**
 * Split the text between the trigger and the caret into a drill-down namespace
 * and the term scoped to it — `issue:foo` becomes `{ namespace: 'issue', term:
 * 'foo' }`. Returns null for anything that is not a namespaced search, which is
 * how path drill-downs (`src/`) stay out of the grammar.
 *
 * The single owner of the `@<ns>:` syntax: the menu resolves its level from
 * this, and Backspace pops a bare prefix from it, so the two cannot disagree
 * about what counts as a namespace.
 */
export function parseMentionNamespaceSearch(
  search: string
): { namespace: string; term: string } | null {
  const match = NAMESPACE_SEARCH_RE.exec(search);
  if (!match?.[1]) return null;
  return { namespace: match[1], term: match[2] ?? '' };
}

/**
 * Whether the text between the trigger and the caret is a bare category
 * drill-down prefix — the `issue:` in `@issue:`. Backspace pops such a prefix
 * back to the bare trigger in one keystroke instead of deleting the colon.
 *
 * Path drill-downs (`src/`) are deliberately excluded: inside a path, Backspace
 * must keep deleting one character at a time.
 */
export function isMentionNavigationPrefix(search: string): boolean {
  return parseMentionNamespaceSearch(search)?.term === '';
}
