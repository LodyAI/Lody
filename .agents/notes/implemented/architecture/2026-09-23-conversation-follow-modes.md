# Conversation follow modes

Status: implemented
Translation: current

[中文](2026-09-23-conversation-follow-modes.zh.md)

## Abstract

Following the end of a conversation often failed, and typing in the composer made the
chat jump by a line. Both came from inferring reader intent from scroll direction: the
`use-stick-to-bottom` library treated a browser clamp (the viewport growing when the
composer shrinks) as the reader scrolling up, and a one-shot composer skip flag left a
followed conversation behind a growing composer. `use-sticky-scroll.ts` now owns an
explicit `follow` / `anchored` / `free` mode that only reader input releases, and a
direct send holds the sent message at the top with room reserved for the reply.
Unit coverage exercises each transition; acceptance in the real app and the cause of the
repeated open flicker are still open, and a scroll timeline was added to diagnose it.

## Problem and discoveries

- Composer growth set `skipNextViewportResizeAutoScrollRef` (#131), so the viewport
  ResizeObserver skipped the bottom correction: `scrollTop` stayed, the last line slid
  under the composer, and the next streamed chunk pulled it back — the visible "bounce".
- Composer shrink (deleting a line, clearing on send) grows the viewport. The browser
  clamps `scrollTop` upward and fires `scroll` before any ResizeObserver. The library's
  direction check (`scrollTop < lastScrollTop`) released follow; the skipped correction
  could not mark that write as programmatic. This is a likely main cause of "follow
  often stops working".
- The skip flag was not guaranteed to be consumed, so it could swallow a later, real
  resize (window or terminal dock).
- The hook's own wheel listener released follow for any upward wheel, including one
  scrolling a nested code block or terminal. The library's own wheel check never matched
  the viewport because its computed `overflow` is `"hidden auto"`.

## Decision

The mode lives in the hook; observers never change it.

- Release: an upward wheel not consumed by a nested scroller, upward navigation keys
  outside editable targets, or an upward scroll while a pointer or touch is held
  (scrollbar drag, selection auto-scroll, touch pan). An upward scroll with nothing held
  is a clamp or a size correction and is ignored.
- Re-arm: a downward scroll ending within 4px of the real bottom with no reply room left,
  an explicit jump to the end, or a send.
- Own `scrollTop` writes are recorded so their scroll event is not read as intent.
- A cached reading offset is restored synchronously and reapplied on every geometry or
  scroll delivery until reveal; every navigation (release, suppressed jump, explicit end,
  send) retires it. This carries PR #896's
  [initial scroll recovery](../bug-fix/2026-09-23-initial-scroll-recovery.md) into the modes.
- Viewport height changes keep the current mode's position; the skip flag is removed.
- A direct send (agent idle) anchors its user row: the row is scrolled to where the
  first row sits at rest, and an element after `Virtualizer` reserves
  `target + viewport - bottomPadding - contentEnd` pixels. The reply shrinks it without
  moving anything; at zero the mode becomes `follow`. A row taller than the viewport is
  followed from the bottom instead. Outside `anchored` the room only shrinks, to what
  keeps the current position reachable, so scrolling up consumes it without a jump and
  it never comes back. Queue and guide sends leave the viewport alone.
- The move to the anchor is a 360ms ease-out glide driven by `requestAnimationFrame`,
  not an instant jump. It re-reads the destination every frame (the rows it lands on
  are still being measured, and the reply may fill the room mid-glide, in which case it
  continues to the bottom), reserves the room before the first frame, and stops as soon
  as reader input releases the mode. A glide covers at most 1.5 viewports; a longer
  distance jumps to that range first so the glide never crosses unmounted rows. Native
  `scrollTo({ behavior: 'smooth' })` was rejected: any correcting write cancels it, and
  its intermediate scroll events cannot be told from reader input. Reduced motion jumps.
- The room is a sibling of the virtualized content, not a Virtua row: a row would shift
  indices, invalidate the row-count-keyed measurement cache and enter the outline math.

Keeping the library and patching its heuristics was rejected: the hook already
re-implemented its content observation and fought its re-locking; a clamp and a real
upward scroll are indistinguishable from scroll events alone.

## Open flicker

Not fixed here. Suspected: after reveal, the reading window grows, placeholder turns
above the viewport become several rows, Virtua (with `shift={false}`) moves content, and
follow snaps back once per hydration batch. The measurement cache is keyed by row count,
so a conversation that changed while closed opens cold. `scroll-debug-log.ts` records
reveal blockers, follow corrections, hidden rows intersecting the viewport after reveal,
row composition and hydration windows (`window.__lodyScrollLog.dump()`), to confirm or
refute this before changing the hydration path. The reveal check now also runs on
viewport height changes, removing one way the pane could stay hidden.

## Reading position while rows change above

Measured on 2026-09-24 with a per-frame recorder (row screen positions, every programmatic
`scrollTop` write with its caller, row resizes) driven by real wheel input.

- **Near the bottom on `main`**: each small scroll up and back re-locked
  `use-stick-to-bottom` (70px tolerance) and jumped 67px in one frame to the end. The
  follow modes above do not write at all in the same scenario.
- **Scrolling up through a long conversation** (100 rows): the largest jumps (314px,
  902px) were not measurement corrections but placeholder turns above the viewport
  becoming several rows. With `shift={false}` and index-keyed sizes, Virtua keeps pixel
  offsets, so the rows under the reader change. A free reader's row is now captured by
  key (the row under the viewport's middle and its distance from the top) on every scroll
  and own write, and when the row list changes the hook puts that row back in the same
  commit, before paint, dispatching a scroll event so Virtua renders the new range in that
  frame. Total visible jump over the same scroll fell from 1,370px to 344-479px.
- **Rejected**: native scroll anchoring (`overflow-anchor`) has no effect on Virtua's
  absolutely positioned rows (identical results on and off with Virtua's compensation
  disabled). Patching Virtua to compensate rows wholly above the viewport's middle removed
  a 30px jump in a synthetic harness but would move a group's header when it is expanded
  in the top half, contradicting "group toggles never scroll"; the reverted patch was not
  shipped. A continuous second writer (correcting drift on every geometry change) was
  rejected because a programmatic jump whose scroll event has not arrived would be undone.
- **Remaining**: smaller shifts (about 20-90px) when visible rows are re-measured, and
  one −264px shift while newly inserted rows measured, are still under investigation.

## Verification and limits

`packages/components/tests/use-sticky-scroll.test.ts` covers composer growth and shrink
with a browser clamp, nested-scroller wheel, scrollbar drag release and re-arm, and the
anchored lifecycle (reserve, shrink, hand-off to follow, scroll-up consumption, tall
message, viewport growth after send). The components suite passes. Behavior in the
desktop and Web apps against a real conversation is not yet verified. Keyboard release
covers PageUp/Home/ArrowUp/Shift+Space only. Spec: [conversation scroll](../../../../specs/conversation-scroll.md).
