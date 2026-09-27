# @lody/virtua

Lody's fork of [Virtua](https://github.com/inokawa/virtua), the React list virtualizer
behind the conversation view. Base: upstream tag `0.52.7`
(commit `97d0eb2`), MIT licensed (see `LICENSE`).

## Why a fork

Virtua keeps item sizes in an array by index. A conversation hydrates older turns while
the reader scrolls up: a placeholder item becomes several items above the viewport. With
index-keyed sizes, every later size then belongs to the wrong item, and nothing keeps the
reader's item in place (`shift` only covers items added at the start), so the content
under the reader jumped by the inserted height (up to ~900px measured). Virtua 0.52 also
fixed stacked jump compensations by applying them relatively (upstream #898), which a
patch to 0.49 had to work around.

## Changes from upstream

Each is marked with a `Lody:` comment.

- `Virtualizer` prop `keyed`: items are identified by their React `key`
  (`src/react/Virtualizer.tsx`, `src/react/useChildren.ts`).
- Keyed list layout: sizes remembered by key, including keys no longer listed;
  `$setKeys` remaps sizes when the list changes (`src/core/layouts/list.ts`).
- `CacheSnapshot` carries keys; a keyed snapshot restores by key regardless of the item
  count (`src/core/types.ts`, `src/core/layouts/list.ts`).
- Store action `ACTION_ITEMS_KEYS_CHANGE`: before the change it records the first visible
  item (and the ones after it, in case it is removed) with the viewport's offset into it;
  after the change it applies the jump that puts that item back (`src/core/store.ts`).
- Package entry exports `ItemKey`.

## Syncing upstream

1. Diff upstream `src/core` and `src/react` between `0.52.7` and the new tag.
2. Apply that diff here; resolve conflicts around the `Lody:` markers.
3. Run `pnpm --filter @lody/virtua test` (upstream core specs plus `tests/`), then the
   components suite, and update the base version above and in `package.json`.
