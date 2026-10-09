# Conversation scroll engine: one programmatic writer, reading anchors, committed layout

Status: implemented
Translation: current

[中文](2026-09-27-conversation-scroll-engine.zh.md)

## Abstract

Opening a conversation can still leave the whole pane blank until the reader presses
"scroll to latest", after seven earlier fixes to the same area. Two state machines,
the Virtua fork and `use-sticky-scroll`, both write `scrollTop` and learn about each other
only through asynchronous scroll events. Positions are stored as pixels, compensation is
applied as deltas, and a fail-closed gate hides the pane until the two agree.

This note proposes one conversation scroll engine:

- It is the only programmatic writer, and it owns the scroll extent.
- Its state is the reader's intent, expressed as a semantic reading anchor, and every
  position it writes is derived from an anchor.
- Given a minimum row height (with a bounded set of exempt fixed rows) and
  position-independent row layout, it covers the viewport within a bounded number of
  commits. It never waits for an event and never hides the pane.
- Consumers reach it through a list handle (`ConversationListHandle`).

The engine is implemented and is the only conversation scroller. On 2026-09-27 the
owner chose to ship it directly: no switch, no dogfood phase, and the Virtua path
with `useStickyScroll` is deleted. A jsdom reproduction with browser-ordered events
confirmed the stall on the old path: a cached reading offset combined with rows
expanding above it beyond the overscan. In real Chromium, the engine keeps every frame
covered while opening, wheel-scrolling and switching 3,000-turn conversations.
Unverified at ship time: the desktop app, iOS devices and long-conversation
profiling.

The accepted cost applies only to the private mobile app on iOS: a layout compensation
during a fling ends the fling, on every shipped iOS version. The open-source desktop app
runs on Chromium and is unaffected. Reviews were five rounds with Codex (GPT-6 Astra)
and three rounds with Claude session `dfd4a856`, all on 2026-09-27.

## Problem

### Code-level stall paths

These paths are confirmed by reading the code and by in-memory probes that call the real
Virtua store and `getInitialScrollLayoutBlocker`. There is no browser or desktop capture.
In each path, the pane stays blank only while nothing else commits Virtua state or
scrolls to a different offset. An idle conversation meets that condition.

Shared start: a session reopens with a cached pixel offset (`type: 'offset'`), so the mode
is `free`. The reveal gate (`view.tsx`: `initialWindowReady && initialScrollRestored`)
hides the viewport. "Scroll to latest" sits outside the viewport and stays clickable. Its
presence only shows that the mode is not sticky; it does not by itself prove the cause.

- **A. The reveal check is not re-run by the write-back.**
  1. A Virtua jump, from first measurements or a keyed insertion above the viewport,
     calls `scrollBy(jump)` in Virtua's layout effect (`observer.ts` `_fixScrollJump`).
  2. The resulting observer delivery calls `settleInitialLayout`. It writes the cached
     offset back and *returns without checking the layout* (the
     `cached-offset-reapplied` branch).
  3. The written value equals the offset Virtua still holds, so `writeScrollTop`
     dispatches nothing.
  4. The native event reports that same offset, so `ACTION_SCROLL` ignores it and
     `onScroll` never fires. `handleNativeScroll` treats it as our own write.
  5. Nothing runs the check again.
- **B. The rendered range is frozen.** While `_flushedJump` is non-zero, `$getRange`
  returns the previous range. A same-offset `ACTION_SCROLL` returns before clearing it.
  The next Virtua commit with a zero jump ends the freeze. With the production 800px
  overscan, only a large expansion uncovers the viewport: one row becoming fourteen gives
  `target-unmounted`.
- **C. Revealed but empty.** In reading mode, the blocker only checks that the row at the
  viewport's bottom edge is mounted and measured. A probe with no overscan revealed a
  range with no rows intersecting the viewport.

"Scroll to latest" recovers A and B. It writes a different `scrollTop`, Virtua receives a
differing event, and the follow-mode check passes.

**Correction (2026-09-27, from the jsdom reproduction).** A alone self-heals: a later
geometry delivery re-runs the reveal check, and it passes while the range still covers
the viewport. The persistent blank needs both at once:

- A's write-back hands Virtua a scroll event with the offset it already holds;
- that keeps B's frozen range, and after a jump beyond the overscan the range covers
  no row on screen.

The reveal check then fails for good, and nothing else runs it
(`tests/sticky-scroll-open-stall.test.tsx`).

**The symptom excludes the hydration-window path.** The gate is a conjunction.
- When `initialWindowReady` is the stalled half, "scroll to latest" only enters follow
  mode and the viewport stays hidden.
- The reported recovery is therefore consistent only with a stall in
  `initialScrollRestored`, which narrows the field to A and B.

**A possible third writer exists today (unverified in a browser).** The viewport declares
no `overflow-anchor`; only Virtua's own container sets `none` (`Virtualizer.tsx`).
Inside the viewport, the reply-room spacer and `MessageSelectionOverlay` are siblings of
that container, so they are eligible anchor candidates. When content above grows while
the spacer is visible, Chromium may adjust `scrollTop` itself.

### Why earlier fixes did not prevent it

Related fixes: #674, #695, #856, #888, #896, #940, #945.

- **The hazard was named, but only for after reveal.** The
  [keyed fork note](../../implemented/architecture/2026-09-24-virtua-keyed-fork.md) rejects
  a continuous second writer, because it "would undo a programmatic jump whose scroll
  event has not arrived". The pre-reveal reapplication from #896, carried into #940, is
  exactly that writer, and #945 did not revisit it. #940 and #945 merged on the same day.
- **No test combines the pieces that interact.**
  - The hook tests use a mock handle whose `scrollOffset` maps to the DOM, so Virtua's
    pending-jump state does not exist there.
  - `packages/virtua/tests` has no outside writer.
  - `sticky-scroll-virtua.test.tsx` covers bottom navigation and resize, including a
    non-following reader.

  None of them combines a keyed change before reveal with an own write and a late or
  missing scroll event.
- **The real-browser regression cannot reach these paths and does not run in CI.** Its
  cached-offset case releases a static list in one batch. No workflow runs
  `packages/components/tests/e2e` or builds Storybook.
- **Each fix cleared one blocker; none proved termination.** Eight conditions gate the
  reveal, so any missed wake-up becomes a blank pane that input cannot reach. Scroll
  diagnostics are recorded only in development. The #896 note states that the original
  runtime state was lost.

### Structural causes

| Cause | Consequence seen in history |
| --- | --- |
| Two programmatic writers (possibly three, with browser anchoring), each keeping a private copy of the offset and syncing through scroll events | One cancels the other's pending state (A, B). `scrollToIndex` requests expire after 150 ms (#896). Outline jumps need a correction loop. |
| Compensation applied as deltas | Stacked compensations erased each other in 0.49 (patched). An undone delta freezes the range. |
| Position stored as pixels | A cached offset means different content once sizes change, so a second writer reapplies it. |
| A fail-closed gate on a hidden, input-dead viewport, whose liveness depends on events | Every missed wake-up becomes a blank pane (A, B). The gate's check can pass on an empty range (C). |

## Invariants

Invariants are checked at the commit boundary, against the committed DOM.

- **I1 One programmatic writer and one extent owner.** Only the engine adapter assigns
  the conversation viewport's `scrollTop` and sizes its scroll extent. Browser scroll
  anchoring is disabled on the viewport itself. The browser still moves the position
  through reader input, viewport growth, focus, and selection autoscroll; these are
  observations, not writes.
- **I2 One committed snapshot.** Every cycle ends with one snapshot:
  `{ sourceGeneration, geometryRevision, scrollTop (read back), viewportHeight, extent,
  contentEnd }`. `geometryRevision` equals the revision committed to the DOM. Every
  consumer converts coordinates through this snapshot, through the list handle:
  - the outline;
  - visible-turn reports;
  - selection;
  - the hydration window;
  - cache capture.

  None of them keeps its own copy.
- **I3 Coverage without events.** When a cycle ends, the committed rows cover the content
  part of `[S, S + viewportHeight]`, where `S` is the read-back position the cycle
  accepted into `lastObserved`. Padding, the reply room, and a legitimately empty or
  short conversation need no rows. Coverage holds within at most two passes of at most
  two supplementary commits each, with no timer (see the coverage lemma). A position not
  yet covered is never recorded as accepted, so the scroll event its change queued is
  guaranteed to start a cycle that covers it.
- **I4 Measurements are current by construction.** An observer entry is adopted as a
  measurement only when the row's content revision at delivery equals its current
  revision. In that case commit 0 already carries the new geometry. Otherwise the row is
  only marked dirty and is read after the commit. Resolving one intent against one
  committed geometry is deterministic.
- **I5 Anchor stability when reachable.** In reading mode, the anchor's screen position
  does not change across list and size changes, if the anchor resolves and its target
  lies in `[0, maxScrollTop]`. Otherwise the documented fallback applies. Two cases are
  exempt:
  - reader movement concurrent with a compensation is kept on top of it;
  - during an active scrollbar drag, the thumb maps to an absolute offset and overrides
    compensation, so the anchor drifts, as it does today.
- **I6 Follow.** In follow mode, `scrollTop = maxScrollTop` after each cycle. A
  conversation shorter than the viewport is top-aligned.
- **I7 A readable first frame.** The first painted frame satisfies I3. It is exact when
  the anchor resolves and is reachable, readable otherwise, and never hidden.
- **I8 No inferred intent.** Geometry never releases or re-arms follow. The only
  geometry-driven mode change is the defined hand-off from `sent` to `follow` when the
  reply fills the reserved room. Reader movement re-arms follow when it reaches the
  end: a downward scroll within 4px of the current bottom, or a downward scroll
  sequence that comes to rest (`scrollend`) at a bottom the range had while it ran.

## Proposal

### Responsibilities

| Part | Owns | Does not |
| --- | --- | --- |
| Engine core (pure TypeScript) | Intent, movement classification, anchor resolution, range planning, reply room, glide progress, diagnostics | Read or write the DOM; use timers |
| Geometry (engine-owned) | Sizes and offsets keyed by row key and layout version. Moved in P2 from the fork's keyed list layout. | Scroll; subscribe to events |
| DOM adapter (one hook) | The commit protocol; DOM sampling; observer-entry adoption; the single write in its two forms; imperative extent sizing; dirty marking | Decide positions |
| React list | Rendering the planned range at absolute positions with stable React keys | Scroll |
| Consumers | Everything goes through `ConversationListHandle`: commands, snapshot reads, and the rows that must stay mounted | Touch the viewport or a virtualizer directly |

### The seam: `ConversationListHandle`

Today the outline, visible-turn reports and native selection read `VirtualizerHandle`
directly (`findItemIndex`, `getItemOffset`, `scrollOffset`, `scrollToIndex`, `keepMounted`).
Both implementations satisfy one interface, and `view.tsx` only selects an
implementation by the switch:

- commands: `scrollToBottom()`, `jumpTo(anchor)`, `anchorMessage(messageId)`;
- snapshot reads: the current offset, a row's position, and the row at an offset;
- rows that must stay mounted: a **synchronous input**, not an asynchronous command.
  `use-conversation-text-selection.ts` requires these rows to be committed before
  Virtua's bubble-phase scroll listener runs, and both implementations must keep that
  ordering;
- a visible-turn report callback.

The seam lands first (P1) with the Virtua implementation and no behavior change.

### Extent ownership and layout contract

Rows are absolutely positioned inside a container whose height the adapter sets
imperatively. That height is the scroll extent, like the reply-room spacer today. The
layout contract:

- The container is `overflow: clip` in the block direction, so a row that outgrows it
  cannot add scrollable overflow.
- The **viewport itself** declares `overflow-anchor: none`, which disables browser scroll
  anchoring for the whole scroller. Setting it only on the row container, as Virtua does,
  leaves the reply-room spacer and overlay eligible.
- The viewport keeps `scrollbar-gutter: stable` (`.chat-scrollbar`), so a scrollbar
  appearing never changes row width.
- Conversation rows must not use `content-visibility: auto`. Today nothing in the
  conversation declares it. The contract is guarded by a test, because an earlier
  Streamdown version set it inline on code blocks.
- Two contract tests: the viewport's computed `overflow-anchor` is `none`, and a rendered
  code block's computed `content-visibility` is not `auto`.

Apart from the adapter, only the viewport's height (composer, keyboard, dock) changes the
maximum offset, and the viewport observer sees it.

Every extent change uses one order inside the adapter step:

1. grow the extent to `max(old, new)`;
2. write the target (always `<= newMax`);
3. shrink the extent to `new`;
4. read back and take the snapshot.

The browser therefore never clamps a position because of our own commit, and a growth
cannot clamp the write that needs it. The reply room follows the same order; stale extent
is never counted as reply room.

**Layout independence (a precondition of termination).** For a fixed content revision and
external layout version, a row's height does not depend on the extent, its own `top`, or
which other rows are mounted. Rows keep `contain: layout style` and use no percentage
heights relative to the container. In development, a precondition violation is reported
when a row's measured height changes within one transaction without a content or
layout-version change.

**Minimum row height and the exempt set K.** Every row satisfies `height >= hMin`, except
the rows in `K`. `K` is defined statically by key and holds only the fixed non-turn rows
(`FIXED_ROW_KINDS`): the leading row, the agent-activity row and the trailing row of
pending, not yet committed messages (`view.tsx`). The leading row may be an empty
Fragment that renders no DOM, which the `ai-gui` rules allow. The trailing row is empty
whenever no message is pending, which is most of the time. Placeholder rows
already carry a `minHeight` estimate. In development, any row outside `K` measuring below
`hMin` is reported. Before the default flips, an audit confirms which rows outside `K` can
render near zero height today.

### Reading anchor

The React row key and the reading anchor are separate. In `history-actions.ts`,
`assistant-items` in `replace` mode swaps a turn's whole item array, `remove-turn` deletes
a turn, and `upsert-turn` overwrites one. An item index alone is therefore not an identity.

```ts
type ReadingAnchor =
  | {
      kind: 'turn';
      turnId: TurnId;
      item: { index: number; identity: string | null; itemsRevision: number } | null; // null = turn start
      offsetPx: number;          // pixels into the anchor's row
    }
  | { kind: 'fixed-row'; key: 'leading' | 'agent-activity'; offsetPx: number };
type Intent =
  | { kind: 'follow' }
  | { kind: 'read'; anchor: ReadingAnchor; screenY: number }
  | { kind: 'sent'; turnId: TurnId };
```

`identity` is a stable id where the item has one, such as a tool call id. `itemsRevision`
changes whenever a turn's item array is replaced. Resolution rules:

1. **Same `itemsRevision`, and the item is rendered as its own row:** use that row at
   `offsetPx`, clamped to the row's height.
2. **Revision changed:** find the item by `identity`. If it cannot be found, use the turn
   start with `offsetPx = 0`.
3. **Item folded into a group:** use the group header with `offsetPx = 0`. A 900px offset
   into a long row does not map onto a 32px header.
4. **Turn removed:** the conversation index lists every turn without hydrating it, so a
   removal is known. Use the next surviving turn in the old order, then the previous one,
   with `offsetPx = 0`.
5. **Turn exists but is not hydrated:** the anchor stays pending on the turn's
   placeholder. The placeholder never replaces the anchor. A reader who rests inside a
   placeholder anchors to that placeholder row, at their offset clamped to its height.
   A turn that hydrates under the same key (a user turn) keeps that offset. A turn
   that hydrates into rows with new keys lands on its first row.
6. **`fixed-row`:** a reader resting at the top anchors to the leading row. An
   agent-activity anchor falls back to the last turn when the row disappears; the row
   only appears at the end, where the reader is normally following.

`offsetPx` is a position in pixels. It does not promise the same sentence after a row
reflows above that point.

### Coordinates

```text
rowTop(row)      = contentTop + prefixHeight(row)           // contentTop = top padding + inset
desiredScrollTop = rowTop(anchorRow) + offsetPx - screenY   // clamped to [0, maxScrollTop]
maxScrollTop     = max(0, extent + bottomPadding + replyRoom + contentTop - viewportHeight)
```

- Outline jumps use `screenY = 0`.
- A sent message uses `screenY = topPadding`, where the first row rests.
- Measured sizes are keyed by a layout version: width, font size, font load, and the
  conversation font setting. After a version change, old sizes are only estimates.
- A version change never drops the reading anchor.

### Movement classification

The adapter keeps `lastObserved = { scrollTop, maxScrollTop, geometryRevision }`: the last
position it accepted, whether it wrote that position or adopted it. Each cycle samples the
DOM first. A difference from `lastObserved` is classified as:

| Class | Test |
| --- | --- |
| `own-write` | Equals the adapter's pending write for the current revision. |
| `reader` | There is input evidence (wheel, touch, navigation key, scrollbar drag) and the offset moved. |
| `clamp` | The maximum shrank (viewport growth or overflow change), and the offset equals `clamp(lastObserved.scrollTop, 0, newMax)`. |
| `unknown` | Anything else: focus, selection autoscroll, find-in-page, or a clamp whose intermediate step was not observed. |

Handling by mode:

- **`follow`:** only reader input releases the mode (I8). A `clamp` or `unknown` move is
  resolved back to the bottom. Accepted cost: while following, a browser-initiated move
  away from the bottom is overridden, because following means the reader asked for the
  end.
- **`read`:** a `reader` or `unknown` move is adopted as the new anchor. A `clamp` keeps
  the intent and resolves again, which restores the position once it is reachable. During
  a scrollbar drag, the thumb overrides relative compensation and the anchor drifts,
  which matches current behavior.
- **`sent`:** same as `follow`, except that reader input releases the mode to `read`.

This is an information limit, not a gap in the rules. From final offsets alone, no rule
can both never override a browser-initiated move and never mistake an unobserved clamp.
Extent ownership leaves viewport growth as the only clamp source, and the viewport
observer sees it. The remaining `unknown` cases favor what the reader sees in `read` mode,
and the reader's explicit choice in `follow` mode.

Commands (`scrollToEnd`, `jumpTo`, `anchorSent`) take ownership immediately.

### Write forms

There are two write forms, chosen by the reason for the write, not by whether a scroll
has been observed:

- **Layout compensation** in `read` mode is relative: `scrollBy(delta)`. `delta` is only
  the anchor displacement caused by this cycle's geometry transition. It is applied once
  per geometry revision and never includes reader movement.
- **Navigation** is absolute: follow, `scrollToEnd`, `jumpTo`, sends, glide frames, and the
  initial restore.

If the reader scrolls natively between the cycle's sample and its relative write, the
reader's movement is kept. The read-back step (commit protocol, step 7) detects it and
covers the new position in the same transaction.

Between transactions, a fling faster than the overscan can show unrendered space for one
frame, as with any virtualizer. That cannot persist: the movement queues a scroll event,
the event differs from `lastObserved`, and its cycle adopts and covers the new position.

How the compositor thread interacts with relative writes is a validation item on each
supported platform, not an assumption.

**No deferral in v1: an accepted iOS regression.**
- **Current behavior on iOS.** The fork defers jumps while a scroll is active
  (`store.ts`: `applyJump` adds to `pendingJump` when `isIOSWebKit()`, and `getItemOffset`
  subtracts it). That is an origin shift. It keeps flings intact, but in theory it has the
  negative-direction hole shown in review round 2.
- **v1 behavior.** v1 writes every compensation. On WebKit, a programmatic write ends a
  fling, and every shipped iOS version is treated as behaving this way. This is a
  regression relative to today in exchange for having no hole, and it affects only the
  private mobile app.
- **Why an unconditional deferral was rejected.** Its final position is not
  anchor-derived, and a review counterexample leaves the viewport with no mounted rows.

**A designed extension, decided in P4: defer positive shifts only.** Content growing above
the anchor during a fling is laid out with an origin shift `D > 0`, so the leading rows
sit at negative physical positions. There is no visible hole, and the lemma holds in
shifted coordinates. At `scrollend`, `D` is absorbed as `scrollTop + D`, which is always
reachable. Content shrinking above is written immediately.

Prerequisites:
- `scrollend`, first supported in Safari 26.2; there is no timer fallback;
- a boundary write when the reader reaches the top while `D > 0`;
- `D` carried in the I2 snapshot. Every consumer already converts through the snapshot,
  so adding it is incremental.

P4 decides with device data: the fling-interruption counter (see Diagnostics) and a
dedicated "upward fling through unhydrated history" test. Hydrating placeholders during an
upward fling is the most common compensation trigger.

### Commit protocol and the coverage lemma

Every position the engine produces is anchor-derived:
`S = clamp(rowTop(anchor) + offsetPx - screenY, 0, maxScrollTop)`. Per mode:

| Mode | Anchor | `screenY` |
| --- | --- | --- |
| `read` | the reading anchor | as recorded |
| `follow` | the last content row | its bottom at `V - bottomPadding`. Entering follow clears the reply room, as `enterFollow` does today. |
| `sent` | the sent row | the top padding |
| glide frame | the sent row | eased from its screen position at send time to the top padding |

The glide interpolates `screenY`, not pixels. Each frame resolves
`S(t) = clamp(p_current - screenY(t), 0, maxScrollTop_current)` against the current
geometry. The starting `screenY` is recorded after a pre-jump that brings the row within
one viewport, so `screenY ∈ [-V, 2V]`. The current code allows 1.5 viewports; this is
tightened. A viewport height change re-establishes the bound for the new `V`. When the
reply fills the room, follow's target replaces the sent target in the same cycle.

Each cycle runs these steps in one synchronous transaction, with a fixed content
revision and layout version:

1. Sample the DOM and classify the movement.
2. Plan the range from intent and current geometry. Unmeasured rows use estimates, and
   the selection's must-mount rows are included.
3. Commit (commit 0). Observer entries whose revision matches are already in the
   geometry (I4). Read the current sizes of rows that are still dirty and of newly
   mounted rows.
4. If any size differs from the committed geometry, commit 1 commits the new geometry.
   If the *target* viewport under the new geometry is not covered, the same commit also
   mounts the worst-case window. Read the new rows.
5. If sizes changed again, commit 2 commits that geometry. The window never shrinks
   inside a transaction.
6. Resolve against the committed geometry (`resolvedRevision === committedRevision`) to
   get `S_expected`. Write in the form chosen by the reason, using the extent order above.
   Read back `S_actual` after the extent operation.
7. **Reconcile the read-back.** If `S_actual` differs from `S_expected` and no known clamp
   explains it, the difference is external movement that arrived with the relative write.
   In the same transaction:
   1. classify it as `reader` or `unknown`;
   2. adopt the read anchor from `S_actual`, with `screenY = 0`;
   3. run steps 2–6 once more around it.

   Adoption makes the new position anchor-derived, so the lemma applies to this pass too.
8. Take the snapshot. `lastObserved` is set only to a position whose coverage this
   transaction verified.
   - If a second mismatch arrives in the re-run pass, `lastObserved` keeps the last
     covered position and the transaction ends with `pendingExternalMove` recorded.
   - The offset changed during the task, so a scroll event is already queued (CSSOM
     pending scroll targets). That event differs from `lastObserved`, so it cannot be
     absorbed as a no-op, and its cycle adopts and covers the position.
   - A later event reporting the same offset does not clear `pendingExternalMove`; only a
     cycle that covers that position clears it.

In the browsers we target, main-thread scroll offsets do not change inside one task, so
the re-run should be rare and the second mismatch should not happen. The protocol does
not depend on this.

**Worst-case window.** The anchor row plus `ceil((1 + a) · V / hMin) + |K|` rows on each
side, or up to the list ends. `a` bounds how far `screenY` may lie outside `[0, V]`: `a = 1`
for glide frames and `a = 0` otherwise. Rows in `K` may have zero height, so each side adds
`|K|` rows (`|K| = 3`; `worstCaseWindow` reads it from `FIXED_ROW_KINDS`). The trailing row
joined `K` when #719's pending messages were merged; the argument is the same for any
`|K|`.

**Lemma.** Assume the transaction's content and layout version are fixed, and layout is
position-independent (the layout contract).
- After the last commit, every row in the window is measured and committed, and every row
  outside `K` is at least `hMin` tall.
- The written position is anchor-derived, so `S ∈ [p - (1 + a)V, p + aV]` for anchor
  position `p`. A clamp only moves `S` toward one end of the list.
- On each side of the anchor, the window holds at least `(1 + a)V` of content, or reaches
  the list end. At most `|K|` of its rows can be zero-height, and those are counted in
  addition.

So the content part of `[S, S + V]` is covered.

Measuring rows inside the window changes `p`, but not which rows the window contains, so
no third commit is needed. The reply room and padding lie beyond `contentEnd` and need no
rows.

A reviewer enumerated the static model without `K`: 812,025 cases, and 1,353,375 with a
glide bound of `a = 1.5`. No counterexample was found. This supports the arithmetic; it
does not prove the browser protocol.

**Termination.** A transaction ends after at most two passes, each with at most two
supplementary commits.
- Under the layout contract, the transaction's own repositioning and extent writes change
  no row size.
- An observer marks a row dirty only when its current read differs from its committed
  size, so observer deliveries caused by our own commits are no-ops.
- A new transaction starts only from new content, a layout-version change, input, a
  viewport change, or a command. Each of these causes finitely many transactions.
- The argument does not depend on how often ResizeObserver delivers.
- A development assertion catches layout-contract violations, because they would reopen
  loops.

Supplementary commits use a state update scheduled in the layout effect, which React
applies before paint, or `flushSync` from an observer callback.

**Performance shape.**
- A ResizeObserver-driven transaction, which is the streaming steady state, adopts entry
  sizes without forcing layout.
- Only rows newly mounted by a supplementary commit are read synchronously, in one
  batched read.
- A scroll-driven cycle whose committed geometry already covers the target viewport reads
  only `scrollTop`.
- The worst-case window can mount up to `2((1 + a)V / hMin + |K|)` rows in one frame. For
  `V = 1000` and `hMin = 40`, that is about 54 rows, or about 104 rows for a glide. It is
  expected on first opens with badly wrong estimates.
- The current hook is not cheap either: every geometry callback reads `scrollHeight`, and
  the extent and blocker checks read rects of every mounted row. The baseline must be
  measured, not assumed.

There is no degraded, uncovered outcome. A turn whose data is not ready renders its
placeholder, which is a row like any other.

### Open and restore

Per session, the engine saves `{ formatVersion, intent, sizes by key and layout version }`.
A `sent` intent is saved as `follow`; the current anchored mode already saves
`{ type: 'end' }`.

These caches, like today's (`use-scroll-position-cache.ts`), are module-level in-memory
LRUs. They are not persisted across app restarts, so the format change is not a one-way
migration. Each implementation keeps its own cache keys. After a runtime switch, the
other side's cache may be stale or empty, and the affected sessions open at the end once.

The hydration window is chosen from the restored anchor's turn before the first viewport
report. The tail stays leased, and `factSource ?? view` source fencing is kept.

`initialScrollRestored` disappears. Electron's warm-window reveal waits on
`data-window-session-stream-ready`. That attribute is set only when `initialWindowReady`
holds **and** the first cycle has completed, in the commit that completes it. The window is
therefore never revealed over placeholders, and covered rows are already in the DOM.

### Send, jumps, selection, diagnostics

- **Send:** `anchorSent` reserves the reply room and glides, re-resolving the target each
  frame. It hands off to follow when the reply fills the room.
- **Outline and search:** `jumpTo(anchor)` sets a `read` intent. This removes the correction
  loop and the 150ms request lifetime.
- **Selection:** the selection protocol is kept whole: the interval, content snapshots and
  history leases. Its must-mount rows enter range planning synchronously through the
  handle.
- **Diagnostics:** an always-on ring buffer. It contains no text and is included in bug
  reports. For each cycle it records:
  - source generation and geometry revision;
  - intent kind and movement class;
  - target offset, actual offset, and clamp;
  - supplementary commits used;
  - viewport coverage measured from committed rects;
  - counters for compensation writes during touch momentum, and for how many of them
    ended the fling. A write counts as ending the fling when the next sample shows no
    further movement.

  Violations of I2 and I3 throw in development and tests.

## What is removed and what is kept

**Removed from the conversation:**
- the reveal gate and its blockers;
- cached-offset reapplication and synthetic scroll dispatch;
- Virtua's store, observer, and driver;
- the outline correction loop and `itemOffsetDelta`;
- the pixel position caches.

In P6 the fork also loses its keyed React and store parts (the `keyed` prop,
`ACTION_ITEMS_KEYS_CHANGE`, the key plumbing in `useChildren`). The keyed layout itself
moved into the engine in P2.

**Kept:**
- the follow, read, and sent semantics, and input evidence;
- the glide and the reply room;
- the hydration window policy and source fencing;
- placeholders and the selection protocol;
- keyed size bookkeeping, now engine-owned;
- per-session caches, now versioned.

## Alternatives

- **Patch the current pair:** clear the freeze on same-offset scrolls, re-run the check
  after a reapply, and always notify Virtua. This repairs only A and B. The owner declined
  short-term patches on 2026-09-27.
- **Change the fork's core, or export its keyed layout for the engine.** Rejected: the
  engine needs layout-versioned sizes, which fit better in engine-owned code than in more
  `Lody:` markings on a fork that `VList` consumers want close to upstream.
- **Rewrite the geometry from scratch:** the keyed layout is pure and tested; the engine
  moves it with its tests instead.
- **Shift the layout origin in both directions during momentum:** withdrawn. A negative
  shift opens a reachable blank hole and can require an unreachable offset (review round 2).
- **Defer every compensation during momentum:** withdrawn. The deferred position is not
  anchor-derived, and a counterexample leaves the viewport with no mounted rows (round 3).
- **Defer positive shifts only:** not rejected; designed above and decided in P4.
- **TanStack Virtual:** it compensates by delta and does not anchor insertions in the
  middle of the list (#945).
- **Normal-flow virtualization with native `overflow-anchor`:** WebKit support is not
  established here, and the anchoring heuristics are outside our control.
- **Keep the gate and add a liveness timer:** this contradicts the timer-free rule and only
  bounds the symptom.

## Verification plan

1. **Reproduce first, against the real code.** jsdom tests with the real hook and real
   Virtua that end hidden through path A, and through path B with production overscan,
   plus a relative write whose read-back includes concurrent movement followed by
   same-offset events. They are the engine's acceptance tests, marked expected-to-fail
   until the switch flips.
2. **Model tests on the engine core, with a simulator that implements the specifications
   literally:**
   - writes clamp to the current range at the moment of the write;
   - `scrollBy` adds to the current value;
   - each target queues at most one scroll event per rendering update;
   - a write inside a scroll handler queues an event for the next frame;
   - the scroll steps run before ResizeObserver in HTML's "update the rendering";
   - observers deliver only on size change.

   Notifications are never dropped when a real state change happened. Trajectories:
   - a write while the old extent is committed;
   - `A → B → A` within one task;
   - same-value writes;
   - coalesced notifications;
   - a clamp reported before its size change;
   - a clamp whose maximum recovers before sampling;
   - focus landing exactly on the new maximum while the old position is still valid;
   - a native scroll applied but not yet dispatched;
   - input with no movement, followed by streaming and a `scrollToEnd`;
   - a relative write whose read-back includes concurrent reader movement;
   - **a scrollbar drag while content grows above**;
   - measurements that change geometry while coverage still holds;
   - repeated content updates of one node;
   - item replacement, turn removal, and a long row folded into a short header;
   - zero-height `K` rows;
   - tiny and oversized rows, edge clamps, and source switches.

   Every step checks I2–I6 and I8, the lemma's commit bound, and the absence of
   self-sustaining cycles.
3. **Adapter tests** in jsdom: the commit protocol, extent ownership, dirty marking,
   observer-entry adoption, source fencing, and synchronous must-mount ordering.
4. **Contract tests:**
   - the viewport's computed `overflow-anchor` is `none`;
   - a rendered code block's `content-visibility` is not `auto`;
   - rows outside `K` measure at least `hMin`.
5. **Browser tests that observe the process**, parameterized over both implementations.
   They record the first painted frame, committed row rects against the viewport, the
   anchor's screen position, and every programmatic write. Cases:
   - paths A–C;
   - a last cycle after which no event is ever delivered;
   - an undelivered native scroll;
   - a disappearing anchor;
   - a selection spanning rows;
   - width and font changes.
6. **Acceptance** in the desktop app, plus iOS devices (see the acceptance checklist).

## Migration

Each phase merges and reverts independently.

| Phase | Content | Product behavior |
| --- | --- | --- |
| P0 | A time-boxed live confirmation with `localStorage['lody:debug-scroll']='1'` and `__lodyScrollLog.dump()`. The last `reveal-blocked` distinguishes A (`cached-offset-reapplied`), B (`target-unmounted`), and the excluded hydration path (`initialWindowReady: false`). jsdom reproductions (verification step 1), marked expected-to-fail. Neither blocks later phases. | Unchanged |
| P0.5 | The components e2e suite joins PR CI: Storybook build plus Playwright in **its own runner job**, because runners are 4-vCPU and CPU-bound. It is path-filtered to the engine, `hooks/`, `components/ai-gui/`, hydration and row building, Markdown and typography styles, `packages/virtua`, and the specs and stories themselves. It starts with the scroll-related specs. This lands before P1, so the seam refactor has browser coverage. | Unchanged |
| Before P1 (recommended; the owner decides) | Two contract fixes with their tests: viewport-level `overflow-anchor: none`, and the `content-visibility` contract test. These are independent defects, not the declined blank-pane patch. | The first changes browser anchoring |
| P1 | The `ConversationListHandle` seam with the Virtua implementation. `view.tsx`, selection, and the outline go through the handle. | Unchanged |
| P2 | The pure engine core and the literal-spec simulator. The fork's keyed layout moves into the engine with `list.spec.ts` and `tests/keyed-list.test.ts`, unchanged and green there first; the layout-version extension comes after. The fork's keyed layout is **frozen** from P2 through P5. | Unchanged |
| P3 | The DOM adapter and list implementing the handle, behind a settings atom. It follows the existing pattern of a beta switch shown under `developerModeEnabledAtom`, and is off by default. e2e runs against both implementations. | Unchanged by default |
| P4 | Internal dogfood with the switch on, for at least one week, collecting the ring buffer. The positive-shift deferral is decided with iOS device data. | Internal only |
| P5 | The default flips through a build-time default constant for the atom. The old path stays for at least one full release. Rollback is changing the constant and releasing, or users turning the setting off. | Changes |
| P6 | Delete the old path. Update the hooks and `ai-gui` `AGENTS.md` rules, the warm-window contract, and [conversation scroll](../../../../specs/conversation-scroll.md) (as `draft`). Remove the fork's keyed React and store parts, shrink its README "Changes from upstream", and check each remaining `Lody:` marker. | Cleanup |

The current failure remains until P5.

### Acceptance checklist for flipping the default (P5)

1. **Automated tests, green in PR CI:**
   - the P0 reproductions pass on the engine and fail on the old path;
   - the simulator suite over a fixed seed set;
   - adapter tests;
   - contract tests;
   - the components e2e (hydration, selection, outline, send, process-observing cases)
     for both implementations;
   - the behavioral cases of `use-sticky-scroll.test.ts`, ported to the handle, pass on the
     engine.
2. **Manual, platform × scenario:**
   - Platforms:
     - macOS desktop: trackpad momentum, mouse wheel, scrollbar drag;
     - Windows: mouse wheel;
     - web: Chrome and Safari;
     - iOS: the minimum supported version and the latest, on real devices.
   - Scenarios:
     - reopen at the end and mid-history;
     - cold start;
     - open during streaming;
     - send glide;
     - outline and search jumps;
     - selection across rows, and copy;
     - composer resize and keyboard;
     - width and font changes;
     - warm-window reveal;
     - **on iOS, an upward fling through unhydrated history**.
3. **Performance, against the old path on the same machine and data:** a 2,000-turn
   synthetic conversation (the window-bootstrap benchmark) and one real long
   conversation.
   - Open-to-first-paint p50/p95 no more than 10% worse.
   - Streaming frame-time p95 no worse.
   - Forced layouts per steady streaming frame at most the baseline.
   - Worst-case-window activations recorded, and absent from steady streaming.
4. **Dogfood diagnostics:**
   - zero I2/I3 violations;
   - zero residual `pendingExternalMove`;
   - fling-interruption counts reviewed for the P4 decision;
   - no new internal blank-pane reports.

## Open decisions

- **iOS fling interruption (private mobile app only).** Whether v1's accepted regression
  stands, or the positive-shift deferral ships. It is decided in P4 with the interruption
  counter and device testing. `scrollend` (Safari 26.2) is the only version line that
  matters for the extension.
- **Contract fixes before P1:** whether they ship alone first (recommended).
- **Zero-height audit** of rows outside `K`, before P5.
- **Pixel or semantic position** for `offsetPx` after a reflow. The proposal uses pixels.

## Implementation status (2026-09-27)

**Shipping decision.** Phases P0 to P3 were first built with the engine behind a
Developer-mode switch. The owner then chose to ship directly. The switch, the Virtua
scroller, `use-sticky-scroll.ts`, `sticky-scroll-dom.ts`, `use-scroll-position-cache.ts`
and their tests are deleted, so there is no in-app rollback: reverting means a release.
The P4 evidence (iOS fling interruption, the zero-height audit, profiling) is now
collected after release, through the diagnostics below.

**Implemented (P0 to P3, the two contract fixes, and the removal):**
- **P0.** The jsdom reproduction of A+B against the real hook and real keyed Virtua,
  with the frame harness `tests/support/scroll-frame-harness.ts` (scroll events and
  ResizeObserver deliveries in browser order). A small expansion self-heals. A
  fourteen-row expansion stays hidden with no on-screen row mounted until "scroll to
  latest".
- **P0.5.** A CI job, *Conversation browser tests*. It runs the hydration spec and the
  engine spec on one worker whenever the components test group runs. It is not part of
  the required *Tests* check yet. The native-selection spec is left out: its test "finishing a
  selected turn keeps its prose mounted" fails on unchanged `main` too (3 of 3 runs). A
  streaming spec is timing-sensitive under load.
- **Contract fixes.**
  - The viewport declares `overflow-anchor: none`.
  - A contract suite, `tests/conversation-viewport-contract.test.tsx`, asserts it for
    both implementations. It also checks that the engine never hides the viewport and
    that static and streaming code blocks carry no `content-visibility: auto`.
- **P1.** `ConversationListHandle` and `ConversationScrollerProps`
  (`components/ai-gui/conversation-list/`).
  - The outline, visible-turn reports and native selection go through the handle.
  - The handle's `findItemIndex` is the only list read the selection hook needs.
  - While both implementations existed, a Virtua scroller held the previous code
    unchanged behind the same handle. The browser specs showed no regression
    (below). It was deleted with the rest of the old path.
- **P2.**
  - The engine core: `lib/conversation-scroll/controller.ts`, `geometry.ts`,
    `anchor.ts`, `saved-state.ts` and `types.ts`.
  - The keyed layout, moved with its tests. They passed unchanged before the `Engine:`
    extensions: per-row estimates and `$invalidate`.
  - The model tests with the simulator `tests/support/scroll-engine-sim.ts`: scenarios
    plus 40 seeded random sequences, checking coverage, follow, anchor stability and
    the commit bound.
- **P3.**
  - `EngineConversationScroller`: the React adapter.
  - Rows carry engine metadata built from `ChatVirtualRow`.
  - The hydration window loads the restored anchor's turn before the first viewport
    report, in `SessionChatStream`.
  - The row component types (`ConversationRowComponentProps`) belong to
    `conversation-list/`. The conversation no longer imports `@lody/virtua`.
- **The fork is removed.** Without the conversation, nothing passed `keyed`: sizes by
  key live in the engine's copied `keyed-layout/`, and the reading anchor replaced
  Virtua-side anchoring. After formatting, the fork differed from upstream 0.52.7 only
  in the keyed changes, so `packages/virtua` is deleted and the two `VList` users
  (paged file viewer, project settings) depend on upstream `virtua` 0.52.7. Virtua's
  MIT license moved to `keyed-layout/LICENSE`.
- **Found while removing the old path.** A range starting at a zero-height row skipped
  the other zero-height rows on the same line, such as an empty leading Fragment. The
  range start now walks back over them.
- **Outline jumps landed rounds past their target (found in staging testing).** The
  Virtua-era correction loop in `view.tsx` was still running. On `scrollend` it
  re-issued a jump by the row index stored at click time. Once placeholders around
  the target had expanded, that index pointed at a different round: jumping from
  round 400 to 410 landed on 420. The design already removes the loop, because the
  reading anchor keeps the jumped row at the top. It is now deleted, together with
  the follow suppression it carried. A Chromium spec clicks far, near and back and
  checks each round lands within 1px, with the outline highlighting it.
- **Found in PR review (#1071, Claude session `dfd4a856`).**
  - **A reader resting inside a placeholder was pulled to its turn's top.** Reader
    movement anchors to whichever row is under the top line, placeholders included. The
    resolver's same-key fast path skipped placeholders, though, so the anchor fell to
    rule 5 at offset 0. The next transaction then wrote `scrollBy(-offsetPx)`, and every
    wheel step that stopped on unread history jumped up by up to a placeholder's height.
    A user row's anchor, once its turn was evicted, did the same, because the
    placeholder shares the turn's key. The fast path now accepts a same-key placeholder
    and clamps the offset to its height.
    - Model tests cover resting in a placeholder with no write, same-key and new-key
      hydration, eviction and rehydration, and a wheel walk through mixed turns. The walk
      asserts that the row under the top line moves by exactly each step. Three of them
      fail with the old fast path.
    - The Chromium wheel test asserted blank frames only, so it could not see a position
      error. It now also checks that the top row moves by exactly the wheel's distance at
      each settled step. It still passes with the old fast path, because the story's
      window hydrates rows before the wheel comes to rest. The model tests are the
      regression guard for this bug.
  - **Reader-input coverage was deleted with the old hook, not moved.** The adapter tests
    now dispatch real events and assert the mode and the position:
    - an upward wheel releases follow;
    - a nested scroller, a downward wheel or a pinch zoom does not;
    - upward keys release follow, except in editable fields or from controls outside the
      list;
    - an upward move with no pointer or touch returns to the end, while one under a held
      thumb or a touch pan releases;
    - a suppression releases follow at the next change.

    Removing each listener behaviour makes its test fail.
  - **StrictMode.** The unmount cleanup disposed the controller for good, but StrictMode's
    development remount runs the cleanup and then the setup again on a live component.
    The setup now calls `resume()`, and a StrictMode adapter test covers it.
- **Fast flings stopped short of the end while a reply streamed (found after release,
  2026-09-29).** Rows that stream in while the reader is above are never mounted, so
  the range below is estimated and usually too short. A fast downward fling mounts and
  measures them on the way, and the engine grows the range, but the compositor clamps
  the fling against the range of the last frame it received. When the main thread is
  behind, as during streaming, the fling dies at that stale bottom. The next scroll
  event then sees a bottom that has already moved, so the 4px re-arm rule never
  matched. The reader was left reading, up to a screen short of the end, while the
  output kept growing below. The engine now records every bottom the range had during a
  scroll sequence. When a downward sequence comes to rest at one of them, it re-arms
  follow and moves to the real end.
  - A model test reproduces the stale bottom; it fails on the old rule. A second test
    keeps a downward scroll that rests anywhere else in reading mode. The seeded
    sequences gained a "scroll down and come to rest" step. That step exposed an
    over-strict I5 check: a clamped reading position moves toward its anchor once it
    becomes reachable (see `read` handling above), so I5 now applies only to positions
    that were resolved before the change.
  - In the real desktop, driven by compositor fling gestures during a streaming
    reply, 3 of 16 fast flings on the old build stopped at a stale bottom and stayed in
    reading mode; all 32 on the fixed build ended at the end, following. The race
    depends on how far the main thread falls behind (one old-build run of 8 hit it
    zero times), so the model test is the deterministic guard.
- **Tests that relied on the old path.**
  - The hydration e2e's cold-tail tests asserted that the viewport stays hidden until
    rows are measured. They now assert the tail, or the saved reading row, is in place
    before any row observation arrives.
  - The activity tests mocked `Virtualizer` away. They now arm a row the way a
    pointer does before opening its overlays.

**Deviations from the design above:**
- **Item revisions are not tracked.** History data carries no items revision, so an
  anchor records the row key (tried first), the item index and a tool-call id as
  identity. When a turn's items are replaced, a text item at the same index is taken
  as the same item.
- **Row measurements.** An observer delivery marks rows whose size differs as dirty.
  The cycle then reads current sizes, inside the observer callback where layout is
  clean. Rows mounted by a commit are read in its layout effect.
- **Layout version.** It is the width plus the conversation font setting. Font loads
  are not tracked separately.
- **Minimum row height.** `hMin` is `ENGINE_MIN_ROW_PX = 20`. A row outside the fixed
  rows that measures lower is reported in development only.
- **Diagnostics.**
  - Every cycle goes to an always-on ring buffer, `window.__lodyScrollEngineLog.dump()`.
  - Uncovered cycles and cycles with a pending external move are also appended to the
    session render trace, which crash-report copies include.
  - At each `scrollend` after a touch fling, the momentum counter (compensation writes,
    and how many of them ended the fling) goes to the same trace.
  - Ordinary bug reports do not carry either yet.

**Evidence (executed):**
- Components suite: 530 files pass after the seam refactor. Added suites:
  - `conversation-scroll-engine.test.ts`: 52 tests;
  - `engine-conversation-scroller.test.tsx`: 3;
  - `sticky-scroll-open-stall.test.tsx`: 2;
  - `conversation-viewport-contract.test.tsx`: 5;
  - the keyed layout suites: 14;
  - a focus test in `conversation-view-hooks.test.tsx`.
- Real Chromium, `tests/e2e/conversation-scroll-engine.spec.ts` (3 pass):
  - opening a 3,000-turn conversation;
  - 30 upward wheel steps (coverage only; the position check came after review, see
    above);
  - switching between two warm 3,000-turn conversations and back.

  Every animation frame had a row under every sampled line, and the switch restored
  the same top row within 2px. A negative control ran the same sampler on the Virtua
  path: it recorded 22 blank frames while that path kept the viewport hidden.
- Existing Virtua-path browser specs, on one worker: 12 pass and 1 fails on this
  branch; 11 pass and 2 fail on unchanged `main`, with the same selection test in both.

**Remaining:**
- After release: read the momentum counts and the diagnostics, decide on the iOS
  positive-shift extension, audit rows below `ENGINE_MIN_ROW_PX`, and profile long
  conversations.
- The Spec is revised as `draft` (restore by row; never blank on open).

## Hidden viewports (2026-09-29)

**Failure.** 0.101.0 crashed with React #185 in the `SessionChatStream` boundary. The
report's render trace showed `scroll-engine <tab> commit covered=false … ×51` for the
child tab the user had just left, within about 50ms of the navigation. The same burst
had appeared the first time that tab was hidden.

**Cause.** Inactive child tabs stay mounted under `display: none`
(`session-detail.tsx`). A viewport without a layout box reads every offset and size as
0 and drops writes. The adapter still ran a transaction after every commit. Its write
was dropped, but `writePhase` clamped the expected offset to the hidden range, so it
accepted `0` and reported `onScroll(0)`. That offset fed the view's position-derived
state: the top fade, the outline index, and the visible-turn report that moves the
hydration window. Those updates run inside a layout effect, so the list committed
synchronously and reported 0 again. Most tabs reached a fixed point within about
three commits. This one did not. The anchor ↔ hydration flip described in the
scroll-repro notes is the likely driver, but it was not reproduced with synthetic
data.

**Decision.** A hidden viewport pauses the engine. `SessionChatInterface.isVisible`
flows through `SessionChatStream` and `SessionChatStreamView` to the scroller's
`hidden` prop, which calls `controller.setHidden` during render. While hidden:

- `afterCommit` records the committed plan but opens no transaction;
- scroll events, row and viewport resizes, commands and glides are ignored, and a
  glide in flight is cancelled;
- the intent (follow, read anchor, sent) is kept, so a command issued meanwhile
  takes effect when the tab is shown;
- sizes are not measured, so no zero heights enter the geometry.

The first transaction after showing (`reshow`) refreshes the viewport, treats the DOM
offset as not the reader's (the browser may have dropped it), and writes the kept
intent absolutely. `lastObserved` is not reset, so `scrollOffset` keeps its last real
value while hidden. A list mounted hidden completes its first cycle only when first
shown. Warm-window reveal is unaffected, because it only waits for the visible target
stream.

**Alternatives.**

- _Detect the missing box from the DOM_ (`getClientRects()`, `offsetParent`). It
  would cover hosts that forget the prop. But jsdom reports every element as boxless,
  so every test that relies on a completed first cycle would stall. It also contradicts
  the repository rule that hidden work follows effective visibility.
- _Damp the consumers:_ report only changed offsets, or bound the hydration feedback.
  Either removes one driver while the engine keeps inventing positions for a viewport
  that has none.

**Tests.** Model: `hidden viewport` in `tests/conversation-scroll-engine.test.ts`.
The simulator models `display: none` (zero reads, dropped writes, a lost offset). A
hidden reader and a hidden follower both report nothing, write nothing, and show again
at the anchored row or at the real end of what streamed meanwhile. Adapter: in
`tests/engine-conversation-scroller.test.tsx`, a view whose state flips at offset 0
reproduces "Maximum update depth exceeded" without the pause and passes with it.

## Evidence

- Code:
  - `packages/components/src/hooks/use-sticky-scroll.ts`, `sticky-scroll-dom.ts`,
    `use-scroll-position-cache.ts`, `use-conversation-text-selection.ts`;
  - `packages/components/src/components/ai-gui/view.tsx`, `assistant-turn-render-blocks.ts`;
  - `packages/virtua/src/core/store.ts`, `observer.ts`, `layouts/list.ts`,
    `src/react/Virtualizer.tsx`;
  - `packages/shared/src/session-data/history-actions.ts`;
  - `apps/electron/src/renderer/src/warm-window-reveal.ts`;
  - `packages/components/src/tailwind/index.css` (`.chat-scrollbar`).
- Executed probes (fixed row heights; not browser reproductions):
  - The author session's (`5d8fa2ca`) store-level probe used 100px keyed rows and a 300px viewport at offset 500, with no
    overscan. A same-offset scroll leaves the range at `[8, 10]` while the viewport shows
    `[5, 7]`.
  - Codex's probes with the real blocker function:
    - one row to four, no overscan: `null` with zero intersecting rows (path C);
    - one row to four, 800px overscan: `null` with three intersecting rows;
    - one row to fourteen, 800px overscan: `target-unmounted`.
  - Codex's in-memory counterexamples behind the round 2–4 changes:
    - the origin-shift hole;
    - a measured set that grows but still does not cover the viewport;
    - a write before the geometry commit;
    - the uncovered deferral;
    - extent growth after the write;
    - layout-dependent row heights;
    - a read-back that absorbs concurrent movement.
  - Codex's enumeration of the static lemma: no counterexample in either run (case
    counts under Coverage lemma).
- External checks by Claude session `dfd4a856`:
  - `@lobehub/streamdown@1.4.0` (pinned in `packages/components/package.json`): a grep of
    the package tarball's `dist/` for `content-visibility` and `contentVisibility` has no
    hits. #1002's removal of the old override was therefore correct, and there is no
    current regression.
  - `https://webkit.org/blog/18325/webkit-features-for-safari-27-0/` mentions no fix for
    programmatic scrolling interrupting momentum. An earlier citation of such a fix was
    removed.
  - caniuse, `scrollend` event: first supported in Safari 26.2, desktop and iOS.
- Executed after implementation: see Implementation status.
- Reviews on 2026-09-27: Codex (GPT-6 Astra), session
  `0bc8379d-78b4-4a13-bee7-4ec862c9bf52`, five rounds; Claude session `dfd4a856`, three
  rounds.

## Touch input and delayed scroll delivery (2026-10-07)

A model reproduction found that an upward offset first observed after `touchend` was
classified as unknown: follow wrote the bottom back on every native step. The adapter
also waited for an offset before releasing follow, allowing a streaming commit to
overwrite a pending touch scroll. This violates the existing reading contract and is
separate from the accepted WebKit compensation cost above.

The adapter now releases on single-touch upward conversation input, checking the
final touch position as well as move events. Nested scrollers, taps, horizontal input,
pinches and cancellation do not arm conversation momentum. The controller recognizes
post-touch momentum during scroll and resize sampling; a new touch, cancellation,
`scrollend`, or entering follow supersedes the previous evidence. No timer, delayed
compensation or extra scroll writer was introduced.

The existing model and adapter suites reproduce four failures on the old code and
pass with the fix. They cover continuous momentum, new output while reading, returning
to follow and non-scroll touches; the model retains its 40 seeded sequences. The two
suites and keyed-layout suites pass 102 tests; scoped strict type and lint checks pass.
Full-package checks are blocked by missing dependencies and outdated borrowed workspace
packages. Validation uses synthetic events and simulated layout, not an iOS compositor.
Real-device verification remains open; layout compensation can still interrupt an iOS fling.
