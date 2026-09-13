# Hide departing intro copy without animation

Status: implemented
Translation: current

[中文](2026-09-09-onboarding-reduced-motion-copy.zh.md)

## Abstract

Reduced motion disables the onboarding intro's exit animation, leaving the
previous headline and description visible over the final beat. The departing
copy now has an explicit zero-opacity resting state. Normal CSS animations
override that state during the crossfade, so the existing timing is preserved.
This fixes the rendering defect reported in [issue 207](https://github.com/LodyAI/Lody/issues/207)
without changing the ceremony lifecycle.

## Decision

`intro-sequence.tsx` owns both the exit animation and the reduced-motion override.
Attach a dedicated class to the outgoing layer and declare its resting opacity
beside the keyframes. Keep `aria-hidden` and the incoming layer unchanged.

Keeping an almost-zero animation duration was considered in the issue, but
an explicit resting state also works when the animation does not run at all.
No timers, animation-end cleanup, dependencies, or state transitions are added.
The separate stage-departure transform remains outside this issue's scope.

## Evidence and limits

Chromium rendered the real component and illustrations from base `158030ea`
plus this fix, using an isolated Vite harness with host utilities stubbed and
existing local dependencies. Playwright controlled the clock at each beat.
At 1180 x 620 and 390 x 844, all three transitions produced outgoing opacity
zero and incoming opacity one in both reduced and normal motion. Normal
animation samples at 0, 160, and 320 milliseconds retained the crossfade.
Skipping the intro and the setup callback also passed.

Removing only the new CSS declaration reproduced outgoing opacity one and
the overlapping final copy. Before/after screenshots were visually inspected.
This was renderer-only verification, not a packaged Electron test.

The changed TSX passes Prettier and Oxlint. Full `pnpm check` and `pnpm format`
were attempted but stopped because the isolated worktree lacks the complete
workspace dependencies and initialized adapter submodules. No full-suite
success is claimed; the browser harness is local verification, not a new
committed regression suite.
