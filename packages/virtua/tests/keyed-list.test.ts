import { describe, expect, it } from 'vitest';
import { createListLayout } from '../src/core/layouts/list';
import {
  ACTION_ITEM_RESIZE,
  ACTION_ITEMS_KEYS_CHANGE,
  ACTION_SCROLL,
  ACTION_VIEWPORT_RESIZE,
  createVirtualStore,
} from '../src/core/store';

const keysOf = (...keys: string[]) => keys;

/** A keyed list of 100px items, viewport 300px, scrolled so `c` is at the top. */
function scrolledToC() {
  const keys = keysOf('a', 'b', 'c', 'd', 'e');
  const layout = createListLayout(keys.length, 100, undefined, keys);
  const store = createVirtualStore(layout);
  store.$setInitialKeys(keys);
  store.$update(ACTION_VIEWPORT_RESIZE, 300);
  store.$update(
    ACTION_ITEM_RESIZE,
    keys.map((_, i) => [i, 100] as const)
  );
  store.$update(ACTION_SCROLL, 200);
  store._flushJump();
  return { layout, store };
}

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

describe('keyed list store', () => {
  it('keeps the item at the viewport start in place when items are inserted above it', () => {
    const { store } = scrolledToC();
    store.$update(ACTION_ITEMS_KEYS_CHANGE, keysOf('a', 'x', 'y', 'b', 'c', 'd', 'e'));
    // Two 100px items were inserted above "c": the viewport moves down with it.
    expect(store._flushJump()[0]).toBe(200);
    expect(store.$getItemOffset(4)).toBe(400);
  });

  it('moves nothing when items are inserted below the viewport', () => {
    const { store } = scrolledToC();
    store.$update(ACTION_ITEMS_KEYS_CHANGE, keysOf('a', 'b', 'c', 'd', 'e', 'z'));
    expect(store._flushJump()[0]).toBe(0);
  });

  it('anchors on the next visible item when the first one is removed', () => {
    const { store } = scrolledToC();
    // "c" (at the viewport start) and "a" go; "d" was 100px into the viewport.
    store.$update(ACTION_ITEMS_KEYS_CHANGE, keysOf('b', 'd', 'e'));
    // "d" is now at offset 100; keeping it 100px below the viewport start puts the start at 0.
    expect(store._flushJump()[0]).toBe(-200);
  });

  it('ignores a render whose keys did not change', () => {
    const { store } = scrolledToC();
    const version = store.$getStateVersion();
    store.$update(ACTION_ITEMS_KEYS_CHANGE, keysOf('a', 'b', 'c', 'd', 'e'));
    expect(store.$getStateVersion()).toBe(version);
    expect(store._flushJump()[0]).toBe(0);
  });
});
