# ConversationView

`CLAUDE.md` is a symlink to this file. Parent guidelines apply.

- The shipped implementation is `createConversationViewFromReader`. Its index
  comes from directory reads; bodies are acquired by window. Loro imports its
  document and reads an O(total) directory. Roost opens the latest active-branch
  page and loads older pages at the viewport edge. Complete index/fact/search
  consumers hold an `acquireDirectory` lease; saved-anchor restoration requests
  that turn before accepting the first viewport report. Unloaded absolute slots are
  sentinels, never messages, body-read targets, or proof of complete fact coverage.
- Preserve the cursor of a retained older prefix during live append. Rebase a
  stale branch cursor across the loaded window only; retries must not silently
  fetch the unloaded prefix. Page membership and positions must agree before merge.
- Outline summaries are lazy: opening builds the directory and retained tail only.
  Hover reads the selected question and replies; released/evicted previews refresh
  on demand after content edits. Business fact derivation is a separate consumer.
- Cache identities and leases use turn ids, not positions. Release the ids
  captured at acquisition. Async reads are accepted only while membership and
  that turn's content epochs match. Retry invalidated reads while their lease
  remains active; release/dispose cancels them.
- View events are `structure` (affected positional range) or `changed` (explicit
  turn ids). Every body edit includes its id even when evicted. Derivations drop
  those cached facts before recomputing; shallow equality cannot detect body
  changes. Empty `changed.ids` only announces summary/cache bookkeeping.
- Only the reported ids invalidate a body: a directory row cannot tell whether a
  body changed, and merging sparse targets into one span re-read the whole
  conversation. Refresh those rows in contiguous runs; escalate to a structural
  re-key if the length moved. A reported turn always takes the fresh index row;
  `rowChanged` compares only what it can, and a deferred send configuration
  cannot be diffed without forcing it. A turn nothing reported keeps its row
  object — placeholder and Virtua caches key on that identity — so carry forward
  the counts a directory refresh does not supply before comparing them.
- A row's send configuration projects on first read and memoizes. Do not force
  it while collecting sources; the resolver reads the newest turn or two.
- Derivations retain small facts and weak identity hints, not evicted bodies.
  Structure updates prune deleted ids and restart incomplete coverage. Search
  refreshes membership/positions after structure changes. Directory leases and
  retry timers stop on release/dispose; a page failure is never complete coverage.
- Roost's local renderer bridge retains a durable read projection scoped by account,
  workspace, machine and session. Persist page bodies, positions and owner revision
  together. Consecutive deltas update only affected rows; unknown gaps stage a new
  snapshot while retaining the readable one. Never persist commands or claim remote
  acceptance from the cache. Cache-clear must include its database.
- Cloud Roost reads use the native read-only replica, with owner RPC only for
  commands. Remote history must be readable without the owner. Bootstrap from
  bounded reverse windows and catch up at their original tail, never a later
  HEAD. Replica cursors, storage and cache cleanup share one account/workspace/
  renderer identity; an owner revision is only a wakeup. Shared tabs reload
  progress inside the intake lock. Cached reads must not wait on network work.
  The workspace capability owns endpoint, auth and cancellation; never derive
  endpoints or tokens from the control doc or enable cloud in local composition.
- Send through the selected SessionData backend (the shared HistoryWriter for
  Loro, the owner bridge for Roost), with no optimistic display overlay;
  `readAll` is the authoritative export/hash read.
  The array adapter serves static shared pages, not a runtime fallback.
- Goal, permission, scheduling and diff consumers acquire the same fact table,
  keyed and subscribed on the conversation's own view. The final consumer
  release HOLDS the background scan and keeps the facts: deriving one needs the
  turn's body, so discarding them re-materialized the conversation on the next
  open. The table is collected with its view.
- Control-plane Mirror ignores history and does not enumerate its containers.
  Queue identity must retain non-enumerable `$cid` through Immer, not a
  `structuredClone` that drops it.
- Regressions and the benchmark run the shipped reader. Exercise evicted
  goal/file-diff edits, mixed structure/content batches, stale async reads and
  lease release with explicit signals. Library measurements are not device
  cold-open, frame-time or 3000-round memory acceptance.
