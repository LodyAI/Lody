# Continuous mobile workspace dock motion

Status: implemented
Translation: current

[中文](2026-10-05-mobile-workspace-dock-motion.zh.md)

## Abstract

The mobile dock's overlapping shell and child layout animations visibly stretched
and displaced its selected icon. The accepted continuous-morph design keeps every
keyed tab mounted and coordinates actual dimensions, positions and fades through
one persistent spring. Downward scrolling minimizes the dock; upward scrolling
expands it on both list and imperative editor paths. Browser verification covers
rendered geometry and interaction; physical Android/WebView performance remains
unverified.

## Decision

Prototype D was accepted over a duplicated-icon size morph (B) and whole-panel
crossfade (C). A used overlapping layout projection, child exit scaling and abrupt
label/highlight removal. Earlier exploratory Chromium measurements found a nominal
24×24 selected SVG reaching about 88×22; changing easing alone could not fix it.

The production [dock](../../../../packages/components/src/components/mobile/mobile-workspace-tabbar.tsx)
uses a spring from expanded 0 to minimized 1 (420 stiffness, 40 damping, mass 1,
0.001 rest thresholds). Width/height change directly; no ancestor scale or shared
layout identity participates. Retargeting the spring preserves velocity. A stable
observed slot supplies width, and the optional action reserves 56px while its button
shrinks to 48px. Derived MotionValues avoid per-frame React geometry state.

```text
stable dock row
├─ observed flexible slot → dimension-changing shell → persistent keyed tabs
└─ optional fixed 56px slot → dimension-changing new-chat button
                      one spring drives both branches
```

Controls compose `@lody/ui` Buttons with motion render elements; StyleX and UI tokens
own layout and content styling. The selected icon stays opaque at 24×24. Other tabs
become inert immediately on collapse, and remain inert until visible on expansion.
Focus transfers before inert is applied because Chromium can otherwise clear it
before a layout effect. Missing selection keeps navigation expanded. Legacy
`layoutId` is accepted but unused, eliminating cross-instance collisions.

DOM and imperative scroll input share directional accumulation, resetting at each
reversal, source switch, top arrival or explicit expansion. An active imperative
signal owns the baseline even if a list remains mounted. See the
[behavior draft](../../../../specs/mobile-workspace-dock.md).

Apple's [scroll-minimizing tab bars](https://developer.apple.com/videos/play/wwdc2025/284/?time=151)
and [interrupted springs](https://developer.apple.com/videos/play/wwdc2023/10158/)
inform the interaction. This implementation uses web geometry, not native Liquid
Glass materials. The trade-off is bounded layout work on a few dock elements and
retaining hidden tabs, rather than transform scaling or duplicated selected content.

## Validation limits

Executed: 13 Chromium browser cases and 3 dock component tests pass, alongside
9 existing mobile-list tests; scoped lint, formatting and diff checks pass. Running
the geometry test against the original component fails at an 80.25px icon width
instead of 24px. Docs check reports 62 broken links into absent ACP submodules,
with no errors in the changed documents and no registered SHA-protected topics.

The owning Storybook scene and Playwright suite sample actual SVG bounds, opacity,
identity and containment at controlled frame steps; they exercise both themes,
first/middle/last selection, directional hysteresis, reversals, focus, reduced motion,
resize and absent FAB. Component tests cover source switching, changing tab sets,
absent selection and independent instances. The browser clock is installed before
Motion loads so the captured animation scheduler uses the controlled clock.
Resize assertions await actual ResizeObserver delivery rather than a timed delay.
The global reduced-motion CSS sets a tiny nonzero transition duration on every
node; motion-driven elements explicitly use `transition-property: none` so that
rule cannot introduce another interpolation after a spring jump.

The shared UI is public; the Android shell is not. These checks do not establish
physical-device frame rates or production-window performance. Package typechecking
and broad Storybook dependency scanning encounter unrelated missing installed
viewer/ACP/Electron dependencies. Root formatting passes; `pnpm check` stops at
the missing ACP SDK during shared-package typechecking. Tracking:
[upstream issue #1257](https://github.com/LodyAI/Lody/issues/1257).

## Browser performance sample

Chromium 145.0.7632.6, headless at 393×852 and DPR 1, profiled the production
component in the development Storybook iframe. Four scenes covered iOS, Material,
imperative signals and two tabs without a FAB, each at normal and CDP 4× CPU
throttling. Each scene recorded 240 real animation frames for idle, eight scroll
retargets (including four-frame reversals), and continuous down/up scrolling at
3px per frame. CDP timeline/Performance metrics, a long-task observer and a React
DevTools commit counter supplied observations; geometry was not read per frame
inside the measured windows. These are exploratory samples, not timing gates.

| Workload | Normal rAF interval p95 | 4× CPU rAF interval p95 |
| --- | --- | --- |
| Idle | 9.7–9.8ms | 10.1–10.2ms |
| Collapse/expand and reversals | 9.5–9.9ms | 10.1–10.3ms |
| Continuous scrolling | 9.4–10.0ms | 10.2–10.3ms |

No long tasks (50ms+) or browser errors were observed. The largest callback
interval was 17.1ms; none exceeded 25ms. In the retarget samples, individual layout
events had p95 at most 0.79ms and paint events at most 0.671ms under throttling.
Actual-size animation does perform layout and paint each frame; it is not solely
compositor work. Animation-only sequences produced 12–30 React root commits,
rather than a commit for every animation frame.

Continuous signal input was substantially heavier: 343–351 root commits versus
6 for DOM-scroll scenes across 240 frames. At 4×, the signal scene accumulated
about 1.45s of renderer TaskDuration versus 0.16–0.29s for the DOM scenes. This
includes the story's per-scroll signal state and the shared component, not a
measurement of a real Monaco editor or a complete app window. If device profiling
finds remaining cost, investigate per-scroll React work on the signal path first.
No additional production change was made from these samples.

Headless callback cadence is not a measurement of presented compositor frames.
Development overhead, host scheduling, uncalibrated CPU throttling and the small
synthetic list limit generalization. Native Android/WebView, GPU raster/composition,
and production-build performance still require device validation. Raw local
results and timeline traces were retained in the profiling session's temporary
artifacts, not committed as repository fixtures.
