import { UNCACHED, fill, findIndex } from '../cache.js';
import type { Layout } from './types.js';
import type { CacheSnapshot, ItemKey } from '../types.js';
import { max, min, sort } from '../utils.js';
/**
 * @internal
 */
export interface ListLayout extends Layout {
  $snapshot(): CacheSnapshot;
  /**
   * Lody: replace the item list by key. Sizes follow their keys instead of
   * their indexes; a key seen before (in this layout or the restored snapshot)
   * gets its measured size back. Returns false when the keys did not change.
   */
  $setKeys(nextKeys: readonly ItemKey[]): boolean;
}

/**
 * @internal
 */
export const createListLayout = (
  length: number,
  itemSize?: number | undefined,
  snapshot?: CacheSnapshot | undefined,
  initialKeys?: readonly ItemKey[] | undefined
): ListLayout => {
  let defaultItemSize = (snapshot && snapshot[1]) || itemSize || 40;

  let computedOffsetIndex = -1;
  let prevStartIndex = 0;

  const restoredSizes = snapshot && snapshot[0];
  const restoredKeys = snapshot && snapshot[2];

  // Lody: every measured size by item key, including items no longer listed,
  // so an item that comes back (a placeholder expanding, a row remounting
  // after the list changed) starts at its real size.
  const knownSizes = new Map<ItemKey, number>();
  if (restoredKeys && restoredSizes) {
    restoredKeys.forEach((key, i) => {
      const size = restoredSizes[i];
      if (size != null && size !== UNCACHED) knownSizes.set(key, size);
    });
  }
  let keys: ItemKey[] | undefined = initialKeys && initialKeys.slice();

  const sizes: number[] = keys
    ? keys.map((key) => knownSizes.get(key) ?? UNCACHED)
    : restoredSizes && !restoredKeys
      ? // https://github.com/inokawa/virtua/issues/441
        fill(
          restoredSizes.slice(0, min(length, restoredSizes.length)),
          max(0, length - restoredSizes.length)
        )
      : fill([], length);
  const offsets: number[] = fill([], length + 1);

  const getSize = (index: number): number => {
    const size = sizes[index]!;
    return size === UNCACHED ? defaultItemSize : size;
  };

  const getOffset = (index: number): number => {
    if (!length) return 0;
    if (computedOffsetIndex >= index) {
      return offsets[index]!;
    }

    if (computedOffsetIndex < 0) {
      // first offset must be 0 to avoid returning NaN, which can cause infinite rerender.
      // https://github.com/inokawa/virtua/pull/160
      offsets[0] = 0;
      computedOffsetIndex = 0;
    }
    let i = computedOffsetIndex;
    let top = offsets[i]!;
    while (i < index) {
      top += getSize(i);
      offsets[++i] = top;
    }
    // mark as measured
    computedOffsetIndex = index;
    return top;
  };

  return {
    $getRange: (startOffset, endOffset) => {
      // Clamp because prevStartIndex may exceed the limit when children decreased a lot after scrolling
      prevStartIndex = min(prevStartIndex, length - 1);

      let start: number;
      let end: number;
      if (getOffset(prevStartIndex) <= startOffset) {
        // search forward
        // start <= end, prevStartIndex <= start
        end = findIndex(getOffset, length, endOffset, prevStartIndex);
        start = findIndex(getOffset, length, startOffset, prevStartIndex, end);
      } else {
        // search backward
        // start <= end, start <= prevStartIndex
        start = findIndex(getOffset, length, startOffset, undefined, prevStartIndex);
        end = findIndex(getOffset, length, endOffset, start);
      }
      prevStartIndex = start;
      return [start, end];
    },
    $findIndex: (offset) => findIndex(getOffset, length, offset),
    $getItemOffset: getOffset,
    $getItemSize: getSize,
    $setItemSize: (index, size) => {
      const isInitialMeasurement = sizes[index] === UNCACHED;
      sizes[index] = size;
      const key = keys && keys[index];
      if (key != null) knownSizes.set(key, size);
      // mark as dirty
      computedOffsetIndex = min(index, computedOffsetIndex);
      return isInitialMeasurement;
    },
    $isSizeEqual: (index, size = UNCACHED) => sizes[index] === size,
    $getTotalSize: () => getOffset(length),
    $getLength: () => length,
    $setLength: (nextLength, isShift) => {
      const diff = nextLength - length;

      computedOffsetIndex = isShift
        ? // Discard cache for now
          -1
        : min(nextLength - 1, computedOffsetIndex);
      length = nextLength;

      if (diff > 0) {
        // Added
        fill(offsets, diff);
        fill(sizes, diff, isShift);
        return defaultItemSize * diff;
      } else {
        // Removed
        offsets.splice(diff);
        return (isShift ? sizes.splice(0, -diff) : sizes.splice(diff)).reduce(
          (acc, removed) => acc - (removed === UNCACHED ? defaultItemSize : removed),
          0
        );
      }
    },
    $estimateDefaultSize: itemSize
      ? undefined
      : (startIndex) => {
          let measuredCountBeforeStart = 0;
          // This function will be called after measurement so measured size array must be longer than 0
          const measuredSizes: number[] = [];
          sizes.forEach((s, i) => {
            if (s !== UNCACHED) {
              // https://github.com/inokawa/virtua/issues/907
              if (s) {
                measuredSizes.push(s);
              }
              if (i < startIndex) {
                measuredCountBeforeStart++;
              }
            }
          });

          // Discard cache for now
          computedOffsetIndex = -1;

          // Calculate median
          sort(measuredSizes);
          const len = measuredSizes.length;
          const mid = (len / 2) | 0;
          const median =
            len % 2 === 0
              ? (measuredSizes[mid - 1]! + measuredSizes[mid]!) / 2
              : measuredSizes[mid]!;

          const prevDefaultItemSize = defaultItemSize;

          // Calculate diff of unmeasured items before start
          return (
            ((defaultItemSize = median) - prevDefaultItemSize) *
            max(startIndex - measuredCountBeforeStart, 0)
          );
        },
    $snapshot: () =>
      keys ? [sizes.slice(), defaultItemSize, keys.slice()] : [sizes.slice(), defaultItemSize],
    $setKeys: (nextKeys) => {
      if (keys && keys.length === nextKeys.length && keys.every((key, i) => key === nextKeys[i])) {
        return false;
      }
      keys = nextKeys.slice();
      length = keys.length;
      sizes.length = 0;
      for (const key of keys) sizes.push(knownSizes.get(key) ?? UNCACHED);
      offsets.length = 0;
      fill(offsets, length + 1);
      // Every offset may have moved.
      computedOffsetIndex = -1;
      prevStartIndex = 0;
      return true;
    },
  };
};
