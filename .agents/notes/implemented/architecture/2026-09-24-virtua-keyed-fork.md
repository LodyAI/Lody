# Fork Virtua with keyed rows

Status: implemented
Translation: current

[中文](2026-09-24-virtua-keyed-fork.zh.md)

## Abstract

Scrolling up a long conversation moved what the reader was looking at by hundreds of pixels
at a time. The conversation hydrates older turns as the reader approaches them, so a
placeholder row above the viewport becomes several rows, and Virtua keeps item sizes in an
array by index and only compensates insertions at the start of the list. Lody now carries a
fork of Virtua 0.52.7 (`packages/virtua`, `@lody/virtua`) whose `keyed` lists keep sizes
with React keys, restore snapshots by key, and keep the item at the viewport start in place
whenever the list changes. On the same 100-row conversation and input, visible jumps fell
from 1,370px (earlier this branch) and 294-318px (after the interim fixes) to none; the
fork must now be synced with upstream by hand.

## Problem

Measurements (per-frame row positions, scroll writes with callers, row resizes, real wheel
input, local production build; details in the
[follow-modes note](2026-09-23-conversation-follow-modes.md#reading-position-while-rows-change-above)):

- Placeholder expansion above the reader: 314px and 902px jumps. With `shift={false}` the
  pixel offset is kept, so different rows appear under the reader; with index-keyed sizes
  every later size then belongs to the wrong row until it is measured again.
- Rows inserted inside the viewport were measured only after insertion (estimated size,
  then real size): −88/+128px pairs.
- Stacked compensations in one frame erased each other in 0.49 (fixed upstream in 0.52 by
  applying them with `scrollBy`, upstream #898).

Upstream 0.52.7 still keys sizes by index (`fill` only appends or prepends) and `shift`
only covers the start of the list.

## Decision

Vendor `src/core` and `src/react` from tag `0.52.7` and add, marked `Lody:`:

- `Virtualizer` prop `keyed`: items are identified by their React key.
- The list layout remembers every measured size by key, including keys no longer listed,
  and remaps sizes when the keys change; `CacheSnapshot` carries keys and restores by key
  whatever the item count.
- Store action `ACTION_ITEMS_KEYS_CHANGE` records the first visible item (and the next
  visible ones, in case it is removed) with the viewport's offset into it, and applies the
  jump that puts it back, before paint.

The conversation list sets `keyed`; the two non-message rows get fixed keys. The
hook-level reading anchor added earlier on this branch is removed, so Virtua is the only
writer for list changes. The snapshot cache keeps keyed snapshots across row-count changes.

## Alternatives

- Keep patching the published build: the index-keyed cache is structural, not a line fix.
- TanStack Virtual (keyed size cache, customizable compensation): a large migration
  (selection `keepMounted`, snapshot cache, outline math) and it does not anchor mid-list
  insertions either.
- One Virtua item per turn: insertions disappear, but long turns become one huge item,
  against the row-per-part design.
- A second scroll writer in the sticky-scroll hook (tried first): it can undo a
  programmatic jump whose scroll event has not arrived yet.

## Verification and limits

- `@lody/virtua`: upstream core specs (237) plus keyed layout, store and React tests;
  the React test fails without `keyed` (viewport stays at 500 instead of 700).
- Components suite passes. Local production build: two climbs through a 100-row
  conversation and the near-bottom oscillation show no visible jumps; switching away and
  back restores the same row at the same offset.
- Upstream's jsdom snapshot suites (real sleeps) and browser suites are not carried; `src/`
  is excluded from repository lint to stay close to upstream.
- A jump the fork cannot see: Streamdown gives every code block an inline
  `content-visibility: auto` with a 200px placeholder, so a block rendering for the first
  time changed its row's height from inside (a one-line block shrank ~158px), and when that
  row straddled the viewport top nothing compensated. Climbing a conversation with code
  blocks: 2 jumps of 158px on each of two runs. The markdown renderer now forces those blocks
  to `content-visibility: visible` (the rows are already virtualized): 0 jumps on two runs,
  and switching away and back restored the same row at the same offset.
- Syncing with upstream is manual (`packages/virtua/README.md`).
- Rows never measured before still start at the estimated size; only rows seen before in
  the session start at their real size. Sizes live in memory for the page's life.
