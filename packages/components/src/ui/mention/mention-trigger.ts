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

const EMAIL_LOCAL_PART_RE = /[A-Za-z0-9._%+-]$/;
const EMAIL_DOMAIN_RE = /^(?:[A-Za-z0-9-]+\.)+[A-Za-z]*$/;

/**
 * Whether a trigger sits glued to non-whitespace text before it
 * (`price$100`) rather than standing alone at the start of the input or after
 * a space (`$review`, `hey $review`).
 *
 * Consumers: the word guard shared by every trigger the menu does not open
 * mid-word (`$`, `/`, `、`) treats a glued trigger as part of code.
 */
export function isTriggerGluedToWord(value: string, triggerIndex: number): boolean {
  const charBeforeTrigger = value[triggerIndex - 1] ?? '';
  return charBeforeTrigger !== '' && !/\s/.test(charBeforeTrigger);
}

/**
 * Whether the trigger and the query after it read as an email address being
 * typed — an ASCII local part right against the trigger, then dotted domain
 * labels whose last label is letters only, possibly still empty:
 * `gabi@example.`, `gabi@example.co`, `me@mail.co.uk.`.
 *
 * Typing one is not a mention attempt: once the first dot is in, the menu gives
 * up and stays closed through the rest of the address, so it is never matched
 * against skills, files, or sessions and does not reopen on `example.com.`.
 * Both halves must hold, so a mention is not mistaken for an address:
 * - the character before the trigger must be a local-part character, which
 *   keeps `请@README.md` and `我想@GPT-5.6-Code-Reviewer` (CJK before the
 *   trigger, the very case this menu exists for) and any standalone `@README.md`
 *   open;
 * - the query must be a run of `label.` segments plus a letters-only tail, which
 *   keeps a path (`bug@src/a.b`) or a name with a non-letter last label
 *   (`bug@GPT-5.6-Code-Reviewer`) open.
 *
 * The partial query before any dot (`user@example`) is deliberately left alone —
 * it is still ambiguous, and mid-sentence mentions after an English word
 * (`fix this bug@alpha`) must keep working.
 */
export function looksLikeEmailAddress(
  value: string,
  triggerIndex: number,
  search: string
): boolean {
  return EMAIL_LOCAL_PART_RE.test(value[triggerIndex - 1] ?? '') && EMAIL_DOMAIN_RE.test(search);
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
