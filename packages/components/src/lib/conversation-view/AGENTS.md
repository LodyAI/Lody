# lib/conversation-view — windowed session history

`CLAUDE.md` is a symlink to this file. Edit `AGENTS.md` only. Package
[AGENTS.md](../../../AGENTS.md) applies.

Opening a conversation must cost O(window), not O(turns). loro-mirror's
`Mirror` walks every container of the `history` list (seconds on a
2,000-turn doc), so the session store never materializes history:

- **Read** through `ConversationView` (`createConversationViewFromDoc`):
  `index(i)` is always available from one shallow read per turn; `turn(i)`
  only while hydrated. `ensureRange`/`release` are a ref-counted pair; the
  LRU (`maxHydrated`) never evicts pinned turns or the last `tailKeep`
  turns, which are hydrated eagerly for streaming. Summaries and the shallow
  user config fill in idle chunks and resolve `ready`. Hydrated objects equal
  Mirror's output (`tests/conversation-view-from-doc.test.ts`) and are patched
  copy-on-write from doc events (`apply-turn-event.ts`), falling back to a
  full re-read when a path does not resolve.
- **Write** through `HistoryWriter` (`history-writer.ts`). Its container
  shape is byte-identical to `Mirror.setState`
  (`history-materializer.ts` restates loro-mirror's inference rules over
  the shared schema; `tests/history-writer.test.ts` proves op equality). Do
  not add another write path or write history through `setState`.
- **Control plane**: the session Mirror uses `sessionControlPlaneSchema`
  (`history: schema.Ignore()`) over `createControlPlaneDoc`, which drops
  `history` events (the incremental event path applies ignored roots) and
  skips root enumeration (a lazy-snapshot walk of every container). Contract:
  `tests/control-plane-mirror.test.ts`.
- **Whole-history readers** use `createConversationDerivation` (a fact table
  filled by a background hydrate-derive-release pass, updated from view
  events) or hydrate on demand and release. Never scan `turn(i)` over all
  turns synchronously.
- **Rollback**: `isConversationViewEnabled()` (env `LODY_CONVERSATION_VIEW=0`
  or the developer setting) swaps in the old full Mirror behind a fully
  hydrated adapter (`createConversationViewFromHistory`) for one release.
- loro-mirror's upcoming `LazyList` maps 1:1 onto this interface (`index` ↔
  `index`, `get` ↔ `turn`, `hydrate` ↔ `ensureRange`, `subscribeRange` ↔
  `subscribe` + `ensureRange`/`release`); keep the surface this narrow.

## No `@/` aliases in this module

`packages/history-import`'s benchmark imports these files by relative path and
its tsconfig has no `@/` mapping, so an alias here fails `pnpm typecheck` in a
package that never touches the renderer. Import siblings relatively.
