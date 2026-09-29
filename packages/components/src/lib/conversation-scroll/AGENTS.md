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
- A transaction ends within two passes of at most two supplementary commits;
  `lastObserved` records only covered positions. Never add timers, frame retries or a
  hidden/reveal gate; the viewport is never hidden.
- Keep the layout contract: viewport `overflow-anchor: none` and
  `scrollbar-gutter: stable`; rows container `overflow-y: clip`; no row may use
  `content-visibility: auto` or size itself from the container or its position. Rows
  outside the fixed rows (`FIXED_ROW_KINDS`) stay at least `ENGINE_MIN_ROW_PX`; a new
  zero-height row kind joins that list.
- Reading anchors are separate from React row keys: resolve through `anchor.ts`
  rules, never by list index.
- `keyed-layout/` came from Lody's removed Virtua fork with its tests; engine
  extensions are marked `Engine:`. It is engine-owned: keep its MIT `LICENSE`.
- Change the transaction logic only with a model test in
  `tests/conversation-scroll-engine.test.ts` (seeded sequences included) and, for
  adapter changes, `tests/engine-conversation-scroller.test.tsx`.
