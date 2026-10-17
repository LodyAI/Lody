# Conversation scroll engine

`CLAUDE.md` is a symlink to this file. Edit `AGENTS.md` only. Parent rules apply.
Design, invariants I1–I8 and the coverage lemma:
[scroll-engine note](../../../../../.agents/notes/implemented/architecture/2026-09-27-conversation-scroll-engine.md).

- `controller.ts` owns the transaction logic and stays free of React and the DOM; it
  reaches both only through `ScrollHost`. The adapter is
  `components/ai-gui/conversation-list/engine-conversation-scroller.tsx`.
- The engine is the viewport's ONLY programmatic `scrollTop` writer and owns the rows
  container's height. Never add another writer, `scrollTo`/`scrollIntoView` on the
  viewport, or a style that lets rows change the scroll range. Consumers go through
  `ConversationListHandle`.
- Every written position is derived from an anchor (`read`, `follow`, `sent`, glide
  frames interpolate `screenY`). Layout compensation in `read` is relative
  (`scrollBy`), navigation absolute. No deferred compensation, no origin shift.
  Relative writes use the raw host offset as their baseline, while anchors and
  movement use bounded offsets; elasticity alone must not cause a write.
- A transaction ends within two passes of at most two supplementary commits;
  `lastObserved` records only covered positions, and `onScroll` fires only for those.
  A React re-render that did not change the list must not start a new cycle (that
  layout-effect `onScroll` → setState loop is React #185). Never add timers, frame
  retries or a hidden/reveal gate; the viewport is never hidden.
- The synchronous commit budget spans row changes and transaction restarts. Its
  microtask only resets bookkeeping, never retries layout. Exhaustion records
  `update-loop` and throws to the message-list boundary; only explicit retry
  remounts the failed controller. [Decision](../../../../../.agents/notes/implemented/bug-fix/2026-10-13-scroll-update-loop-guard.md).
- Keep the layout contract: viewport `overflow-anchor: none` and
  `scrollbar-gutter: stable`; rows container `overflow-y: clip`; no row may use
  `content-visibility: auto` or size itself from the container or its position. Rows
  outside the fixed rows (`FIXED_ROW_KINDS`) stay at least `ENGINE_MIN_ROW_PX`; a new
  zero-height row kind joins that list.
- A viewport without a layout box (`display: none` tab, collapsed panel) pauses the
  engine through the scroller's `hidden` prop, fed from the host's `isVisible`: no
  transaction, measurement or `onScroll` until shown, then the kept intent is written.
  A host that keeps a stream mounted off screen must pass it.
- Reading anchors are separate from React row keys: resolve through `anchor.ts`
  rules, never by list index. A row rendering several turns lists the others in
  `groupTurnIds`, or a grouped anchor falls back and can loop with hydration
  ([decision](../../../../../.agents/notes/implemented/bug-fix/2026-10-17-grouped-creation-record-anchor.md)).
- Upward conversation touch input releases follow before the first scroll event;
  post-touch momentum is reader input too. Taps, pinches, horizontal gestures,
  cancelled touches and nested scrolling must not arm conversation momentum.
  Explicit follow navigation supersedes old momentum even without `scrollend`.
- Automatic follow requires conversation input evidence. Elastic offsets are
  sampled in the valid scroll range and must not trigger correction writes.
  Reaching the exact edge preserves native input; near-edge or stale-bottom
  snapping waits for `scrollend`. Outside focus, pointer input and editing clear
  old conversation evidence. Wheel/key input must be able to scroll the viewport
  in its direction; unconfirmed evidence expires 100ms after its first animation
  callback, using the injected frame clock. Body keys
  release follow only after actual viewport movement confirms their routing.
  This expiry only clears input and must never retry layout or write offsets.
  Rationale:
  [bottom ownership](../../../../../.agents/notes/implemented/bug-fix/2026-10-11-mobile-conversation-bottom-ownership.md).
- `keyed-layout/` came from Lody's removed Virtua fork with its tests; engine
  extensions are marked `Engine:`. It is engine-owned: keep its MIT `LICENSE`.
- Change the transaction logic only with a model test in
  `tests/conversation-scroll-engine.test.ts` (seeded sequences included) and, for
  adapter changes, `tests/engine-conversation-scroller.test.tsx`.
