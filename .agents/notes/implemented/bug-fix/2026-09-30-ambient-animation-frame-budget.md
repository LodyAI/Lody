# Cap ambient animations at 30 fps while the window is unfocused

Status: implemented
Translation: current

[中文](2026-09-30-ambient-animation-frame-budget.zh.md)

## Abstract

Any running infinite animation — a 12px working mark, a spinner, the status
shimmer — keeps Chromium's compositor drawing a frame every vsync (120 Hz on
ProMotion), and a visible window is never throttled, so Lody drew full-rate frames
for hours while agents worked and the user was in another app. While the window is
unfocused, every ambient animation is now quantized to 30 fps on one shared tick
grid; with focus it stays smooth, and nothing pauses, because a Lody left on a
second display must still visibly work. In an isolated Electron 43 benchmark this
roughly halves renderer plus GPU-process CPU; the remaining floor comes from the
compositor still waking on every vsync while any animation runs.

## Pressure

- Live A/B on the Electron 43 build, Lody visible but not frontmost, four working
  marks and two spinners running: renderer 11.4%, GPU process 20.4%, WindowServer
  46%; with every animation held paused: 2.2%, 0.8%, 8.0%.
- One animation costs about as much as eighteen, and a 600×600 one about as much
  as a 12px one: the cost is frames produced, not pixels or layer count. Traces
  showed 120 `DrawFrame`s per second with composited animations and no main-thread
  work. The [spinner note](2026-09-13-spinner-off-svg-retina-composite.md) moved the
  work off the main thread; it did not make a running animation cheap.
- Electron 43's restored occlusion tracking only helps a fully covered window; the
  common case — another app frontmost, Lody still on screen — reports `visible`.

## Decision

`lib/ambient-motion.ts` owns a frame budget installed once by the desktop renderer.
On window `blur` it rewrites every infinite animation's timing to
`steps(round(duration / tick))`, snaps duration, delay and start time to the
33.3 ms tick, and on `focus` restores each animation's own easing, duration and
delay. Finite animations (entrances, the working→unread collapse) are untouched.
CSS animations that start while unfocused, including pseudo-elements, join through
`animationstart`; script-created Web Animations do not fire that event, so their
owner calls `adoptAmbientAnimations` — `WorkingGrid` does after creating its tiles.
Its periods (1900, 2700, 3600 ms), the 1 s spinner and the 2.2 s shimmer are exact
multiples of the tick, so no loop changes speed.

Shared alignment is the point: unaligned `steps()` animations interleave their
changes, so the compositor would still draw nearly every vsync.

## Alternatives

- **Pause while unfocused.** Cheapest, rejected: a user with Lody on a second
  display would read a paused mark as a frozen app.
- **Drive indicators from a JS timer** (VS Code's cursor blink, Chrome's
  `views::Throbber`). Measured no better: 10 Hz timer 3.4–3.6% vs 10 fps `steps()`
  3.3%; a 30 Hz timer cost as much as continuous animation, because every tick is a
  main-thread frame and commit.
- **Always throttle, even focused** (VS Code spins codicons at `steps(30)`/1.5 s ≈
  20 fps and moves its progress bar to `steps(100)` after 10 s). Deferred until the
  product has judged how 30 fps looks while unfocused.
- **Platform switches.** None exist for on-screen windows: `setFrameRate` is
  offscreen-only, `--disable-frame-rate-limit` removes the cap, and Chromium's
  content-driven display-rate reduction is registered only on Android.

## Validation

Isolated Electron 43.7.6 page, window visible and unfocused, four grids plus two
spinners, renderer + GPU-process CPU over 30 s: continuous 7.8–7.9%, 30 fps
4.2–4.4%, 20 fps 4.5%, 10 fps 3.3–4.3%, none 0. With the real module bundled into
that page, CSS `spin`, the `::after` sweep and the Web Animations all read
`steps(n)` on integer tick start times, and CPU fell from 8.5% to 5.2%.
`tests/ambient-motion.test.ts` checks that every change instant lands on one grid
for the real wave periods and phases; each alignment step and both hand-over paths
were ablated and a test failed.

## Limits

- Below 30 fps savings flatten: while any animation runs, the compositor still
  wakes on every vsync to tick it, and only stopping removes that floor.
- WindowServer's share could not be isolated in the benchmark; the live A/B shows
  it is the largest component, so the product-level saving is unmeasured.
- The budget covers the desktop renderer only; the browser composition does not
  install it.
