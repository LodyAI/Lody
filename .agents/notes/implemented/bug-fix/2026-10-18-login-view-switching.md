# Continuous compact login transitions

Status: implemented
Translation: current

[中文](2026-10-18-login-view-switching.zh.md)

## Abstract

Switching between OAuth and a retained email sign-up form rebased visible content
inside a shorter container, causing a 64px jump. Reserving the largest form left
an unwanted hole in sign-in, and staging a complete fade-out, resize and fade-in
removed the continuity the interaction needs. The implementation keeps both
panels mounted and slides them while fitting their intrinsic heights; sign-in
and sign-up share their actual input elements and animate only changing rows.
Content remains visible throughout, with no control scaling or reserved name row.

## Structure and decision

This refines the transition decision in the
[login visual note](../feature/2026-10-17-login-inset-visual-last-used.md).
The earlier check missed leaving and re-entering a retained sign-up mode.
`popLayout` removed the outgoing form's layout contribution immediately,
rebasing it inside a shorter container. The installed Motion 12.43.0 source also
confirms that `wait` sequences exits rather than coordinating independent parent
and child dimensions. Website access failed during that mechanism review.

Two intermediate approaches were rejected: a fixed maximum height leaves blank
space in sign-in, and fading the entire scene hides the content during resizing.
Neither satisfies a continuous compact transition.

```text
Bottom-anchored login body (one-time entrance)
└─ Ordinary flow with 24px gaps
   ├─ Persistent header: expanding Back row, title, description
   ├─ Optional error
   ├─ LoginViewSlot: clipped viewport, interpolated flow height
   │  └─ Horizontal track: one progress value, no scale or opacity animation
   │     ├─ OAuth / desktop entry panel (mounted)
   │     └─ Email panel (mounted)
   │        └─ Persistent form: expanding name, email, password,
   │           collapsing forgot-password, submit, mode switch
   └─ Optional legal notice
```

`login-page.tsx` owns auth state and drafts. Changing email mode updates the same
form tree rather than keying or replacing it. The name input remains mounted but
is disabled, not required, inert and hidden from accessibility while collapsed.
Offscreen panels are likewise inert and excluded from the accessibility tree.
Email focus uses `preventScroll` after the slide finishes, and mode changes keep
the current focus instead of resetting it.

`login-view-slot.tsx` uses one numeric MotionValue from 0 to 1 for horizontal
translation and the interpolation between the two panels' measured heights.
The track is 200% wide and its translation reaches -50% at the email destination.
The viewport clips the adjacent panel and leaves padding for focus rings. Both
panels remain mounted, so re-entry preserves the input nodes and browser state.
Height and translation use a 320ms cubic-bezier transition (0.4, 0, 0.2, 1).
Cancelling a slide stops its animation and continues from the current value.

Expanding rows animate numeric measured flow heights with the same timing. This
avoids `height: auto` keyframe measurement during reversal. A Motion post-render
measurement fits the enclosing viewport in the same frame after the row writes
its height, rather than adding a second compensating tween. ResizeObserver also
tracks fonts and viewport changes. The header's Back row and changing copy have flow-height transitions; this also
covers descriptions wrapping to different line counts on narrow screens. Copy
updates in place. Reduced motion writes the final numeric values directly. The dither visual retains its existing narrow
screen folding behavior and the page retains its one-time entrance animation.

Stopping an animation preserves its last frame's numeric value before starting
the replacement, because Motion's stop operation can sample ahead of that frame.
This avoids a small cancellation displacement.

## Verification

The owning browser suite checks 1000px, 850px and 390px layouts, compact sign-in
versus sign-up heights, retained sign-up re-entry, draft values and input node
identity. An injected browser clock inspects intermediate slide and row heights,
full field and title opacity, unscaled panels, and reversals from their current
positions. A separate reduced-motion case checks immediate final layout.
Screenshots cover sign-in, sign-up and partial name expansion.

All six browser cases pass (17.5s, normal process exit), including intermediate frames and
reversals at both 1000px and 390px. The existing last-used-method and desktop
handoff suites pass all 19 cases. Package typecheck reports errors in
`loro-sidebar.tsx` and `home-week-usage.ts`, outside this change. Documentation
checks retain six broken links into absent ACP submodule sources and three
oversized instruction files; there are no protected topics awaiting SHA review.
