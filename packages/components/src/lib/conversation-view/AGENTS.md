# `lib/conversation-view` — windowed session history

`CLAUDE.md` is a symlink to this file. Edit `AGENTS.md` only. Package
[AGENTS.md](../../../AGENTS.md) applies.

`ConversationView` is the client's read model over a session doc's `history`
list, and `history-writer.ts` is its only write path. Together they let a
session store run on `sessionControlDocSchema` (history ignored), so opening a
long conversation never materializes every turn through a Mirror.

## Contracts

- `index(i)` is always loaded and comes from the turn map's shallow value plus
  `summary`, `itemCount` and `planCount`. Add a field to `TURN_INDEX_FIELDS`
  only when a reader that must stay O(1) needs it; every field costs one
  shallow read per turn at open.
- `turn(i)` is synchronous only for hydrated turns. Hydration is per-turn
  `toJSON()`; the LRU never evicts the tail (`tailKeep`), a `retain()`ed
  range, or the range an `ensureRange()` call just asked for. A caller that
  awaits `ensureRange(a, b)` must find every turn in it.
- `fileDiff(i)` reads one small container per turn and is cached until that
  turn's `fileDiff` changes, so the diff summary never hydrates items.
- `readAll()` is the deliberate full-transcript read (markdown export, search
  index, the `doc.history` bridge). First read is O(n) `toJSON`; later reads
  re-materialize only changed turns and hand back the same object for every
  other turn, because `buildChatStreamItems` and the outline are keyed on
  entry identity. It holds one object per turn for the life of the view.
- Doc events keep the index and hydrated turns current and bump `version` on
  every change; `subscribe` listeners see `index` / `range` / `tail`.
  Hydration itself never bumps `version` — hooks that hydrate on their own
  pass a `revision` to `useConversationViewSelector`.
- Writers (`appendHistoryEntry`, `replaceHistoryEntry`, `patchHistoryEntry`,
  `respondHistoryPermission`) produce exactly the container shapes a
  full-schema `Mirror.setState` produces (pinned by
  `tests/conversation-view-history-writer.test.ts`). `replaceHistoryEntry`
  drops and recreates the nested containers it carries; use
  `patchHistoryEntry` for a scalar flip so items keep their containers.
- `sessionControlDocSchema` keeps `history` declared as `Ignore` so
  `ignoreUnknownProperties` root mirroring does not re-materialize it. A
  Mirror `setState` that reaches an ignored field is memory-only, which is why
  `providers/session-doc-state-source.ts` throws on it.
