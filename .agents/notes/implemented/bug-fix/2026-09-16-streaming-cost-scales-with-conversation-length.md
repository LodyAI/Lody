# Streaming cost scaled with conversation length, not with what changed

Status: implemented
Translation: current

[中文](2026-09-16-streaming-cost-scales-with-conversation-length.zh.md)

## Abstract

After windowed reads shipped, users reported the renderer becoming unresponsive on
long conversations. The window was not the problem: a content notification reported
the span between the lowest and highest position it touched and named every turn id
inside it, so one synced batch carrying an early status write alongside the streaming
tail told the display cache that the whole conversation had changed — measured at 996
directory rows and 997 turn bodies re-read, about 1.2 s of main-thread CPU, for a
single token delta on a 1,000-turn conversation. Notifications now carry the exact
touched positions, the cache invalidates only the ids the reader named, and four
whole-conversation costs that ran per frame or per open were made incremental or
deferred. The same delta now re-reads two rows and two bodies. Total work for the
shared fact table is unchanged — it still materializes every turn once per session —
so a first open on a very long conversation is improved but not solved; that needs
facts to move into write-time metadata.

## The reported symptom and what it was not

The report was "the renderer freezes easily on the latest version, 0.93.3 was fine".
0.93.3 and 0.94.0 differ by the windowed conversation read. Two plausible causes were
ruled out first: Electron is unchanged across the two releases (`^39.2.6`), and a
pure tail delta — a token arriving with nothing else in the batch — already cost 7-9 ms
and still does. The regression only appears when a batch carries more than the tail.

## Root cause: a sparse change reported as a dense range

`changeRangeOf` in the Loro session adapter reduced a batch to `[min(position),
max(position) + 1)` and `observe` then read every id in that range. A batch that
touched positions 4 and 999 named 996 turns. The display cache merged its refresh
targets the same way, so two independent notifications arriving before one flush
produced the same span.

The cache then re-read the whole directory for that span and, for every hydrated row
in it, re-materialized the body. That second amplification had its own cause:
`rowChanged` compared `itemCount` and `planCount`, which a container-backed directory
row deliberately never carries, against the real counts a hydrated row holds. The
comparison was `42 !== undefined` on every refresh, so every hydrated row reported a
change, bumped its content epoch and was re-read. Of the 140 bodies re-read in the
smaller reproduction, 2 had changed.

Bumping those epochs also cancelled in-flight reads for turns nothing had touched.
A 300-turn window lease taken while such batches arrived every 5 ms took 1,890 ms and
performed 3.5 body reads per turn; the 5 ms interval fired 4 times in that window,
which is the unresponsiveness the report describes.

## What changed

- A content batch reports its exact positions. Structural batches keep the
  shifted-suffix range they need, because later positions really did move.
- The view tracks content targets as the reported ids, resolves their positions at
  flush time, and refreshes them in contiguous runs. A content refresh that finds the
  length changed escalates to a structural re-key rather than splicing rows from a
  sparse read.
- Body invalidation follows the reported ids, never the directory diff: a directory
  row cannot tell whether a body changed, since a grown text item moves no scalar.
- `rowChanged` compares counts only after the refresh has carried forward the ones it
  cannot supply, and an unchanged row keeps its object — placeholder items and Virtua
  rows key on that identity, and replacing it defeated their caches.

Four costs that scale with turn count were addressed alongside it:

- A user turn's send configuration projected eagerly on every directory row. The
  projection is a schema parse per turn while `resolveSessionConversationConfig` reads
  the newest source and walks older ones only until it finds an explicit Role, so it
  is now deferred and memoized at each hop that used to force it. Full directory read:
  4,000 turns 728 ms to 264 ms.
- The shared fact table discarded its facts on the last consumer release, so reopening
  a session tab re-materialized every body to rebuild them. It is now held rather than
  disposed, keeps its view subscription, and resumes. Its background pass yields to
  real idle time instead of back-to-back macrotasks.
- `use-session-diff-summary` serialized every turn's file diffs each frame to decide
  whether anything changed (144 KiB per frame at 4,000 turns). Identical entries are
  settled by reference; only a replaced entry is serialized.
- `normalizeTexMathDelimiters` and the Mermaid fence test re-scanned the whole
  accumulated answer on every delta, which is quadratic in answer length. Both now
  settle the common case with a substring test: a 120 KiB math-free answer went from
  2.49 ms to 0.06 ms per delta.

The index-row list, the chat stream items, the conversation config sources and the
ordered fact list hand back their previous array when nothing changed, and
`ConversationView` gained `structureVersion` so the accepted-history projection stops
rebuilding a whole-conversation slot array at token rate.

## Alternatives considered

Reporting the dense range but letting the cache filter it was rejected: the cache
would still read the whole directory to discover that nothing else moved, which is the
larger of the two costs at 4,000 turns.

Making the directory row carry `itemCount`/`planCount` would also have removed the
`rowChanged` false positive, at one extra container crossing per turn on every
directory read. Carrying the previous row's counts forward costs nothing and keeps the
adapter's existing "omit rather than guess" rule.

Keeping the fact table alive after the last release trades memory for the reopen cost.
The table is keyed by the view, so the session store's existing eviction bounds it; a
per-consumer timeout was rejected as a second lifetime to reason about.

## Two corrections found in review

Both were introduced by this work and are fixed in the same branch, each pinned by
a test that fails on the intermediate implementation.

Holding the fact table instead of disposing it stopped the background pass but left
the view subscription in place. That is correct when the table is keyed on the
conversation's own view, and wrong when it is keyed on a projection wrapper: the
wrapper is rebuilt whenever an optimistic entry appears or resolves, so the base
view's listener set accumulated one released wrapper — and one live fact table — per
message sent, each still deriving on every token. Tables are now keyed and
subscribed on `factSource`, the underlying view. That also collapses a duplicate
that predates this branch: the diff summary acquired on the base view while the
turn-fact readers acquired on the wrapper, so an unconfirmed entry meant two full
fact tables for one conversation.

Keeping the index row object when `rowChanged` reported no change assumed that
`rowChanged` sees everything a row carries. It does not see `inputConfig`, which is
a deferred projection that cannot be diffed without forcing it — exactly the cost
this branch removed. A user turn whose send configuration changed while outside
every hydrated window therefore kept its old model, Role and MCP selection in the
index, which is what the sticky-configuration resolver reads. A reported turn now
always takes the fresh row; identity is preserved only for turns the notification
did not name, which is where the churn this optimization targets came from.

## Verification and limits

Regression coverage pins the invalidation contract: a batch carrying an early edit and
the streaming tail reads 2 directory rows and 2 bodies, and fails at 23 rows on the
previous implementation. The fact-table test pins that facts survive the last release
and that the background pass is held until someone re-acquires.

Numbers above come from synthetic Loro fixtures in Node on one machine and are library
measurements, not device acceptance. They are useful as ratios, not as budgets. Real
turns carry far more content than the fixture's.

Two known costs are unchanged. The shared fact table still materializes every turn once
per session, because deriving a goal, scheduled task, proposed plan or file diff needs
the body; removing that needs those facts written alongside history, which
[versioned history hashes and primitive metadata](../architecture/2026-09-14-versioned-history-hashes-and-primitive-metadata.md)
opens the way for. Snapshot import still decodes on the renderer thread, as
[windowed conversation reads](../architecture/2026-09-10-windowed-reader-integration.md)
already recorded; moving it would mean moving the document off the main thread.

That note's evidence boundary listed streaming frame time as separate acceptance work
that was never done. This note is the correction: the work was necessary, and the cost
it would have found was a correctness-shaped defect in change scoping rather than a
tuning problem.
