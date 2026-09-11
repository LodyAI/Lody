# Centralize horizontal wheel scrolling

Status: implemented
Translation: pending

## Abstract

The task board and side-panel tabs independently converted vertical mouse-wheel
input into horizontal scrolling, which allowed their gesture, delta-mode, and edge
behavior to diverge. A shared React hook now owns the native non-passive listener,
delta normalization, clamping, and browser-event release rules. Callers retain only
their surface-specific eligibility policy, such as keeping wheel events inside a
task column vertical.

## Decision

Horizontal wheel conversion is DOM behavior rather than Session or Task business
logic, so [`use-horizontal-wheel-scroll.ts`](../../../../packages/components/src/hooks/use-horizontal-wheel-scroll.ts)
owns it. The hook binds directly to the scroll viewport through a callback ref: React's
delegated passive wheel listener cannot reliably call `preventDefault()` after the
vertical delta is consumed.

The shared behavior ignores native horizontal or diagonal gestures, browser zoom,
already-consumed events, zero vertical deltas, and scroll directions that have
reached an edge. Pixel deltas pass through, line deltas use a stable 16-pixel unit,
and page deltas use the viewport width. A one-pixel epsilon avoids trapping wheel
input on fractional device-pixel overflow.

The optional `shouldHandle` predicate is the boundary for surface-specific policy.
[`TasksBoardView`](../../../../packages/components/src/components/tasks/tasks-board-view.tsx)
uses it to preserve vertical scrolling whenever the event starts inside a board
column; [`SessionSidePanelTabBar`](../../../../packages/components/src/components/sessions/session-side-panel-tab-bar.tsx)
accepts all otherwise eligible vertical wheel events.

## Evidence and verification

This follows up the side-panel behavior merged in
[PR #601](https://github.com/LodyAI/Lody/pull/601) and replaces the earlier Task
Board-only resolver and listener. DOM-level tests dispatch real cancellable wheel
events and cover pixel, line, and page deltas; clamping and edge release; horizontal
and zoom gestures; nested-content ownership; disabled behavior; and fractional
overflow.
