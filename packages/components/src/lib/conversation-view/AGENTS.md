# lib/conversation-view — windowed session history

`CLAUDE.md` is a symlink to this file. Edit `AGENTS.md` only. Package
[AGENTS.md](../../../AGENTS.md) applies.

The windowed reader materializes only requested turn bodies. Snapshot import
and the initial shallow directory remain O(total turns), before the first window.
Do not claim O(window) cold open or a hard whole-process memory bound.

- **Read** through `ConversationView` (`createConversationViewFromDoc`):
  `index(i)` is always available from one shallow read per turn; `turn(i)`
  only while hydrated. `acquireRange` returns a handle whose `release` is
  idempotent and releases the captured container ids, even after positional
  edits; release also cancels remaining hydration chunks. Positional readers
  reacquire on `structure`, including same-length replacements. The
  LRU (`maxHydrated`) never evicts pinned turns or the last `tailKeep`
  turns, which are hydrated eagerly for streaming. User send configuration
  is indexed without reading prompt/inputBlocks or turn bodies; only MCP selections
  and option maps need small collection reads. Refresh it on config edits. Sending
  must not depend on idle progress for Role, explicit empty MCP selection, option
  values or task-tool settings. Summaries and counts fill in idle chunks and resolve `ready`. Hydrated objects equal
  Mirror's output (`tests/conversation-view-from-doc.test.ts`) and are patched
  copy-on-write from doc events (`apply-turn-event.ts`), falling back to a
  full re-read when a path does not resolve. Every full read also replaces
  all index scalars from that same turn, including absent/deleted fields;
  structural batches may then safely skip the subsumed turn events. Summary inputs
  use the renderer's tolerant item normalization in both readers; never rewrite
  invalid/unknown stored items while deriving their display summaries.
- **Reader-backed composition**: the windowed display cache reads through
  `createConversationViewFromReader` over `sessionData.history`
  (`create-conversation-session.ts`); `createConversationViewFromDoc` remains
  only for the non-windowed/rollback path. That module never imports
  `loro-crdt`, never names a CID/container id and never touches a raw doc: its
  synchronous accessors read an in-memory snapshot that async port reads
  populate (`readDirectory` for index rows and send config, `readTurn` for
  bodies). Identity is `turnId`, never a position; leases pin by id with
  refcounts, and every async read/lease carries the membership epoch plus the
  turn's own content epoch — a result is applied only while both still match, and
  otherwise re-read while the lease needs it. Invalidation uses the identities an
  event actually touched (never a shallow row comparison, which cannot see a body
  or `inputConfig` edit); an active request has no fixed retry cap and is never
  resolved as success with a hole. `observe.initial` builds the index; each
  ranged `changed` re-reads ONLY the affected raw range (directory + the hydrated
  turns inside it) and `reset` is the only full re-read. Contract:
  `tests/conversation-view-from-reader.test.ts` (both `createLoroSessionData`
  and `createMemorySessionData` backends).
- **Write** through `@lody/shared` HistoryWriter in both feature-flag modes.
  Never recreate its parser, materializer, rollback or stored-copy behavior here.
  `createConversationSession` owns reader composition; windowed writes do not
  receive a full-history callback. Read caches are never a write baseline.
- Content edits must emit a body-range invalidation even for evicted turns,
  including positionless updates. An index/summary notification alone cannot
  invalidate goal, permission or file-diff facts. Test the shipped reader and
  its derivation together; the raw-doc fallback is not that coverage.
- **Cache ownership**: derivations keep weak identity hints, not strong turn
  references. Facts must contain only the data their consumer needs. Disposal
  clears facts and releases in-flight pins. LRU limits exclude pinned/tail turns.
- **Control plane**: the session Mirror uses `sessionControlPlaneSchema`
  (`history: schema.Ignore()`) over `createControlPlaneDoc`, which drops
  `history` events (the incremental event path applies ignored roots) and
  skips root enumeration (a lazy-snapshot walk of every container). Contract:
  `tests/control-plane-mirror.test.ts`. The shared
  `createSessionControlPlaneMirror` function updater must normalize with Immer
  (`useStrictShallowCopy`), never `structuredClone`: loro-mirror's queue
  identity is a non-enumerable `$cid` a clone drops, so removals/reorders
  silently stop matching. Contract:
  `packages/shared/tests/session-control-plane-mirror.test.ts`.
- **Whole-history readers** use `createConversationDerivation` (a fact table
  filled by a background hydrate-derive-release pass, updated from view
  events) or `readConversationHistory` for one-shot copy/image sharing. That helper
  reacquires after structural changes and rejects missing turns, then releases;
  a captured CID lease does not certify the current positional range. Never scan `turn(i)` over all
  turns synchronously.
  Structural changes restart incomplete fact coverage and invalidate affected
  cached facts. Open search acquires new membership and refreshes cached block
  positions after insertions/deletions; content-only updates stay frame-coalesced.
- **Rollback**: `isConversationViewEnabled()` (env `LODY_CONVERSATION_VIEW=0`
  or the developer setting) swaps in the old full Mirror behind a fully
  hydrated adapter (`createConversationViewFromHistory`) for one release.
- This reader does not depend on Mirror LazyList. Any future adapter must
  preserve range ownership, event delivery and unknown-history behavior;
  similar method names alone do not establish compatibility.

## No `@/` aliases in this module

`packages/history-import`'s benchmark imports these files by relative path and
its tsconfig has no `@/` mapping, so an alias here fails `pnpm typecheck` in a
package that never touches the renderer. Import siblings relatively.
