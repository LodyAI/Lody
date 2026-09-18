# Virtualize the archive page list across grouped and flat views

Status: implemented
Translation: current

[中文](2026-09-18-archive-list-virtualization.zh.md)

## Abstract

The archive page mounted every group header and session row in both desktop and
mobile chrome, so a long archive froze on open. Visible rows are now flattened
(project headers plus opened-by sessions, or a headerless flat list) and
virtualized with `@tanstack/react-virtual` once they exceed the same visible-row
threshold the file tree uses. The list owns its scrollport; search/group/sort
stay pinned. A jsdom comparison renders the same 200-session grouped fixture
statically and virtually and asserts the virtual path commits a viewport window
instead of the whole tree.

## Decision

One virtualizer over flattened visible rows, not one per group and not Virtua.
Collapsed groups contribute only their header, so folding a large project cannot
swap renderers. Desktop and mobile still use their existing row components;
grouping is a row-kind difference (`header` vs `session`), not a second list.
Keyboard navigation on the virtualized path walks the flattened index and
`scrollToIndex`s before focusing, because `FocusScope` can only see mounted
DOM. Below the threshold `ArchiveListWindow` maps the same flattened rows
without a spacer. `ArchivedSessionGroupSection` is only the Storybook wrapper.

Rejected: keeping `WebArchiveScreen` / `MobileArchiveScreen` as the scroll
parent (the file tree already hit the ancestor-ref empty-range bug); per-group
virtualizers (collapse, gaps, and cross-group keys fracture); using Virtua
(chat sticky-bottom, not a bounded session list).

## Verification and limits

`archive-list-virtualization.test.ts` pins flatten, collapse, flat mode, and
the visible-row gate. `archive-list-virtual-rows.test.tsx` installs a 400px
scrollport, renders 4×50 grouped sessions both with an infinite threshold
(previous static init) and with the production gate, and compares committed
`archive-session` / `archive-group` nodes plus total host nodes. The virtual
window must stay within viewport+overscan, keep the first project header, and
carry a spacer equal to the summed estimates. An unresolved 0-height
scrollport must mount no rows. Live swipe, long-press, and packaged-client
scrolling remain outside jsdom.

## Ablation

Dropped when the suite still passed: the extra `measure()` + ResizeObserver
pass copied from the file-tree ancestor-ref bug (this list owns its
scrollport); `useAnimationFrameWithResizeObserver`; unused `data-index` /
`data-archive-virtual-row`; exported header/session row aliases;
`ArchiveSessionList`'s unused `virtualizeThreshold` passthrough; duplicate
Mobile/Desktop mapping inside `ArchivedSessionGroupSection`; Profiler
`actualDuration` as a pass condition; a second test that only re-checked the
first header; `clientHeight` / `offsetWidth` / `ResizeObserver` jsdom stubs;
the `+2` ceiling fudge and the weaker "fewer than 1/4 sessions" bound.

Kept because removing them failed or would untest a product path: the
scrollport `offsetHeight` stub (without it the comparison sees zero virtual
rows); the empty-range case; collapsed groups omitting sessions from the
flatten count; local-header estimate; `getItemKey`; virtualized keyboard
`scrollToIndex` (no jsdom coverage, still required for FocusScope).
