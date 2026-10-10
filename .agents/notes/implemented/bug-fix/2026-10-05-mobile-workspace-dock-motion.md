# Continuous mobile workspace dock motion

Status: implemented
Translation: current

[中文](2026-10-05-mobile-workspace-dock-motion.zh.md)

## Abstract

Overlapping parent/child layout animations stretched the selected icon. Accepted prototype D preserves its identity and drives actual geometry with one retargetable spring. This requires layout/paint work; physical Android performance remains unverified.

## Decision

Duplicated-icon and whole-panel crossfades did not provide the desired continuity. Keep tabs mounted and measure a stable width slot; the optional action reserves space so its animation cannot feed back into dock width. See the [behavior Spec](../../../../specs/mobile-workspace-dock.md).

Two browser details matter: transfer focus before applying inert, which can otherwise clear it; disable CSS transitions on motion-driven elements, because global reduced-motion CSS can interpolate spring jumps again.

## Evidence and limits

Exploratory browser checks found the original 24px icon reaching 80.25px wide and verified fixed geometry through reversals after the change. These checks are not retained as regression tests. Headless Storybook profiling at normal/4× CPU observed no 50ms+ long tasks, but continuous imperative signals caused more React work than DOM scrolling. Production Android/WebView and GPU composition remain unverified.

[#1257](https://github.com/LodyAI/Lody/issues/1257) · [PR #1258](https://github.com/LodyAI/Lody/pull/1258)
