# Sidebar row detail segments share one Details group

Status: implemented
Translation: current

[中文](2026-10-18-sidebar-row-details-group.zh.md)

## Abstract

Updated rows had a lone `Show Project` switch detached at the popover's bottom, permanently disabled outside Updated view, while Workspace rows gained an untoggleable branch/time line that some users want to hide — and appending a second bare switch would have looked like stray accumulation rather than structure. The popover now closes with a `Details` group holding one switch per second-line segment (`Show Project`, `Show Branch`), both interactive in every organize mode, and rows compose whichever segments they carry into one meta line. The trade-off: the branch switch governs the whole Workspace branch+time line, so both switches off collapses every two-line row to a single line, and Updated repo rows gain the branch segment on the default path.

## Decision

The second line is treated as one meta line whose content is a user choice, not a per-view constant. Two persisted preferences control its segments:

- `sidebarUpdatedShowProjectNamesAtom` (existing, unchanged key `lody-sidebar-updated-show-project-names`) gates the project segment: folder/local name or the muted GitHub owner mark + repo name, rendered in Updated mode top-level rows.
- `sidebarShowBranchNamesAtom` (new, `lody-sidebar-show-branch-names`, default `true` to preserve the Workspace behavior) gates the branch segment: the GitBranch mark + truncating branch name, shown wherever a top-level row carries a branch — Workspace GitHub rows, local worktree rows, and Updated repo rows (which previously exposed the branch only in the hover card).

`SidebarBranchSegment` in `sidebar-row-shared.tsx` renders the segment; `SidebarSessionMetaLine` reuses it for Workspace rows, and Updated rows compose project + branch segments into the same `[data-sidebar-session-meta]` container. Row height follows the composed line: any segment makes the row tall, both off keeps it snug. Nested opened children stay single-line in every state, and a child's tall connector (`tallOpener`, `followsTallOpener`) now consults the branch preference so tree geometry matches whether the opener actually renders the line. Mobile rows are unchanged (time rides the right edge; no second line).

The popover lists the two switches under a `Details` heading with the same row geometry as the radio options. Switches describe persistent content, not the open organize mode, so neither row is ever disabled; the disabled-row + touch-hint + right-side tooltip machinery is deleted, and the `updatedProjectNamesUnavailable` label key is removed from both locales. Toggling keeps the menu open. New i18n keys: `sidebar.filter.detailsHeading`, `sidebar.filter.showBranchNames`. A pref change reports `settings/changed` with key `sidebar_show_branch_names`.

## Alternatives and trade-offs

Merging everything into one "detail line" switch (the cheapest diff) was rejected because it destroyed per-segment customization — users could no longer keep the project line while dropping the branch line. Keeping two switches bound to specific views was rejected precisely for the append look this change fixes: each switch stayed disabled half the time and implied a view relation the menu never showed. The segment-composition model spared the I-don't-want-two-lines user (both off) and the density-first user (both on) with the same control surface. The cost is that "Show Branch" also removes the trailing relative time on Workspace rows when off, and the branch switch cannot apply selectively per view.

## Verification

`sidebar-filter-popover.test.tsx` covers the `view`/`tasks`/`details` section order, both switches staying enabled in Project mode, independent callbacks, and open-on-toggle. `sidebar-updated-project-context.test.tsx` covers the appended branch segment, chat rows without a branch, nested children, and the preference-off collapse. `session-list-opened-by.test.ts` covers the Workspace branch/time line under both preference states. The component `tsgo` typecheck reports only the two pre-existing errors outside this change (`loro-sidebar.tsx` stylex props, `home-week-usage.ts` modelId), and targeted suites pass. A full component run shows six failures elsewhere in the working tree (PR badge tones, boot-shell storage fallback, access control copy, pending-message cards, sidebar width) that this change does not touch. Story review: `Sidebar/SidebarFilterPopover` stories show both switch states; the Updated Mode overview story remains the visual harness.

Related:
[project context](2026-09-20-sidebar-updated-project-context.md),
[display preference](2026-09-20-sidebar-updated-project-display-preference.md)
(this note supersedes its bottom-switch and disabled-tooltip decisions),
[local repo session row height](../bug-fix/2026-10-18-local-repo-session-row-height.md).
