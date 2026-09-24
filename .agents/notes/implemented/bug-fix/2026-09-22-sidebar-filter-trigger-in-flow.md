# Sidebar filter trigger renders in-flow, not as a measured overlay

Status: implemented
Translation: current

[中文](2026-09-22-sidebar-filter-trigger-in-flow.zh.md)

## Abstract

The desktop sidebar filter trigger was a single absolutely-positioned
`SidebarFilterPopover` overlaid on whichever section header rendered first,
with invisible placeholder spans reserving space. Its alignment depended on
three unstated constants (the `h-7` header row, the `pt-1` wrapper offset, and
the placeholder box) staying in sync, and they had silently drifted: the glyph
sat 4px above the header centerline and 6px off its reserved slot. The trigger
now renders in-flow inside the first header's `action` slot, so the row's
flexbox guarantees alignment with no pixel contract. The popover's `open`
state moved to `loro-app-sidebar`, the common ancestor of every candidate
slot, so remounting the single instance at a new slot no longer closes it —
this replaces the overlay's original reason to exist.

## Decision

`loro-app-sidebar` creates one `SidebarFilterPopover` element with controlled
`open`/`onOpenChange` and renders it in the first local-project section
header (or the GitHub Worktrees / Chats headers when those are first). When a
filter removes every Workspace section, `topContent` stays absent so the empty
main `SessionList` owns the same in-flow trigger and users can switch back to
All Tasks. That filtered-empty state also explains why the list is empty and
offers a direct “Show all tasks” recovery action. After switching, a genuinely
empty All Tasks workspace renders its own neutral “No tasks yet” state without
the recovery action, rather than repeating filter-specific copy. Both states use
a compact icon, title, and supporting line sized for the sidebar. If Chats remains as the only
section, its after-list content owns the trigger and `LoroSidebar` suppresses the
empty main-list fallback, preserving exactly one mount. The same element passes to
`LoroSidebar` as `desktopFilterAction` (renamed from `desktopFilterPlaceholder`)
for the slots LoroSidebar owns — the Pinned and Updated list headers. Gating
stays mutually exclusive, so exactly one mount point exists per render.
`LoroSidebar` keeps a local uncontrolled fallback for direct consumers that do
not pass the prop (stories). The overlay wrapper and both placeholder sizes are
deleted. `SidebarFilterPopover` accepts optional controlled `open` props and
otherwise keeps its internal state, so the mobile footer instance is unchanged.

Every header action render site insets the action `mr-2`/`pr-2` — the
`SidebarSectionHeader` wrapper, the session-list group header, and the
standalone `justify-end` action rows (loading/empty fallbacks in SessionList
and `HeaderActionRow` in the updated list). This preserves the overlay's
`right-2` geometry in-flow: the trigger's right edge lands on the content-box
right edge that the `px-2` session rows establish, centering its glyph on the
rows' status column (unread dot axis at cx 295 vs trigger cx 296, matching the
old overlay's 1px offset). Without it the trigger sat flush to the row edge,
8px right of that column — the inset is a property of the header row, not of
the action element, so it holds for any action content.

Lifting `open` is the correct owner rather than gratuitous lifting: the
trigger's position is owned by sidebar layout above every candidate slot, and
the popover's other state (organize mode, task scope, labels, change handlers)
already lived there — `open` was the only uncontrolled remainder. Alternatives
considered: measuring the placeholder's DOM rect to drive the overlay (keeps
state internal but adds a ResizeObserver and preserves two sources of truth),
and Radix `Popover.Anchor` with a `virtualRef` (similar plumbing weight). Both
retain a visual dependency without a layout dependency, which is what produced
this bug.

## Verification

In the `Components/LodySidebar` storybook story, which mirrors the production
topContent composition, the Local Projects header measures label, import
button, and filter trigger all centered at the row's centerline (centerY 278px
on the 28px row), the trigger centered 1px off the session rows' status column
(cx 296 vs 295 — the same offset the old `right-2` overlay produced), and the
popover opens anchored to the trigger. `tsgo --noEmit` and `oxlint` pass on the
changed files. Behavior when the first section changes while the popover is
open (e.g. a pinned session appearing via sync) is covered by the lifted
controlled state but was verified only by reasoning, not by a live app run.
The `Workspace · filtered empty` and `Workspace · empty` stories verify the two
empty-state variants and the former's recovery action switches to the latter.

## Integration

- [Lody PR #884](https://github.com/LodyAI/Lody/pull/884)
- [Lody PR #887](https://github.com/LodyAI/Lody/pull/887)
