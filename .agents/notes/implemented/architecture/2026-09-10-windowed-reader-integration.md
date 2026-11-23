# Windowed conversation reads

Status: implemented
Translation: current

[中文](2026-09-10-windowed-reader-integration.zh.md)

## Abstract

Opening a session uses a control-plane Mirror and one reader-backed
ConversationView. Directory rows are shallow; only leased or retained tail
bodies are materialized. Snapshot decoding and the initial directory still
scale with the whole conversation.

The existing HistoryWriter remains the single writer. Shared planners retain
permission, agent-output, import and editable-tail rules. Stored-copy handles
reuse the writer's provenance; they survive source disposal during a fork.

View events are structure changes or explicit changed turn ids. Derivations
invalidate evicted facts too. Async cache reads retain identity/epoch fences.
Storage and view events share structure/changed-id semantics. Goal, permission,
scheduling and file-diff consumers share one reference-counted fact table.
CLI reads are synchronous over the same storage reader; auto-seen reads only
shallow fields and permission decisions are checked before auto-approval.
Ordinary commands throw writer errors; only import and editable-tail replacement
retain phased outcomes. The array adapter serves static sharing pages. There is
no alternate session view, feature switch or complete memory command backend.

## Evidence boundary

Reader, writer and CLI regressions use synthetic Loro fixtures. The component
benchmark measures the shipped reader. Device-scale cold-open, streaming frame
time and long-session JS/WASM memory remain separate acceptance work.

## Initial viewport measurement

The first range promise only establishes data availability. Setting `scrollTop`
to the estimated end does not establish that Virtua has mounted and measured the
destination rows. Revealing at that point exposed an empty or intermediate window.
The viewport now waits for the measured destination, visible row geometry and
Virtua's observed offset to agree; mounted-row measurements also correct following
before deferred spacer resizes. Corrections use the sticky library's setter so
layout changes do not masquerade as upward user scrolling. There is no settle
sleep, and later window hydration does not hide the viewport again.

A browser regression holds the real destination-row ResizeObserver delivery:
the previous hook reveals while held; the fixed hook stays hidden and opens at
the measured tail after release, including remount. Unit coverage retains cached
reading positions, user escape, composer resize suppression and row growth.

### Projection refresh after reveal

Accepted-history reconciliation can replace a display wrapper without changing
its underlying conversation. Resetting initial readiness on wrapper identity made
an already visible chat hidden again while the replacement lease settled; it also
reset the reading window to the tail. Readiness and the visible range now belong
to `factSource ?? view`, while leases still target the current projection. A new
source resets readiness even when its session id is unchanged. Caching readiness
by session id alone would incorrectly reveal a replacement document before loading.

The [hook regression suite](../../../../packages/components/tests/conversation-view-hooks.test.tsx)
holds replacement range promises explicitly and checks visibility and retained
off-tail hydration across repeated projection refreshes and removal. The visibility
assertion fails on the previous implementation. The existing source-replacement
regression also covers both pending and previously revealed sources.
[RefreshAcceptedHistory](../../../../packages/components/src/stories/ConversationViewStream.stories.tsx)
exercises the real list over 3,000 synthetic turns. In the production browser probe,
three refreshes previously each toggled visibility; after the fix none did, and row
count, scroll offset and height stayed unchanged. The 37 focused hook/scroll tests,
component typecheck and production Storybook build pass. This repairs a demonstrated
re-hide path; it does not establish that every reported post-open flash has this cause.

## Cold virtualizer blank on open

Waiting for the measured destination hides the viewport, and a virtualizer that
has never measured this session needs several commits to reach it: the first
layout uses estimated row heights, so the restore offset is written into a
total height that is wrong by a few percent, and the correction only lands once
the first rows are measured. A 3,000-turn conversation therefore showed an
empty pane for roughly 55 ms per open on a production build, and proportionally
longer on a slower machine — the reported flicker.

Removing the visibility gate does not remove it. Ablation kept the pane visible
and the row set still went empty before it refilled, now also exposing the
uncorrected scroll position. The cost is the cold layout, not the gate.

Virtua's row measurements are now cached per session alongside the reading
position and handed back through `Virtualizer.cache`, so a reopen lays out at
the real height and reveals a commit earlier. The snapshot is positional, so it
is only restored when the row count is unchanged; a conversation that grew
while it was closed starts cold. Measurements are stored when the initial
layout settles and after scrolling stops, never at unmount — React detaches the
virtualizer ref before cleanup effects run. A session opened for the first time
is unaffected, and the remaining blank is the one commit Virtua needs before it
knows its viewport size.

The snapshot is consumed on the first render that actually mounts the
virtualizer, not the first render with a positive item count. A session whose
document is still being acquired renders the empty sentinel and returns before
`Virtualizer` mounts, yet every hook above that return has already run, and the
always non-null leading fragment counts as one row. Keying the read on the item
count alone therefore answered for a one-row list and never asked again for the
real conversation, leaving the flash in place on the shipped path while the
synthetic story — which passed no leading content — still improved.

Measured on the production Storybook build over two warm 3,000-turn
conversations, with the story rendering the empty state and a non-null leading
fragment as the session page does: 54 ms blank before, 57 ms with the snapshot
read ungated, 17-35 ms once it waits for real rows. The first, uncached open is
unchanged. `e2e/scripts/capture-conversation-open-flicker.mjs` samples the pane
every animation frame and is how those numbers are taken.
