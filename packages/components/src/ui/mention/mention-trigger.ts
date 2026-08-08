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

const NAVIGATION_PREFIX_RE = /^[a-z][a-z0-9-]*:$/;

/**
 * Whether the text between the trigger and the caret is a category drill-down
 * prefix — the `issue:` in `@issue:`. Backspace pops such a prefix back to the
 * bare trigger in one keystroke instead of deleting the colon.
 *
 * Path drill-downs (`src/`) are deliberately excluded: inside a path, Backspace
 * must keep deleting one character at a time.
 */
export function isMentionNavigationPrefix(search: string): boolean {
  return NAVIGATION_PREFIX_RE.test(search);
}
