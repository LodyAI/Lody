# Continuous mobile workspace dock motion

Status: implemented
Translation: current

[中文](2026-10-05-mobile-workspace-dock-motion.zh.md)

## Abstract

Overlapping dock and child layout animations stretched the selected icon. Accepted prototype D keeps keyed tabs mounted and uses one spring for actual geometry and fades. Downward scrolling minimizes; upward scrolling reveals navigation. This incurs layout/paint work, and physical Android performance remains unverified.

## Decision

Keep the selected icon opaque at 24×24; reject duplicated-icon and whole-panel crossfades (prototypes B/C). The [component](../../../../packages/components/src/components/mobile/mobile-workspace-tabbar.tsx) uses one retargetable spring (420 stiffness, 40 damping, mass 1, rest thresholds 0.001), derived MotionValues, a stable width slot observed through the shared frame-scheduled resize helper, and a fixed 56px optional action slot. No layout projection or shared identity participates; legacy `layoutId` remains accepted but unused.

DOM and imperative scrolling share directional accumulation; switching sources resets the baseline, and an active imperative signal takes precedence. Read visibility directly from the spring with `useSyncExternalStore`; only threshold crossings change the snapshot. Move focus before applying inert because Chromium may otherwise clear it. Explicit `transition-property: none` prevents global reduced-motion CSS from interpolating spring jumps. The [draft Spec](../../../../specs/mobile-workspace-dock.md) owns behavior.

Apple's [scroll-minimizing tabs](https://developer.apple.com/videos/play/wwdc2025/284/?time=151) and [interruptible springs](https://developer.apple.com/videos/play/wwdc2023/10158/) inform the interaction; this uses web geometry, not native Liquid Glass. Tracking: [#1257](https://github.com/LodyAI/Lody/issues/1257) · [PR #1258](https://github.com/LodyAI/Lody/pull/1258).

## Evidence and limits

Controlled-clock browser coverage samples actual SVG identity, bounds, opacity and containment through reversals, plus focus, directional thresholds, reduced motion, resize and absent selection/FAB. Three representative geometry cases cover both themes, both scroll paths and first/middle/last selection without a Cartesian matrix. Component tests retain source-switching and tab-mutation coverage; the removed jsdom instance test could not detect layout projection. The original component fails the geometry regression at 80.25px icon width instead of 24px.

Exploratory Chromium 145 headless Storybook profiling (393×852, DPR 1, normal/4× CPU; 240 frames per idle, reversal and continuous-scroll sample) observed no 50ms+ long tasks. Callback interval p95 was 9.4–10.3ms, not presented-frame FPS. At 4×, layout/paint event p95 maxima were 0.79/0.671ms. Continuous signal input produced 343–351 React root commits versus 6 for DOM scrolling, including story state; investigate that path if device profiling shows remaining cost.

Native Android/WebView, GPU composition and production-build performance are unverified. Full checks encounter missing ACP SDK and viewer/Electron dependencies; docs checks encounter links into absent ACP submodules. These environment failures do not establish global correctness.
