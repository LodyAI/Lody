# Start with sidebar branch details hidden

Status: implemented
Translation: current

[中文](2026-10-19-sidebar-branch-details-off-by-default.zh.md)

## Abstract

The sidebar's `Show Branch` preference started enabled to preserve the original Workspace row layout. New or unset preferences now start disabled so branch metadata does not add a second line before the user opts in. Explicitly saved choices remain intact. In Workspace mode, the preference also hides relative time because it shares the same secondary line with the branch.

## Decision

- `sidebarShowBranchNamesAtom` keeps its storage key and changes its default to `false`.
- Direct `LoroSidebar` and `SidebarFilterPopover` defaults and their Storybook examples also start with branch details hidden.
- Stored `true` or `false` values are not migrated or overwritten; this change applies when no explicit preference exists.
- The preference continues to control the branch segment in Updated mode and the combined branch/time line in Workspace mode.

This supersedes the `default: true` choice in the [sidebar row details note](2026-10-18-sidebar-row-details-group.md); the earlier rationale and behavior history remain useful.

## Evidence

- The persisted preference is `sidebarShowBranchNamesAtom` in `packages/components/src/atoms/sidebar-state.ts`.
- `LoroAppSidebar` reads it for both Workspace and Updated rows and passes it to the Details switch.

## Verification and limits

- Formatting and `git diff --check` pass.
- `oxlint` on the implementation, tests, and `SidebarFilterPopover` story passes with 21 unrelated warnings. Including `LoroSidebar.stories.tsx` reports an unrelated hook-dependency error at line 1144.
- Tests were not run. The component typecheck still reports errors in `loro-sidebar.tsx` and `home-week-usage.ts` outside this preference change.
- Documentation checks still report broken `subagent-events` links and oversized `AGENTS.md` files elsewhere in the worktree.
