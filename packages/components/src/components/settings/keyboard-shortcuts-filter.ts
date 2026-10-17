import { canonicalizeBinding } from '@/lib/commands/key-matcher';

export type ShortcutFilter = {
  /** Free text matched against a row's label, title, and id. */
  query: string;
  /** A recorded combo in registry syntax, or `null` when no key filter is set. */
  keyFilter: string | null;
};

export type ShortcutFilterRow = {
  /** The label as displayed, in the current language. */
  label: string;
  /** The untranslated title, so an English name still finds a translated row. */
  title: string;
  id: string;
  /** Every binding currently active for the row; `null` stands for unbound. */
  bindings: readonly (string | null)[];
};

export function isShortcutFilterActive({ query, keyFilter }: ShortcutFilter): boolean {
  return query.trim() !== '' || keyFilter !== null;
}

/** Both filters must hold. A combo matches when any binding has the same canonical form. */
export function matchesShortcutFilter(row: ShortcutFilterRow, filter: ShortcutFilter): boolean {
  const needle = filter.query.trim().toLowerCase();
  if (
    needle &&
    ![row.label, row.title, row.id].some((value) => value.toLowerCase().includes(needle))
  ) {
    return false;
  }
  if (filter.keyFilter === null) return true;
  const wanted = canonicalizeBinding(filter.keyFilter);
  if (!wanted) return false;
  return row.bindings.some(
    (binding) => binding !== null && canonicalizeBinding(binding) === wanted
  );
}
