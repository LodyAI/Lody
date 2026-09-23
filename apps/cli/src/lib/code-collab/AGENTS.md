# CLI Code Collab — Index

`CLAUDE.md` is a symlink to this file. Edit `AGENTS.md` only.

Ground truth for the rewrite: specs/code-collab-v2.md. The old v1
host/runtime/CRDT capture implementation has been removed from this directory.
File-by-file responsibilities: [README.md](README.md).

## Invariants

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
  `<workspace-id>:fi:<master-session-id>` (one row per path); successful changes or
  targeted repairs advance signal stream `<workspace-id>:fis:<master-session-id>`,
  and the named Flock bridge in `apps/cli/src/lib/loro/doc.ts` lets Electron
  invalidate and refresh its Machine RPC snapshot. Both streams have 180-day TTL and
  must not enter repo meta. Root activation and terminal turn refresh may mirror only
  compact aggregate add/del `diffStats`; watcher refreshes stay Flock-only, and PR
  sessions retain committed compare totals.
- A file-index row whose path key carries U+FFFD came from a byte stream decoded
  across a chunk boundary, not from a scan; it is its own LWW key, so a correct
  republish cannot overwrite it. The shared helpers hide it on read and delete it on
  the next write — do not "restore" such rows.
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
- In Git worktrees, scanning prefers `git ls-files` only for recursive scans and
  synthesizes lazy parent directories; non-recursive directory refresh stays on FS
  scanning because Git does not record empty directories. Fallback FS scanning is
  path-only and must not read file contents to classify text/binary/size. Root
  init/full/turn refresh should use the worker `full-state` path when available so
  file listing and fileIndex building stay off the main thread.
- Machine RPC is the integration boundary. Local/Electron direct transport can be
  added below that RPC abstraction, but file operations still route to the single CLI
  service. In particular, local `code-collab/get-file-index` scans/builds the initial
  tree and All Changes snapshot without awaiting Flock publication, then queues a
  force-reconcile of that fresh in-memory state without delaying the response. This
  repairs a durable file-index Flock that became stale while the CLI was stopped;
  Flock remains the durable replication path for remote consumers and local renderer
  invalidation after that initial snapshot.
- Non-Git All Changes reconstruction is bounded before SQLite decompresses a snapshot:
  at most four paths run concurrently, one request retains at most 8 MiB of raw cached
  snapshots by default, and over-limit paths are returned as deferred for single-file
  loading. Never restore an unbounded candidate array or reconstruct deferred paths twice.
- File RPCs canonicalize an absolute request path to a workspace-relative path only
  when the target machine resolves it inside the session workspace root. Absolute
  paths outside that root remain `invalid_path`; never rely on frontend path stripping
  as the filesystem access boundary.
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
- Machine RPC now dispatches handlers concurrently (see
  `packages/loro-streams-rpc/AGENTS.md`), so handlers cannot assume serial execution.
  `save-text` keeps its read-check-write atomic via `serializeByAbsolutePath`
  (per-file write chain) so two concurrent saves to the same path can't both pass the
  base-digest check and clobber each other; different paths still save in parallel.
  Pure reads (open/refresh/diff) stay lock-free.
