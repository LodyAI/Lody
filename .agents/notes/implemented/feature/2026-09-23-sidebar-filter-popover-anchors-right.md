# Sidebar filter popover anchors to the right of the sidebar

Status: implemented
Translation: current

[中文](2026-09-23-sidebar-filter-popover-anchors-right.zh.md)

## Abstract

The desktop sidebar filter popover opened below its in-flow section-header
trigger (`side="bottom" align="end"`), so it covered the session list it
controls. It now opens as a flyout to the right (`side="right" align="start"`),
landing in the content pane beside the sidebar with its top edge level with the
trigger row. The mobile footer instance keeps the default top-start anchoring.

## Decision

`SidebarFilterPopover` already exposes `side`/`align`, so the change is confined
to the three desktop render sites: the owned element in `loro-app-sidebar`,
`LoroSidebar`'s uncontrolled fallback for direct consumers (stories), and the
`LoroSidebar` story that mirrors the production composition. `align="start"`
keeps the menu's top edge at the trigger's top edge, reading as a flyout beside
the header rather than a floating panel centered on the button. Radix collision
handling still flips the popover if a narrow window leaves no room to the right,
so no fallback logic was added. The mobile footer instance is untouched: its
trigger sits in the bottom bar, where the default top anchoring remains correct.

## Verification

Verified live in Storybook: with the `Components/LodySidebar` Default story
(production-mirroring `WithProjectsLayout`), the popover previously opened
downward over the session list; after the change it opens to the right of the
sidebar with its top edge level with the Local Projects header, leaving the
list uncovered. The new values stay inside the existing prop union types and
`oxfmt --check` passes on the changed files. This nested worktree has no
installed dependencies (nested checkouts skip `pnpm install`), so a full
`tsgo`/`vitest` run was not possible here.
