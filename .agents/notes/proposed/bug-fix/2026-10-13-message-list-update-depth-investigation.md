# Investigate recurring message-list React #185

Status: proposed
Translation: current

PR: [#1534](https://github.com/LodyAI/Lody/pull/1534)

[中文](2026-10-13-message-list-update-depth-investigation.zh.md)

## Abstract

Users still occasionally encounter React #185 while displaying conversation messages.
Source inspection identifies synchronous scroll commits and their viewport-to-hydration
feedback as the first path to investigate, but does not reproduce the reported failure.
The existing hidden-viewport pause, unchanged-offset suppression, and state equality
guards are present in the current code. This record proposes targeted reproduction
and diagnostic interpretation; it neither identifies a confirmed new cause nor changes
runtime behavior.

## Evidence and candidate mechanism

- React [error 185](https://react.dev/errors/185) means maximum nested update depth.
  A message-list boundary or the final state setter in its stack identifies where
  React stopped the cascade, not necessarily the update that started it.
- `EngineConversationScroller` runs `controller.afterCommit()` in a layout effect.
  Its `ScrollHost.requestCommit` calls a reducer synchronously from that effect,
  or `flushSync` outside it. `ScrollController.continueTransaction` and
  `requestCoverageCommit` can therefore extend a synchronous commit chain.
- Each transaction has a supplementary-commit bound. However, `syncRows` discards
  an active transaction when geometry keys or unmeasured estimates change. The
  bound does not establish convergence across a sequence of different row lists.
- The connected feedback path is `reportScroll` → `handleStreamScroll` →
  `reportVisibleTurnRange` → `useConversationStreamItems.onVisibleTurnRangeChange`.
  Changing the hydration window changes which turns render bodies versus
  placeholders, changing row keys, estimates, and the resolved reading position.
  A new offset or visible range can pass the existing equality checks. A synthetic
  reproduction must demonstrate an actual cycle before this is called the cause.
- Body acquisition and view notifications also include promise and animation-frame
  boundaries. A hydration loop across those boundaries is not by itself proof of
  the synchronous nested-update cascade that throws #185.

## Existing protections and test limits

The [scroll-engine decision](../../implemented/architecture/2026-09-27-conversation-scroll-engine.md#hidden-viewports-2026-09-29)
records an earlier production #185 and its hidden-tab fix. The current connected
stream forwards `isVisible` to `hidden`, including side chats in collapsed panels.
The controller skips hidden transactions and suppresses unchanged offsets; the
adapter suppresses them again. `handleListStateChange` compares all three state
fields and has a stable callback. These are not missing guards in this checkout.

The existing adapter suite covers hidden-tab feedback and a consumer that updates
on every scroll report. It does not establish convergence of the production
hydration feedback with a saved anchor, placeholder expansion, and window movement.
Native selection also publishes state from layout effects, but its retention checks
normally stop repeated publication; no selection-driven #185 was established.
Overlay arming and streaming Markdown introduce additional child updates. They
should be investigated only if the caught component stack points to those surfaces.

## Proposed next verification

Use the existing copied crash report: build version, original stack, caught React
component stack, session render trace, and scroll-engine diagnostics. Repeated engine
commit diagnostics with changing targets/anchors favor the geometry path; repeated
surface mount/unmount events favor remount ownership. A child overlay or Markdown
stack with quiet engine diagnostics calls for reproducing that child boundary.
Covered successful cycles are not currently appended to the session render trace,
so a quiet trace alone cannot exclude the engine; compare its diagnostics too.

Extend the owning adapter/integration suite with a synthetic ConversationView and
saved reading anchor. Change hydration through explicit signals, assert stable
visible turns and anchor position, and exercise placeholder/body replacement near
the window boundary. Avoid timers added merely to mask nested updates or a message
count key that remounts the list and loses reading state.

## Proposed reduction of effect-driven feedback

The completed-assistant effect mirror has since been removed in the bounded
[derived-state change](../../implemented/simplification/2026-10-13-completed-assistant-derived-state.md).
The remaining scroll/hydration proposals below are not implemented.
An [engine update-loop guard](../../implemented/bug-fix/2026-10-13-scroll-update-loop-guard.md)
now contains synthetic synchronous cascades with explicit boundary recovery;
it does not establish the reported production root cause.
One production cascade caught by that guard has since been traced to the hydration
feedback path: a [creation record grouped away by its neighbour's hydration](../../implemented/bug-fix/2026-10-17-grouped-creation-record-anchor.md)
lost its reading anchor. Other reported #185 cases remain unexplained.

Apply React's [You Might Not Need an Effect](https://react.dev/learn/you-might-not-need-an-effect)
to redundant state and child-to-parent mirroring. The scroller's layout measurement,
coverage commits, scroll writes, observer registration, and lease cleanup still
synchronize external systems; they cannot become render-time side effects.

A shared, stable scroll snapshot could replace the adapter's local sticky/revealed
state followed by the `onStateChange` layout-effect mirror into the parent. Derive
top fade, outline position, and visible range from that snapshot and geometry revision
rather than maintaining several callback-updated copies. Publish only meaningful
snapshot changes. `useSyncExternalStore` alone does not break a synchronous loop:
layout-time publication still needs convergence and equality guards.

Move the last-completed-assistant identity to a shared data owner instead of notifying
the parent in an effect merely to copy its result into state. This removes an extra
update path but is not evidence that this already-guarded effect caused the crash.

For hydration, preserve reading identity across placeholder/body changes and separate
reader navigation from layout compensation. Compensation should not unnecessarily
retarget the hydration window. Retain leases required by the active anchor/viewport
until the replacement window is ready, with bounded ownership; verify actual cyclic
ranges before changing eviction behavior. Keep the synchronous coverage guarantee and
native-selection retention. Do not replace `useLayoutEffect` with `useEffect` or add
arbitrary frame delays as a crash workaround. These are design proposals, not a
verified fix or an adopted new contract.

## Verification limits

This is source inspection only. The checkout has no installed node_modules, so
React/browser tests were not run. Both required documentation commands were
attempted and failed with `spawnSync git EPERM`. No captured user transcript is
stored here; no product code or reviewed Spec was changed.
