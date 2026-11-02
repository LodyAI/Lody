# Session Pull Request status indicators

Status: implemented
Translation: current

[中文](2026-10-11-session-pr-status-indicators.zh.md)

## Abstract

Sidebar session rows and the composer info bar previously lacked glanceable PR status visibility, relegating the PR state to hover cards or buried deep in session details. Two-line sidebar rows now display the PR state (`#<number> · <Status>`) directly within the second metadata line alongside the branch name and relative timestamp, while the trailing status slot preserves the compact PR icon with CI verdict cutouts. Above the composer, the info bar displays a prominent status-tinted pill badge with the PR number, status word, and CI verdict, and reflects status color in the collapsed cluster chip. The leading slot maintains existing flat-list alignment and tree hierarchy representation across all session rows.

## Decision

The sidebar session row places PR state on the second metadata line (`SidebarSessionMetaLine`) below the session title: `{[Branch Icon] scope/branch-name} {10m} {PR state}`. The PR segment (`SidebarPrSegment`) formats `#<number> · <Status>` using the shared per-status colors defined in `PR_STATUS_META` (`text-github-open`, `text-pr-merged`, `text-github-closed`, `text-github-draft`). In Updated mode, `UpdatedItemProjectLine` appends the same PR segment alongside the project label.

The leading slot (`SessionRowLeadingSlot`) strictly preserves existing identity and hierarchy representation: opener chevrons, child tree connectors (`├` / `└`), and an empty 14px slot at rest for standalone rows that reveals `MoreHorizontal` (`⋯`) on hover. At the right edge, the trailing slot (`SidebarRowEndSlot`) continues to display the compact `SessionPrIcon` with circular CI verdict cutouts at rest, yielding to live working, waiting, and unread marks.

Above the chat composer, `ContextChip` promotes the PR control from an unstyled muted text element to a status-tinted pill badge (`bg-foreground/[0.06]` with status text color and subtle hover highlight), displaying `#<number>` and the localized status label on screens 480px and wider. In cluster mode, the collapsed chip renders the colored `StatusIcon` so users can glance PR status even when the stage is focused on Goal or Schedule.

## Verification

- `packages/components/tests/session-list-pr-badge.test.ts`: Verifies that `SidebarSessionMetaLine` formats the branch, timestamp, and PR state with status tinting; confirms standalone and opener rows maintain pure hierarchy in the leading slot; verifies the trailing slot displays `SessionPrIcon` with CI verdict masks at rest; and asserts that merged PRs render purple `GitMerge` with `text-pr-merged`.
- `packages/components/tests/session-info-context-actions.test.tsx`: Verifies that `ContextChip` renders the status-tinted PR badge on the stage with status text and applies status color to the cluster chip.
