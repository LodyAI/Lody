# apps/cli/src/lib/code-collab — file responsibilities

Binding rules live in [AGENTS.md](AGENTS.md); this file is the navigation index.
Ground truth for the rewrite: specs/code-collab-v2.md. The old v1
host/runtime/CRDT capture implementation has been removed from this directory.

- `code-collab-v2-service.ts` — the unified CLI Code Collab v2 service. It resolves
  owner/child workspace roots through `message-handler.ts`, treats relative paths as
  file ids, enforces path/text/payload limits, handles open/refresh/save conflicts,
  publishes file tree/current All Changes, and opens current or turn-scoped diffs.
  Git All Changes uses the owner base; non-Git uses local diff evidence only when a
  trustworthy base exists. It owns in-memory file-index state replacement and Flock
  publish even when the scan itself ran in a worker.
- `code-collab-v2-diff-store.ts` / `turn-diff-store-worker.ts` — CLI adapter and the
  mandatory production Worker for local ACP turn evidence. The adapter returns
  per-turn `FileDiff` and `getLatestText` heads; `message-handler.ts` passes the
  associated user-history timestamp/order key for turn/GC order and the calibrated
  recorded time separately. Storage/FastCDC/GC invariants live in
  [packages/turn-diff-store/AGENTS.md](../../../../../packages/turn-diff-store/AGENTS.md).
- `file-index-scan-worker.ts` / `file-index-scan-pool.ts` — off-main-thread directory
  scanning and full file-index state refresh. For Git worktrees the worker computes
  Git-backed All Changes; for non-Git/no-Git workspaces it first requests
  service-provided All Changes, then `code-collab-v2-service.ts` supplies diff-store
  state for the second worker call.
- `workspace-watch-coordinator.ts` / `workspace-watch-worker.ts` /
  `workspace-watch-worker-core.ts` — Fleet-level best-effort invalidation: the
  coordinator shares one child and one recursive watcher per canonical root, and
  the child core owns the native `fs.watch` handles.
- `code-collab-v2-service.test.ts` — path validation, digest conflicts, refresh
  behavior, compression limits, shared state publishing, current diff opening, and
  unsupported LSP responses.
- `code-collab-publish-repair.test.ts` — file-index initial reconcile and
  owner-scoped publication repair/backoff.
- `code-collab-v2-diff-store.test.ts` — adapter tests for exact snapshots, path
  scoping, chaining, and retention GC. Package-level dedup/refcount/size-GC tests
  live in `packages/turn-diff-store/tests`.
