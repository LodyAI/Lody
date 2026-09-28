import type { Geometry } from './geometry';
import type { EngineRow, ReadingAnchor } from './types';

export interface ResolvedAnchor {
  index: number;
  offsetPx: number;
  /** The anchor could not be found as recorded and fell back (rules 2–6). */
  fellBack: boolean;
}

/** The anchor `offsetPx` pixels into `row`. */
export function anchorOfRow(row: EngineRow, offsetPx: number): ReadingAnchor {
  if (row.fixed) return { kind: 'fixed-row', fixed: row.fixed, offsetPx };
  return {
    kind: 'turn',
    turnId: row.turnId ?? '',
    turnIndex: row.turnIndex,
    rowKey: row.key,
    item:
      row.itemIndex !== null
        ? { index: row.itemIndex, identity: row.itemIdentity }
        : row.firstItemIndex !== null
          ? { index: row.firstItemIndex, identity: null }
          : null,
    offsetPx,
  };
}

/**
 * The reading anchor at item-space offset `y` (the top of the viewport's
 * content area). An offset above the first row anchors to the first row with
 * a negative `offsetPx`.
 */
export function deriveAnchor(
  rows: readonly EngineRow[],
  geometry: Geometry,
  y: number
): ReadingAnchor | null {
  const index = geometry.findIndex(Math.max(0, y));
  const row = rows[index];
  if (!row) return null;
  return anchorOfRow(row, y - geometry.offset(index));
}

const clampOffset = (offsetPx: number, size: number) =>
  Math.min(Math.max(offsetPx, Math.min(0, offsetPx)), Math.max(0, size));

/**
 * Where a reading anchor is now. Rules, in order (the scroll-engine note):
 *
 * 1. the recorded row still exists in the same turn: that row, at `offsetPx`
 *    clamped to its size. This includes a placeholder: the reader may rest
 *    inside one, and a turn hydrating under the same key (a user turn) gets
 *    the recorded offset back;
 * 2. the recorded item is rendered as its own row (same index and identity):
 *    that row, at `offsetPx`;
 * 3. an item with the recorded identity elsewhere in the turn: that row;
 * 4. the item is folded into a group: the last row of the turn that starts at
 *    or before it (the group header), at 0;
 * 5. the turn exists (hydrated or as a placeholder): its first row, at 0 —
 *    the anchor is kept, and resolves again once its row is back;
 * 6. the turn is gone: the next surviving turn in the old order, else the
 *    previous one, at 0.
 *
 * Fixed rows resolve to themselves; a missing agent-activity or trailing row
 * falls back to the last row, a missing leading row to the first.
 */
export function resolveAnchor(
  rows: readonly EngineRow[],
  anchor: ReadingAnchor,
  geometry: Geometry
): ResolvedAnchor | null {
  if (rows.length === 0) return null;
  if (anchor.kind === 'fixed-row') {
    const index = rows.findIndex((row) => row.fixed === anchor.fixed);
    if (index >= 0) {
      return {
        index,
        offsetPx: clampOffset(anchor.offsetPx, geometry.size(index)),
        fellBack: false,
      };
    }
    return {
      index: anchor.fixed === 'leading' ? 0 : rows.length - 1,
      offsetPx: 0,
      fellBack: true,
    };
  }

  const byKey = geometry.indexOfKey(anchor.rowKey);
  if (byKey >= 0 && rows[byKey]?.turnId === anchor.turnId) {
    return {
      index: byKey,
      offsetPx: clampOffset(anchor.offsetPx, geometry.size(byKey)),
      fellBack: false,
    };
  }

  let firstOfTurn = -1;
  let exact = -1;
  let byIdentity = -1;
  let covering = -1;
  for (let index = 0; index < rows.length; index += 1) {
    const row = rows[index]!;
    if (row.turnId !== anchor.turnId) {
      if (firstOfTurn >= 0) break;
      continue;
    }
    if (firstOfTurn < 0) firstOfTurn = index;
    if (!anchor.item || row.placeholder) continue;
    if (
      row.itemIndex === anchor.item.index &&
      (anchor.item.identity === null || row.itemIdentity === anchor.item.identity)
    ) {
      exact = index;
    }
    if (anchor.item.identity !== null && row.itemIdentity === anchor.item.identity) {
      byIdentity = index;
    }
    if (row.firstItemIndex !== null && row.firstItemIndex <= anchor.item.index) {
      covering = index;
    }
  }
  if (exact >= 0) {
    return {
      index: exact,
      offsetPx: clampOffset(anchor.offsetPx, geometry.size(exact)),
      fellBack: false,
    };
  }
  if (byIdentity >= 0) {
    return {
      index: byIdentity,
      offsetPx: clampOffset(anchor.offsetPx, geometry.size(byIdentity)),
      fellBack: true,
    };
  }
  if (covering >= 0) return { index: covering, offsetPx: 0, fellBack: true };
  if (firstOfTurn >= 0) return { index: firstOfTurn, offsetPx: 0, fellBack: true };

  // The turn is gone: the next surviving turn in the old order, else the previous.
  let next = -1;
  let previous = -1;
  for (let index = 0; index < rows.length; index += 1) {
    const row = rows[index]!;
    if (row.turnId === null) continue;
    if (row.turnIndex >= anchor.turnIndex) {
      next = index;
      break;
    }
    previous = index;
  }
  if (next >= 0) return { index: next, offsetPx: 0, fellBack: true };
  if (previous >= 0) {
    // The previous turn's first row.
    const turnId = rows[previous]!.turnId;
    let first = previous;
    while (first > 0 && rows[first - 1]!.turnId === turnId) first -= 1;
    return { index: first, offsetPx: 0, fellBack: true };
  }
  return { index: 0, offsetPx: 0, fellBack: true };
}
