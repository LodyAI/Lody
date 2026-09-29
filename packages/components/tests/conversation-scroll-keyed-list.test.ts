// Moved with the keyed list layout from the removed Virtua fork (tests/keyed-list.test.ts)
// (the layout cases; the store cases were removed with the fork).
import { describe, expect, it } from 'vitest';
import { createListLayout } from '../src/lib/conversation-scroll/keyed-layout/list';

const keysOf = (...keys: string[]) => keys;

describe('keyed list layout', () => {
  it('keeps measured sizes with their keys when items are inserted in the middle', () => {
    const keys = keysOf('a', 'b', 'c');
    const layout = createListLayout(keys.length, 40, undefined, keys);
    layout.$setItemSize(0, 10);
    layout.$setItemSize(1, 20);
    layout.$setItemSize(2, 30);

    layout.$setKeys(keysOf('a', 'x', 'y', 'b', 'c'));

    expect([0, 1, 2, 3, 4].map((i) => layout.$getItemSize(i))).toEqual([10, 40, 40, 20, 30]);
    expect(layout.$isSizeEqual(1)).toBe(true); // "x" is unmeasured
    expect(layout.$getItemOffset(4)).toBe(10 + 40 + 40 + 20);
  });

  it('gives an item that comes back its earlier size', () => {
    const layout = createListLayout(2, 40, undefined, keysOf('a', 'b'));
    layout.$setItemSize(1, 77);
    layout.$setKeys(keysOf('a'));
    layout.$setKeys(keysOf('a', 'b'));
    expect(layout.$getItemSize(1)).toBe(77);
  });

  it('restores a keyed snapshot by key, whatever the item count', () => {
    const before = createListLayout(3, 40, undefined, keysOf('a', 'b', 'c'));
    before.$setItemSize(0, 11);
    before.$setItemSize(2, 33);
    const snapshot = before.$snapshot();
    expect(snapshot[2]).toEqual(['a', 'b', 'c']);

    const after = createListLayout(4, 40, snapshot, keysOf('new', 'a', 'b', 'c'));
    expect([0, 1, 2, 3].map((i) => after.$getItemSize(i))).toEqual([40, 11, 40, 33]);
  });
});
