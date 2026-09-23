# Session render-cost and subscription invariants

Subscription scope, session-switch reset, restored side-panel state, and branch labelling.

Scope: `packages/components/src/components/sessions`. Binding rules and the
pointer to this page live in
[that directory's AGENTS.md](../../packages/components/src/components/sessions/AGENTS.md);
this page is the full text of the rules summarised there.

- `session-detail.tsx` must not subscribe page-level `activeSession` to Code Collab
  file-index Flock state. That state can update from file watchers and should only
  invalidate file surfaces, not the whole chat/message list.
- Message rows must not subscribe to full `sessionMetaAtomFamily`. Select only
  the fields needed by row UI (for example avatar `cliType`/`agentType`/`env`) so
  Code Collab shared-state metadata does not wake idle markdown rows.
- Treat Code Collab file-index Flock state as large/path-keyed state. Keep it out
  of repo meta and subscribe from file provider hooks only.
- `session-detail.tsx` owns session-switch local UI reset. Keep the reset in the
  render-phase `localStateSessionId !== sessionId` branch; do not add a second
  `useEffect([sessionId])` reset that replays the same state updates.
- **A RESTORED side-panel state must not animate.** The desktop panel animates
  `flex-grow`/`min-width`, so one 220ms expand runs style → layout → paint →
  compositing for the whole detail tree every frame — measured at ~400ms of
  near-saturated main thread per session switch. Any code path that sets
  `isSidebarOpen` from persisted/URL state rather than from a user action must
  bump `sidebarRestoreSeq` in the same commit (today: the session-switch reset
  branch and the `?pr=` deep-link RENDER-PHASE adjustment — the restore is
  deliberately not an effect, so the `?pr` clear effect can never observe
  pre-restore sidebar state); `DesktopSessionDetailLayout` then
  applies it in one frame and re-arms the transition on the next rAF. User
  toggles (`handleToggleSidebar`, `handleOpenPrTab`, viewer/browser opens) still
  animate and must NOT bump it.
- Branch UI shortcut: "current branch" copy uses `SessionMeta.branchName` only.
  `SessionMeta.baseBranch` / `project.branch` are start/base refs; they may be
  shown as base fallback, but must not be copied or labeled as current. The
  mobile bottom `SessionInfoBar` omits branch information; desktop keeps it.

## Desktop windows

`MainLayout` uses one Web Lock per workspace for completion notifications, dock
badge, PR auto-archive and Task status checks. The lock releases on renderer exit;
Task Index stays mounted in every workspace window because visible Tasks pages
also consume it. Sidebar hiding unmounts the sidebar subtree and disables the
runtime eager-sync environment until it is shown again. Current Session sync is
independent of that prefetch gate. See [window behavior](../../specs/desktop-windows.zh.md).

Background prefetch does not materialize UI stores. The workspace runtime sends
room identity and transport configuration to `eager-sync-worker-client.ts`; one
disposable worker at a time imports/syncs a raw Loro Doc and persists a snapshot.
The worker sends only completion status back, and retains no warm Doc or Mirror.
The independent IndexedDB cache holds at most 128 MiB / 64 snapshots; each row
atomically stores binary state and its activity checkpoint. Before constructing a
worker (and its Loro WASM), the parent checks that checkpoint and skips already
covered activity; the worker checks it again for cross-window races. Cache keys
use workspace plus room, so auxiliary windows reuse rather than duplicate rows.
The coordinator also loads a bounded timestamp-only high-water index before it
seeds candidates. This keeps snapshots evicted by the 64-row LRU from causing
repeat worker creation at every startup, without reading Doc or history data.
Foreground store creation cancels that room's prefetch, reads a completed
snapshot, and merges it into the renderer's own document before creating its
Mirror. Existing cached UI stores are excluded from prefetch so a background
result cannot silently leave their in-memory state stale. The main repo and its
unsent writes remain separate.

The coordinator uses concurrency/batch size 1, with 1.5-second batch cooldowns on
desktop/web and 3 seconds on mobile. A renderer-wide queue also serializes runtime
instances across workspace transitions; separate windows each have their own slot
but share workspace cache rows. Cancellation kills the worker even during
synchronous WASM work, and the parent withdraws its local peer. Local targets use
the existing local readiness plane; remote targets use the same configured Streams
endpoint as the mounted foreground transport. This isolates background
materialization from UI execution, but does not remove foreground full-history
import/Mirror cost or daemon-side document loading.

Intent: [background prefetch](../../specs/session-background-prefetch.zh.md).
