# Remove the working-grid reading pause

Status: implemented
Translation: current

[中文](2026-09-25-working-grid-reading-pause-removed.zh.md)

## Abstract

The [sidebar working-grid note](../feature/2026-09-24-sidebar-working-grid.md)
added a "reading pause": any wheel, key, pointer or touch input outside the
sidebar froze every working mark on its current frame, resuming after 4s of
quiet or on pointer entry. In use the freeze read as jank rather than
consideration — a stopped activity indicator signals "stalled", and the
literature on attentional capture says motion *cessation and onset* in the
periphery are exactly the events that involuntarily pull the eye, while smooth
continuous motion is a comparatively weak capturer. The mechanism was removed
entirely: marks now animate continuously, and the shared-sea clock survives as
an inline `animation.startTime = 0` in `working-grid.tsx`. The compositor-only
constraint is unchanged; what was lost is a mitigation whose cost (repeated
capture events plus a false "stopped" signal) likely exceeded the continuous
low-level salience it removed.

## Problem

Reported by the product owner: the sidebar mark "freezes and then recovers",
which reads as the app stalling. Analysis of the shipped mechanism surfaced
three problems beyond the anecdote:

- **Semantic inversion.** An activity indicator's motion is the "alive"
  signal; users infer process health and duration from it (progress-indicator
  literature: Myers 1985 onward). A mark that stops moving while the session
  still works emits a false stalled/finished signal at the exact moment the
  user interacts most (typing in the composer counts as "reading").
- **Wrong stimulus class.** Attentional-capture research (Abrams & Christ
  2003; the JOV 2012 onset/offset optic-flow study) shows continuous smooth
  motion outside the attentional focus does *not* strongly capture attention,
  but the *commencement and cessation* of motion do — involuntarily, even when
  task-irrelevant. The pause converted continuous weak salience into repeated
  strong transients, one per input burst plus one on every 4s-idle resume.
- **Bad proxy.** "Input outside the sidebar" is a poor stand-in for "the user
  is reading". Reading is mostly silent scanning: the marks resume 4s after
  the last input, i.e. during the longest reading stretches, and stay frozen
  through sustained typing — arguably inverted relative to the intent.

## Decision

Delete `working-grid-reading.ts` wholesale rather than soften it:

- The shared clock remains necessary — the sea only stays coherent because
  every loop is pinned to `document.timeline` zero — so `play()` in
  `working-grid.tsx` now sets `animation.startTime = 0` directly.
- `data-working-grid-region` is gone from `loro-sidebar.tsx` and the
  `SidebarSimulation` story; `setWorkingGridReadingPause` is gone from the
  module surface.
- The unit test covering the pause is removed; the shared-clock assertion
  (all loops share one `startTime`) still stands.

## Alternatives considered

- **Graceful deceleration** via `animation.updatePlaybackRate()` (ramp to 0
  and back instead of `pause()`). Keeps the feature while removing the hard
  transient; per the same literature, a gradual rate change is a quantitative
  rather than qualitative event. Rejected by the owner: no slowing or
  stopping behaviour at all — the mark simply runs.
- **Reduce modulation depth instead of pausing** (narrower opacity range,
  slower waves). The design history already walked this axis; the owner had
  previously rejected calmer forms as too static to notice.
- **Keep pause with a better trigger** (conversation focus, scroll
  direction). Still emits cessation/onset events and still guesses at gaze;
  does not fix the semantic problem.

## Consequence

A column of working marks now moves continuously in the periphery — the cost
the pause was built to avoid returns, mitigated only by the narrow opacity
range and slow periods. That trade is deliberate: the owner prefers a
constant honest signal over a polite but misleading one. If real reading
experience shows the continuous motion is a problem, the evidence-backed axes
are modulation depth and speed, not binary state switches.

## Verification

- `tests/working-grid.test.tsx` updated; the removed test was the only pause
  coverage. Remaining assertions still pin the compositor and shared-clock
  contracts.
- Not measured: peripheral-motion distraction on real readers — same limit
  the original note already acknowledged for the pause itself.
