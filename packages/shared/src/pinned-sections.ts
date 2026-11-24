import { FractionalIndex, type JitterOptions } from './vendor/loro-fractional-index';

/**
 * Pinned conversation sections and manual fractional-index ordering.
 *
 * A section is one workspace Flock row; a conversation's place is two optional
 * fields on its own metadata (`pinSectionId`, `orderKey`) beside `isPinned`.
 * `orderKey` is also shared by the Status view's Focus list.
 * Behavior and compatibility: specs/pinned-session-sections.md, specs/sidebar-status-view.md.
 */
export type PinSection = {
  id: string;
  name: string;
  /** Fractional index (canonical uppercase hex) ordering sections. */
  orderKey: string;
};

export const PIN_SECTION_NAME_MAX_LENGTH = 100;
const PIN_SECTION_ID_MAX_LENGTH = 200;

/** Random bytes appended to every generated key so concurrent inserts do not collide. */
const PIN_ORDER_JITTER_BYTES = 3;

/**
 * A usable order key. An all-zero key is a well-formed index with nothing
 * before it, so a key above it cannot be generated; it reads as no key.
 */
export const isPinOrderKey = (value: unknown): value is string =>
  FractionalIndex.isFractionalIndex(value) && /[1-9A-F]/u.test(value);

export const normalizePinSection = (value: unknown): PinSection | undefined => {
  if (!value || typeof value !== 'object') return undefined;
  const record = value as Record<string, unknown>;
  const id = typeof record.id === 'string' ? record.id.trim() : '';
  const name = typeof record.name === 'string' ? record.name.trim() : '';
  if (!id || id.length > PIN_SECTION_ID_MAX_LENGTH) return undefined;
  if (!name || name.length > PIN_SECTION_NAME_MAX_LENGTH) return undefined;
  if (!isPinOrderKey(record.orderKey)) return undefined;
  return { id, name, orderKey: record.orderKey };
};

/** Section order: key, then id so equal keys from concurrent writers agree everywhere. */
export const comparePinSections = (left: PinSection, right: PinSection): number =>
  FractionalIndex.compare(left.orderKey, right.orderKey) || left.id.localeCompare(right.id);

/** What the layout needs to know about one pinned conversation. */
export type PinnedSessionPlacement = {
  id: string;
  pinSectionId?: string | null;
  orderKey?: string | null;
  /** Latest activity; orders conversations that have no key yet. */
  recency: number;
};

export type PinnedSectionLayoutEntry<T> = {
  /** `null` is the default "Pinned" section. */
  sectionId: string | null;
  section: PinSection | null;
  items: T[];
};

export type PinnedSectionLayout<T> = PinnedSectionLayoutEntry<T>[];

const validKey = (placement: PinnedSessionPlacement): string | null =>
  isPinOrderKey(placement.orderKey) ? placement.orderKey : null;

/**
 * The pin area in render order: the default section, then every user section
 * (empty ones included, so they stay drop targets). A conversation naming a
 * missing section shows in the default one, once the sections are known. Within a section, keyed
 * conversations come first by key; conversations without a key (pinned before
 * manual ordering existed) follow by latest activity. Ties fall to the id.
 */
export function buildPinnedSectionLayout<T>(
  items: readonly T[],
  sections: readonly PinSection[],
  getPlacement: (item: T) => PinnedSessionPlacement,
  options: {
    /**
     * False while the section rows have not been read yet. A conversation that
     * names a section is then held back rather than shown in the default
     * section, so it never jumps once its section arrives.
     */
    sectionsLoaded?: boolean;
  } = {}
): PinnedSectionLayout<T> {
  const sectionsLoaded = options.sectionsLoaded ?? true;
  const orderedSections = [...sections].sort(comparePinSections);
  const buckets = new Map<string | null, { item: T; placement: PinnedSessionPlacement }[]>();
  buckets.set(null, []);
  for (const section of orderedSections) buckets.set(section.id, []);

  for (const item of items) {
    const placement = getPlacement(item);
    if (!sectionsLoaded && placement.pinSectionId) continue;
    const sectionId =
      placement.pinSectionId && buckets.has(placement.pinSectionId) ? placement.pinSectionId : null;
    buckets.get(sectionId)?.push({ item, placement });
  }

  const sortEntries = (entries: { item: T; placement: PinnedSessionPlacement }[]): T[] =>
    entries
      .sort((left, right) => {
        const leftKey = validKey(left.placement);
        const rightKey = validKey(right.placement);
        if (leftKey && rightKey) {
          return (
            FractionalIndex.compare(leftKey, rightKey) ||
            left.placement.id.localeCompare(right.placement.id)
          );
        }
        if (leftKey) return -1;
        if (rightKey) return 1;
        return (
          right.placement.recency - left.placement.recency ||
          left.placement.id.localeCompare(right.placement.id)
        );
      })
      .map((entry) => entry.item);

  return [
    { sectionId: null, section: null, items: sortEntries(buckets.get(null) ?? []) },
    ...orderedSections.map((section) => ({
      sectionId: section.id,
      section,
      items: sortEntries(buckets.get(section.id) ?? []),
    })),
  ];
}

/** One metadata write: `pinSectionId: undefined` means the default section. */
export type PinPlacementWrite = {
  sessionId: string;
  pinSectionId: string | undefined;
  orderKey: string;
};

const jitterOptions = (options?: JitterOptions): JitterOptions => ({
  jitter: PIN_ORDER_JITTER_BYTES,
  ...options,
});

/**
 * A key strictly between `lower` and `upper` (either may be open). Equal or
 * inverted neighbours — two writers that picked the same key — fall back to
 * just after `lower`; the id tie-break keeps the result deterministic.
 */
const keyBetween = (
  lower: string | null,
  upper: string | null,
  options?: JitterOptions
): string => {
  const opts = jitterOptions(options);
  if (lower && upper && FractionalIndex.compare(lower, upper) >= 0) {
    return FractionalIndex.newAfterJitter(lower, opts);
  }
  return (
    FractionalIndex.newJitter(lower, upper, opts) ??
    (lower ? FractionalIndex.newAfterJitter(lower, opts) : FractionalIndex.jitterDefault(opts))
  );
};

/**
 * Plan moving `sessionId` to `toIndex` of `toSectionId` (an index into that
 * section's list without the moved conversation). Normally one write. When
 * the drop lands below conversations that have no key yet, those above the
 * drop get keys first, in their current order; nothing below is written.
 */
export function planPinnedSessionMove<T extends PinnedSessionPlacement>(
  layout: PinnedSectionLayout<T>,
  move: { sessionId: string; toSectionId: string | null; toIndex: number },
  options?: JitterOptions
): PinPlacementWrite[] {
  const target = layout.find((entry) => entry.sectionId === move.toSectionId) ?? layout[0];
  const sectionId = target?.sectionId ?? null;
  const list = (target?.items ?? []).filter((item) => item.id !== move.sessionId);
  const index = Math.max(0, Math.min(move.toIndex, list.length));
  const above = list.slice(0, index);
  const below = list[index];

  const writes: PinPlacementWrite[] = [];
  let lower: string | null = null;
  for (const item of above) {
    const key = validKey(item);
    if (key) {
      lower = key;
      continue;
    }
    lower = keyBetween(lower, null, options);
    writes.push({ sessionId: item.id, pinSectionId: sectionId ?? undefined, orderKey: lower });
  }
  const upper = below ? validKey(below) : null;
  writes.push({
    sessionId: move.sessionId,
    pinSectionId: sectionId ?? undefined,
    orderKey: keyBetween(lower, upper, options),
  });
  return writes;
}

/** Where a newly pinned conversation goes: the top of the default section. */
export function planNewPinPlacement<T extends PinnedSessionPlacement>(
  layout: PinnedSectionLayout<T>,
  options?: JitterOptions
): { orderKey: string } {
  const first = layout.find((entry) => entry.sectionId === null)?.items[0];
  return { orderKey: keyBetween(null, first ? validKey(first) : null, options) };
}

/** Key for moving section `sectionId` to `toIndex` among the user sections. */
export function planPinSectionMove(
  sections: readonly PinSection[],
  sectionId: string,
  toIndex: number,
  options?: JitterOptions
): string {
  const others = [...sections].sort(comparePinSections).filter((entry) => entry.id !== sectionId);
  const index = Math.max(0, Math.min(toIndex, others.length));
  return keyBetween(others[index - 1]?.orderKey ?? null, others[index]?.orderKey ?? null, options);
}

/** Key for a new section, after every existing one. */
export function planNewPinSectionOrderKey(
  sections: readonly PinSection[],
  options?: JitterOptions
): string {
  const last = [...sections].sort(comparePinSections).at(-1);
  return keyBetween(last?.orderKey ?? null, null, options);
}

/** Placement input for a single manually ordered list (e.g. Status Focus). */
export type ManualOrderPlacement = {
  id: string;
  orderKey?: string | null;
  recency?: number;
};

/** One manual-order metadata write. */
export type ManualOrderWrite = {
  sessionId: string;
  orderKey: string;
};

/**
 * Sort items by fractional `orderKey` first (deterministic id tie-break),
 * with unkeyed items trailing by stable ascending `id` so ordinary new replies
 * never cause Focus rows to jump around.
 */
export function sortByManualOrder<T>(
  items: readonly T[],
  getPlacement: (item: T) => ManualOrderPlacement
): T[] {
  return items
    .map((item) => ({ item, placement: getPlacement(item) }))
    .sort((left, right) => {
      const leftKey = isPinOrderKey(left.placement.orderKey) ? left.placement.orderKey : null;
      const rightKey = isPinOrderKey(right.placement.orderKey) ? right.placement.orderKey : null;
      if (leftKey && rightKey) {
        return (
          FractionalIndex.compare(leftKey, rightKey) ||
          left.placement.id.localeCompare(right.placement.id)
        );
      }
      if (leftKey) return -1;
      if (rightKey) return 1;
      return left.placement.id.localeCompare(right.placement.id);
    })
    .map((entry) => entry.item);
}

/**
 * Plan moving `sessionId` to `toIndex` within a flat manually ordered list
 * (index into the list without the moved session). Mirrors `planPinnedSessionMove`:
 * assigns keys to unkeyed items above the drop slot so the moved item lands
 * strictly between its neighbors without touching items below.
 */
export function planManualOrderMove<T extends ManualOrderPlacement>(
  orderedItems: readonly T[],
  move: { sessionId: string; toIndex: number },
  options?: JitterOptions
): ManualOrderWrite[] {
  const list = orderedItems.filter((item) => item.id !== move.sessionId);
  const index = Math.max(0, Math.min(move.toIndex, list.length));
  const above = list.slice(0, index);
  const below = list[index];

  const writes: ManualOrderWrite[] = [];
  let lower: string | null = null;
  for (const item of above) {
    const key = isPinOrderKey(item.orderKey) ? item.orderKey : null;
    if (key) {
      lower = key;
      continue;
    }
    lower = keyBetween(lower, null, options);
    writes.push({ sessionId: item.id, orderKey: lower });
  }
  const upper = below && isPinOrderKey(below.orderKey) ? below.orderKey : null;
  writes.push({
    sessionId: move.sessionId,
    orderKey: keyBetween(lower, upper, options),
  });
  return writes;
}

/** Generate an `orderKey` that places an item at the top of a manually ordered list. */
export function planTopOrderKey<T extends ManualOrderPlacement>(
  orderedItems: readonly T[],
  options?: JitterOptions
): string {
  const first = orderedItems[0];
  const upper = first && isPinOrderKey(first.orderKey) ? first.orderKey : null;
  return keyBetween(null, upper, options);
}
