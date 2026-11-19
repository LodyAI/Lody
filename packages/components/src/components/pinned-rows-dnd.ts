/**
 * Pinned row order while a pointer (dnd-kit) drag lands.
 *
 * The order is per section: section key → pinned root ids in display order.
 * Opened Sessions carried under a pinned opener are not in it; they follow
 * their opener.
 */
export type PinnedRowOrder = Readonly<Record<string, readonly string[]>>;

/** Key (and `data-pin-section` value) of the default "Pinned" section. */
export const DEFAULT_PIN_SECTION_KEY = 'default';

/** Key (and `data-pin-section` value) of the Status view's Focus list. */
export const FOCUS_SECTION_DND_KEY = '__status_focus__';

export const pinSectionKey = (sectionId: string | null): string =>
  sectionId ?? DEFAULT_PIN_SECTION_KEY;

/** Move `rowId` to `toIndex` among section `toKey`'s other rows. */
export function moveRowIntoSection(
  order: PinnedRowOrder,
  rowId: string,
  toKey: string,
  toIndex: number
): PinnedRowOrder {
  const next: Record<string, string[]> = {};
  for (const [key, ids] of Object.entries(order)) next[key] = ids.filter((id) => id !== rowId);
  const target = next[toKey] ?? [];
  const index = Math.max(0, Math.min(toIndex, target.length));
  next[toKey] = [...target.slice(0, index), rowId, ...target.slice(index)];
  return next;
}

/** Whether two orders list the same rows in the same places. */
export function sameRowOrder(left: PinnedRowOrder, right: PinnedRowOrder): boolean {
  const keys = new Set([...Object.keys(left), ...Object.keys(right)]);
  for (const key of keys) {
    const a = left[key] ?? [];
    const b = right[key] ?? [];
    if (a.length !== b.length || a.some((id, index) => id !== b[index])) return false;
  }
  return true;
}

/** dnd-kit ids of pinned rows and of user sections. */
export const pinnedRowDndId = (rowId: string) => `pin-row:${rowId}`;
export const pinSectionDndId = (sectionId: string) => `pin-section:${sectionId}`;

export type PinnedDndTarget = { kind: 'row'; id: string } | { kind: 'section'; id: string };

export function parsePinnedDndId(
  value: string | number | null | undefined
): PinnedDndTarget | null {
  const id = typeof value === 'string' ? value : null;
  if (!id) return null;
  if (id.startsWith('pin-row:')) return { kind: 'row', id: id.slice('pin-row:'.length) };
  if (id.startsWith('pin-section:'))
    return { kind: 'section', id: id.slice('pin-section:'.length) };
  return null;
}
