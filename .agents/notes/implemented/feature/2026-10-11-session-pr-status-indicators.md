# Session Pull Request status indicators

Status: implemented
Translation: current

[中文](2026-10-11-session-pr-status-indicators.zh.md)

## Abstract

Sidebar session rows and the composer info bar previously lacked glanceable PR status visibility, relegating the PR icon to a 12px trailing mark that disappeared whenever a session was active or unread. Top-level sidebar rows now display the PR status icon directly in the leading slot at rest, fading to the actions menu on hover, with a subtitle displaying `#<number> · <Status>` in the status tone. Above the composer, the info bar displays a prominent status-tinted pill badge with the PR number, status word, and CI verdict, and reflects status color in the collapsed cluster chip. Nested child sessions and openers retain hierarchy controls in the leading slot and fall back to the trailing PR mark.

## Decision

The leading slot (`SessionRowLeadingSlot`) hosts the PR status icon (`SessionPrIcon`) for standalone top-level session rows at rest. On row hover or keyboard focus, the PR icon smoothly fades out via `transition-opacity` while `MoreHorizontal` (`⋯`) fades in at the exact same 7px center, preserving flat-list alignment and preventing layout shifts. Opener disclosure buttons and child tree connectors (`├` / `└`) take precedence in the leading slot; nested child sessions and openers fall back to rendering `SessionPrIcon` in the trailing end slot (`SidebarRowEndSlot`). Standalone rows suppress the trailing PR icon to avoid duplicate indicators on a single row.

Session rows carrying an associated pull request display a subtitle row with `#<number> · <Status>` using the shared per-status colors defined in `PR_STATUS_META` (`text-github-open`, `text-pr-merged`, `text-github-closed`, `text-github-draft`). In Updated mode, `UpdatedItemProjectLine` appends the same PR number and status label alongside the repository label.

Above the chat composer, `ContextChip` promotes the PR button from an unstyled muted text element to a status-tinted pill badge (`bg-foreground/[0.06]` with status text color and subtle hover highlight), displaying `#<number>` and the localized status label on screens 480px and wider. In cluster mode, the collapsed chip renders the colored `StatusIcon` so users can glance PR status even when the stage is focused on Goal or Schedule.

## Verification

- `packages/components/tests/session-list-pr-badge.test.ts`: Added tests verifying that standalone rows render `SessionPrIcon` in `[data-session-leading-pr]`, deduplicate the trailing slot, display `#<number> · <Status>` in the subtitle, render purple `GitMerge` with `text-pr-merged` for merged PRs, and retain tree connectors in the leading slot while keeping the trailing PR mark for child sessions.
- `packages/components/tests/session-info-context-actions.test.tsx`: Added tests verifying that `ContextChip` renders the status-tinted PR badge on the stage with status text and applies status color to the cluster chip.
- Ran Vitest suites: all 29 tests in `session-list-pr-badge.test.ts` and all 7 tests in `session-info-context-actions.test.tsx` pass.
