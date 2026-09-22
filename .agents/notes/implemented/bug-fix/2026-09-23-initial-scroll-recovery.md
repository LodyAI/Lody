# Recover initial scroll restoration after late measurements

Status: implemented
Translation: current

[中文](2026-09-23-initial-scroll-recovery.zh.md)

PR: [#896](https://github.com/LodyAI/Lody/pull/896)

## Abstract

A conversation can remain invisible even after its rows are mounted and measured.
Cold restoration can clamp a cached pixel offset to an estimated scroll extent;
late Virtua measurements then move the anchor after its scroll request has ended.
The initial visibility gate kept waiting for the cached offset without restoring
it. The sticky adapter now reapplies the clamped offset on geometry and scroll
delivery until reveal, while retaining the measurement gate and honoring newer
navigation. This reproduces and repairs one persistent-blank path; the original
report's lost runtime state does not establish that it used this exact path.

## Cause and ownership

The [windowed-reader decision](../architecture/2026-09-10-windowed-reader-integration.md)
requires measured destination rows before reveal. That requirement remains intact.
The [background-hydration fix](2026-09-22-background-hydration-render-window.md)
separately stabilizes row membership after reveal; this repair covers initial restoration.
`use-sticky-scroll.ts` previously called Virtua's asynchronous `scrollTo` once and
then only compared the current offset against the cached target. Virtua 0.49.1's
request stops after 150ms without another measurement. A later measurement can
change the maximum offset and compensate the visible anchor, leaving no owner
that will restore the target required by the gate.

Cached pixel restoration now uses the sticky library's DOM setter, like tail
corrections. Geometry and scroll callbacks reapply the current clamped target
until Virtua acknowledges the offset and destination rows are measured. No retry
timer, unconditional reveal, extra observer, or message-subtree scan is added.
After reveal the cached target no longer controls scrolling. Latest navigation,
upward wheel intent and suppressed jumps retire it before reveal as well; removing
the asynchronous initial request also prevents that request from undoing a jump.

## Evidence and limits

- An isolated browser fixture uses the shipped hook and real Virtua, 30 synthetic
  rows and a cached offset of 1200px. Holding row measurements, expiring the pending
  scroll request, then releasing measurements left the old hook hidden at 7235px
  despite measured rows. The fixed hook reveals at 1200px.
- `tests/use-sticky-scroll.test.ts` covers changed clamping/anchor geometry,
  virtualizer acknowledgment, measurement gating, and replacement navigation.
  The late-measurement regression fails on the old hook.
- `ColdCachedOffset` and `tests/e2e/session-chat-hydration.spec.ts` retain a browser
  reproduction with held ResizeObserver delivery and a fake clock. The cold-tail
  fixture clears both position and measurement caches on each open: a warm cache
  already supplies measurements, so expecting it to remain hidden is incorrect.
- The report also contained transport errors. Their causal relationship to the
  blank viewport is unproven; this change does not alter transport recovery.

Current ownership and invariants: [hooks README](../../../../packages/components/src/hooks/README.md#conversation-scrolling-use-sticky-scrollts)
and [hooks rules](../../../../packages/components/src/hooks/AGENTS.md).

## Validation

On top of the background-hydration fix, the five focused unit suites pass 69 tests;
the complete `session-chat-hydration.spec.ts` browser suite passes all seven tests
in Chrome. The new browser test fails on the old hook because visibility remains
hidden after measurements are released. Component typechecking, scoped type-aware
lint (no errors) and repository formatting pass. Full `pnpm check` stops at missing
`site-docs` dependencies; full lint also encounters missing type declarations in
uninstalled scopes. Document checking retains existing missing-submodule links.
