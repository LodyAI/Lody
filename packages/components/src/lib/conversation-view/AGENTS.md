# ConversationView

`CLAUDE.md` is a symlink to this file. Parent guidelines apply.

- The shipped implementation is `createConversationViewFromReader`. Its index
  comes from shallow directory reads; bodies are acquired by window. Opening
  still imports the document and reads an O(total) directory before the window.
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
- Derivations retain small facts and weak identity hints, not evicted bodies.
  Structure updates prune deleted ids and restart incomplete coverage. Search
  refreshes membership/positions after structure changes.
- Use the one shared HistoryWriter. A display projection is never a write
  baseline or export/hash input; `readAll` forwards the authoritative read.
  The array adapter serves static shared pages, not a runtime fallback.
- Goal, permission, scheduling and diff consumers acquire the same per-view
  fact table. Only the final consumer release disposes its background scan.
- Control-plane Mirror ignores history and does not enumerate its containers.
  Queue identity must retain non-enumerable `$cid` through Immer, not a
  `structuredClone` that drops it.
- Regressions and the benchmark run the shipped reader. Exercise evicted
  goal/file-diff edits, mixed structure/content batches, stale async reads and
  lease release with explicit signals. Library measurements are not device
  cold-open, frame-time or 3000-round memory acceptance.
