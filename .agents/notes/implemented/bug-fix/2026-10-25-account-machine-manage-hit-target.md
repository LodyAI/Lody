# Keep Account machine management outside the native back-swipe strip

Status: implemented
Translation: current

[中文](2026-10-25-account-machine-manage-hit-target.zh.md)

## Abstract

On a narrow native shell, tapping the center of Account's machine Manage button could leave the page unchanged. The shared drill layout's transparent 48px edge-back strip covered the button, while ordinary web mode omitted the strip. The action now sits at the trailing edge of its existing row, preserving the gesture area and navigation callback. Browser coverage uses synthetic data and the shared native-shell flag; it does not establish acceptance in the private iOS shell.

## Finding and decision

[Issue #1864](https://github.com/LodyAI/Lody/issues/1864) tracks the public component defect. At 393×852 in Chinese, the original button occupied x=16..61.74, placing its center at x=38.87 under `MobileEdgeBackSwipeZone`. Hit-testing returned the transparent overlay; a center click stayed on Account, while the uncovered right edge opened details. The existing callback-only test bypassed browser hit-testing.

`AccountMachinesOverviewView` owns the action's placement. A flex wrapper with an automatic inline-start margin keeps it at the trailing edge when `CompactRow` stacks its controls; wide rows already align controls there. No machine data, permissions, RPC, or route contracts change. Moving this one action avoids shrinking the gesture strip or introducing a global stacking change across settings and animated scroll containers. Other left-edge controls remain outside this focused fix.

## Verification and limits

The new native-shell Storybook fixture composes the real account machine overview, settings layout and machine detail pane with a synthetic machine. The browser regression checks that the entire Manage button clears the strip, that the strip still receives touches elsewhere, and that tapping Manage and Back changes the visible surface, and a native edge swipe still returns from details. Both Chinese and English cases failed on the original x=16 placement and passed with trailing alignment. Existing account overview and machine detail unit suites passed (10 tests). Physical iPhone acceptance and the separately observed remote resource-sampling wait are not covered by this fix.

`pnpm format` and `pnpm docs check` passed (73 existing documentation warnings, none added). Repository typechecking and static lint passed. `pnpm check` stopped on five CLI test failures: a local session-directory `ENOTDIR`, macOS temporary-path canonicalization, two submodule identity checks, and a concurrent-worktree timeout. These failures are outside the changed UI; the remaining aggregate gates did not complete.
