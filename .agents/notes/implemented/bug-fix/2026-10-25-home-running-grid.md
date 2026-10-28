# Home running marks match the sidebar

Status: implemented
Translation: current

[中文](2026-10-25-home-running-grid.zh.md)

PR: [#1883](https://github.com/LodyAI/Lody/pull/1883)

## Abstract

The home dashboard used single accent dots for running sessions while the sidebar
used an animated tile grid. The Now summary and running rows now reuse the same
`WorkingGrid`, preserving their existing 14px icon slots. This adds the sidebar's
motion to the dashboard without introducing another animation system or changing
session classification. A zero running count uses a muted static grid; reduced
motion also keeps active grids static.

## Decision and evidence

[`now-board.tsx`](../../../../packages/components/src/components/chat/home/now-board.tsx)
centres the default 12px grid in the existing slot and applies the home accent
colour. Both the summary and session rows use one local wrapper; expanded lists
reuse the same row renderer. A zero running count uses the secondary label colour
inside the existing faded summary, with scaling and opacity animation disabled.
Changing back to a positive count restores the shared animation and accent colour.
When all three summary counts are zero, the existing quiet phrase still applies.
The grid owns visibility observation, the shared animation clock, and reduced
motion, as described in the [original grid decision](../feature/2026-09-24-sidebar-working-grid.md).
This replaces the home dashboard's single-dot presentation from the
[home decision](../feature/2026-10-16-home-week-tiles.md).

## Verification

Playwright captures the full workspace preview before and after with identical
synthetic story data, a dark theme, and a 1600×1000 viewport at 2× scale. These
captures cover production sidebar, home, and composer components, rather than a
packaged Electron session. The existing dashboard transition test finishes only
finite animations so continuous working grids cannot prevent transition checks.

The 21 dashboard component tests, package typecheck, and targeted lint pass.
Browser checks verify the 12px grid's 1px inset, all six expanded running rows,
and a static grid under reduced motion, with no page errors. Two existing
transition layout assertions fail identically with the original and changed
renderer; the other two browser tests pass. Repository documentation checks
report 84 existing errors and no errors for this note. Validation used the
installed Node 26.11.1, below the repository's required runtime floor. Root
`pnpm format` passes; `pnpm check` stops in CLI typechecking because the ACP
extension submodule manifests and Claude module are absent from this checkout.

The workspace story exposes running and completed fixture states. A Playwright
recording shows the whole workspace, the expanded running list, a zero running
count, and resumed work. Browser assertions confirm nine muted static tiles at
zero and active animation after resuming, without page errors.
