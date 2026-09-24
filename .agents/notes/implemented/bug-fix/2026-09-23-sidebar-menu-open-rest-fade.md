# Hide resting row icons while a sidebar context menu is open

Status: implemented
Translation: current

[中文](2026-09-23-sidebar-menu-open-rest-fade.zh.md)

PR: [#919](https://github.com/LodyAI/Lody/pull/919)

## Abstract

Opening a sidebar row's context menu left the row's resting icons visible on top
of the revealed controls: the tree connector drew through the `⋯` trigger and the
status or worktree glyph bled into the Archive button. The reveal layer already
stayed visible via `data-menu-open`, but the resting layer only hid on
`:hover` — and the pointer leaves the row as soon as the portaled menu opens, so
the rest icons faded back in underneath the still-visible controls. The fade
class names now carry the same `group-data-[menu-open]` condition as the reveal
side, so one layer is visible at a time regardless of pointer position. Verified
in Storybook with DOM opacity reads and before/after captures; rows that never
set `data-menu-open` are unaffected.

## Cause and ownership

`SessionRowLeadingSlot` and `SidebarRowEndSlot` paint two stacked layers in the
same 7px-centre/end-slot geometry (see the
[session tree doc](../../../docs/components-sidebar-session-tree.md)): a resting
layer (tree connector, disclosure, worktree glyph, status cluster) and a reveal
layer (`⋯` trigger, Archive action). The contract is that exactly one layer is
painted at a time. The reveal side encoded "hover OR menu open"
(`group-hover/row:opacity-100 group-data-[menu-open]/row:opacity-100`), but the
rest side only encoded "hidden on hover" (`group-hover/row:opacity-0`).

Context menus render through a portal. The moment the menu opens, the pointer is
over menu content outside the row, so the row's `:hover` is gone while
`data-menu-open` remains set. Reveal stayed at opacity 1, rest returned to
opacity 1, and both layers overlapped for as long as the menu stayed open.

The fix adds the menu-open variant to the resting side rather than touching the
reveal side or menu z-index: `group-data-[menu-open]/row:opacity-0` (and
`pointer-events-none` where the rest layer is interactive) on the leading and
trailing `fadeClassName`s in `sidebar-updated-session-list.tsx` and
`sidebar-updated-task-list.tsx`, plus `group-data-[menu-open]:opacity-0` on
`SidebarRowEndSlot`'s default fade class in `sidebar-row-shared.tsx`, which also
repairs `loro-app-sidebar.tsx` rows that use the default. The alternative —
keying rest opacity off menu-open only — was rejected because hover must still
hide rest icons while the pointer is on the row before any menu exists; the two
conditions are independent and both are required.

## Evidence and limits

- Reproduced in the `Updated Mode · Opened Sessions` Storybook story on a nested
  child row. With the menu open and the pointer over it, computed opacity before
  the fix was 1 for both the tree connector and the `⋯` trigger, and 1 for both
  the working spinner and the Archive button. After the fix the resting layer
  reads 0 while the reveal layer stays 1.
- Before/after captures: `.lody/attachments/menu-open-before.png`,
  `menu-open-after.png`, and `menu-open-before-after.png`.
- `pnpm --filter @lody/components typecheck` passes; the change is class-string
  only. `session-list.tsx` and `task-list.tsx` rows never set `data-menu-open`,
  so the added variants are inert there.
- The pre-existing `@lody/components` suite has unrelated jsdom-environment
  failures (`localStorage` undefined, theme/publication fixtures); every sidebar
  row, updated-list, and worktree suite passes.
