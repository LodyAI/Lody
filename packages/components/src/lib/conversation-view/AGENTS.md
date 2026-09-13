# ConversationView

`CLAUDE.md` is a symlink to this file. Parent guidelines apply.

- The shipped implementation is `createConversationViewFromReader`. Its index
  comes from shallow directory reads; bodies are acquired by window. Opening
  still imports the document and reads an O(total) directory before the window.
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
- Use the one shared HistoryWriter in both read modes. A display projection is
  never a write baseline or export/hash input. `readConversationHistory` uses
  the authoritative reader's one consistent full read.
- `LODY_CONVERSATION_VIEW` is a build-time rollback constant only. The temporary
  `from-history` array adapter should be removed after two releases. No runtime
  setting or localStorage override; there is no raw-doc reader implementation.
- Control-plane Mirror ignores history and does not enumerate its containers.
  Queue identity must retain non-enumerable `$cid` through Immer, not a
  `structuredClone` that drops it.
- Regressions and the benchmark run the shipped reader. Exercise evicted
  goal/file-diff edits, mixed structure/content batches, stale async reads and
  lease release with explicit signals. Library measurements are not device
  cold-open, frame-time or 3000-round memory acceptance.
