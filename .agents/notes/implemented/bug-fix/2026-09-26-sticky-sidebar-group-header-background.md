# Sticky sidebar group headers need `bg-sidebar`, not `bg-sidebar-background`

Status: implemented
Translation: current

[中文](2026-09-26-sticky-sidebar-group-header-background.zh.md)

## Abstract

Scrolling a long project list let a selected row's frame paint through the
machine-name header: the sticky wrappers used `bg-sidebar-background`, which
Tailwind never generates (`colors.sidebar` only defines `DEFAULT`, reached by
`bg-sidebar`), so the header computed `rgba(0,0,0,0)`. Both sticky group
headers — machine sections in `loro-app-sidebar.tsx` and the Chats/repo group
label in `session-list.tsx` — now share `SIDEBAR_STICKY_GROUP_HEADER_CLASS`
(`sticky top-0 z-10 bg-sidebar`) from `sidebar-row-shared.tsx`, which makes the
header opaque and keeps the two call sites from diverging again. A Storybook
story (`MachineGroupStickyHeader` in `LoroSidebar.stories.tsx`) reproduces the
production section DOM in a scrollable box as regression coverage.

## Decision and evidence

The defect came with the group-label rework
([deep-sea palette](../feature/2026-09-25-deep-sea-palette-and-sidebar-groups.md)):
`sticky top-0 z-10 bg-sidebar-background` looks like the sidebar surface
utility, but the theme key for `--sidebar-background` is `sidebar.DEFAULT`, so
`bg-sidebar-background` resolves to nothing and the header stayed transparent.
`getComputedStyle` on the rendered header returned `rgba(0, 0, 0, 0)` before the
change and `rgb(25, 26, 29)` after; a selected project row (`bg-sidebar-selection`
+ `border-sidebar-ring/30`) visibly overlapped the machine label before, and
slides beneath it after.

The non-obvious constraint: Tailwind silently ignores class names that do not
match a theme key, so a plausible-looking surface utility can ship transparent.
Keeping the wrapper in one shared constant means future group headers cannot
re-type the losing spelling.

## Verification and limit

Storybook (dark theme): with the list scrolled, the selected first project's
frame overlapped `LAPTOP-PP66IJ89` before and now paints underneath an opaque
header; only the `space-y-0.5` seam below the label can still show a 2px slice
of the row, matching the other sticky groups. Components typecheck, sidebar
tests, oxfmt and `lint:fast` pass. Verified in the browser fixture only; a
Windows desktop session was not run, but the cause is CSS resolution and is
platform-independent.
