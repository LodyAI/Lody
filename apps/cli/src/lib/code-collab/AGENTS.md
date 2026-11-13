# CLI Code Collab — Index

`CLAUDE.md` is a symlink to this file. Edit `AGENTS.md` only.

Current behavior and protocol references: [file surfaces](../../../../../.agents/docs/sessions-file-surfaces.md).
File-by-file responsibilities: [README.md](README.md).

## Invariants

- Turn-end filesystem refresh runs before Turn release within the execution owner's statistics budget.
  Refresh/publication attempts have configurable deadlines and cancellation;
  worker cancellation drains Git children. Late results cannot resume snapshot writes.
  Cancelling an attempt never destroys the shared Repo or its rooms.

- Do not reintroduce per-session Code Collab host runtimes, host handles, bootstrap
  secrets, or synced text CRDT documents here. Turn diff support is CLI-local:
  standard ACP diff blocks are written to `code-collab-v2-diff-store.ts`, and Web
  reads them back through Machine RPC.
- Turn-diff evidence unifies 3 ACP sources at turn end (`message-handler.ts`
  `persistCodeCollabTurnDiffs`): `fs/write_text_file`, standard `diff` blocks, and
  edit-tool changes gap-filled with new text from disk and old text chained from
  `getLatestText`. Resolve direct old evidence before loading a bounded path head.
  ACP-covered paths skip gap-fill; missing pre-images fail loudly.
  Badge and clickable content both derive from these exact events, never Git stats.
- The mandatory production Worker `turn-diff-store-worker.ts` must exist: missing
  emitted workers are fatal. The diff-store adapter injects `getServerNow()` so
  worker startup, retention reads, and background/manual GC stay on the same
  calibrated clock as persisted turn timestamps; it allocates one durable
  attempt-start head proof and advances a path only when its `newText` matches
  current disk.
- Shared file tree/All Changes uses owner-session Flock stream
  `<workspace-id>:fi:<master-session-id>` (one file row plus an optional opaque generation row per changed path); successful changes or
  targeted repairs advance signal stream `<workspace-id>:fis:<master-session-id>`,
  and the named Flock bridge in `apps/cli/src/lib/loro/doc.ts` lets Electron
  invalidate and refresh its Machine RPC snapshot. Both streams have 180-day TTL and
  must not enter repo meta. Root activation and terminal turn refresh may mirror only
  compact aggregate file counts and text add/del `diffStats` from the complete All Changes set before index
  trimming, including uncommitted work even with an associated PR. Statistics reconciliation
  must run when requested even if the index is unchanged. Unknown line counts preserve prior line totals while complete path counts still update; confirmed binary files contribute no text lines.
  File/diff watcher refreshes stay Flock-only. The injected `observeWorkspaceGit` observer
  runs only on activation/explicit root refresh, never file watcher or terminal diff refresh;
  it must not gate file snapshots.
- The whole published file index stays within `CODE_COLLAB_FILE_INDEX_LIMITS`
  (1,000 rows, 100 KiB of estimated Flock JSON), applied after the tree and All
  Changes are merged, never per input. Over-budget paths stay unloaded behind lazy
  parents; only a change recording `del: true` may publish `deleted`. Publication
  commits batches within that byte budget, separated by flush/sync. Package-manager
  caches in `CODE_COLLAB_IGNORED_DIRECTORY_NAMES` filter watcher, FS and untracked
  Git paths before any read, never tracked files. Filesystem scans prune
  `.gitignore`d entries in-process (`createGitIgnoreScanFilter`, the `ignore`
  package) before counting or descending; inside a worktree they keep entries that
  hold tracked files. Watcher batches confined to `git check-ignore`d paths skip
  the rescan; pathless dirt always rescans. Local Flock exports rely on the
  coalescing streams-crdt patch.
  [Decision](../../../../../.agents/notes/implemented/bug-fix/2026-11-05-code-collab-file-index-budget.md).
- Hide file-index paths containing U+FFFD on read and delete them on the next
  write. They are corrupted keys, never valid scan paths; never restore them.
- Only Code Collab RPC use extends `WorkspaceWatchCoordinator` idle ownership.
  Startup/restart/coverage gaps trigger authoritative full refresh; there is no
  per-directory fallback. Verify worker changes with the emitted
  `dist/code-collab-watch-worker.js` handshake/shutdown smoke. Its credential-safe env
  allowlist must preserve `ELECTRON_RUN_AS_NODE`: packaged Electron uses `Lody Helper`
  as Node, and dropping the flag launches a second GUI app instead of the worker.
- `save-text` never throws on a changed file: if the disk content is too large,
  binary, or invalid UTF-8 it returns a `digest_mismatch` conflict (with the disk
  digest via streaming when the file is too large to read) instead of an error, so
  the guest's unsaved edits survive. See `readDiskStateForSave`.
- Use `git ls-files` for recursive Git scans and synthesize lazy parents.
  Non-recursive refreshes scan the filesystem. Classification stays path-only;
  never read file contents. Root init/full/turn refreshes use the worker
  `full-state` path when available to keep listing and index building off-thread.
- Machine RPC is the integration boundary. Local/Electron direct transport can be
  added below that RPC abstraction, but file operations still route to the single CLI
  service. In particular, local `code-collab/get-file-index` scans/builds the initial
  tree and All Changes snapshot without awaiting Flock publication, then queues a
  force-reconcile of that fresh in-memory state without delaying the response. This
  repairs a durable file-index Flock that became stale while the CLI was stopped;
  Flock remains the durable replication path for remote consumers and local renderer
  invalidation after that initial snapshot.
- Non-Git All Changes bounds SQLite decompression: at most four concurrent paths
  and 8 MiB of cached raw snapshots per request by default. Over-limit paths stay
  deferred for single-file loading. Never collect unbounded candidates or
  reconstruct deferred paths twice.
- File RPCs convert absolute paths to workspace-relative paths only inside the
  target's registered session roots. Reject other paths as `invalid_path`;
  frontend path stripping never grants filesystem access.
- Native `fs.watch` handles must stay in `workspace-watch-worker-core.ts`; the main CLI
  Worker owns only subscriptions, refresh timers, scans, file-index/All Changes state,
  and Flock publication. The child receives canonical roots over private IPC only and
  exits on IPC disconnect. Do not restore direct or per-directory watches in the service.
- Child sessions resolve file operations against the parent session host/worktree when
  the session metadata has a parent.
- Shared file-index publishing is content-deduped. Do not publish full rows or advance the
  `<workspace-id>:fis:<master-session-id>` signal only to bump `updatedAtMs`; unchanged
  rows must not wake file surfaces. Transport/Meta reconnects are not dirty signals and
  must not rescan known owners. Initial activation reconciles only that owner. A failed
  write/flush/post-sync/signal transaction schedules bounded exponential-backoff repair
  only for the affected owner, serialized with its local refresh publication and using
  the latest in-memory state. Keep a failed signal pending even when the FI repair already
  landed so the targeted repair cannot mistake the transaction for complete.
- Machine RPC handlers run concurrently ([contract](../../../../../packages/loro-streams-rpc/AGENTS.md)).
  `save-text` uses `serializeByAbsolutePath` for an atomic read-check-write per file;
  different files stay parallel. Pure reads (open/refresh/diff) stay lock-free.

- Root-scoped file state shares the owner publication and physical-file save chains. Watch subscriptions include root identity; wire keys must be decoded before filesystem access.

- Diff blob handlers are capability-gated reads. They do not start watches, initialize
  a snapshot database or migrate it. Encrypted calls retain writer authority and
  execution claims. Reauthorize each page and serve only session-issued handles;
  never resolve a caller's hash as global authority.
  Generation rows contain no content hashes. Disk identity and non-Git base metadata
  stay daemon-local and invalidate generations even when line counts are unchanged.
  [Decision](../../../../../.agents/notes/implemented/architecture/2026-10-31-remote-diff-transport.md).
