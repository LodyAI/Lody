# Electron file previews without a running daemon

Status: implemented
Translation: current

[中文](2026-10-16-daemon-independent-local-file-preview.zh.md)

## Abstract

A desktop user could not open a local file when the daemon was unavailable,
even though Electron already owned the content reads. Electron now verifies the
target using its persistent disk machine identity and resolves/reads the file
without a daemon request, protocol capability lookup, or ready file index.
Relative paths still need the original owner-session workspace root; remote
files retain their existing restricted RPC path. This changes preview acquisition,
not daemon-owned indexing, saving, or agent execution.

## Decision and responsibilities

```text
Desktop preview → main verifies disk machine identity
  matching machine → shared path resolver → Electron file resources
  other machine    → existing remote routing and bounded file/preview
```

- `machineRpc.previewFile` validates input and the product-window sender. It reads
  only the machine identity from the platform-specific credentials file and checks
  it before interpreting any file path. Local read failures never become cloud
  requests. Missing identity cannot authorize a local read.
- Absolute and home-rooted paths need no session root. Relative paths use cached
  metadata for the owner session (the parent for child tabs); missing project/root
  context is an error, never a substitute chat directory or process cwd.
- A desktop provider exists even while index loading fails or waits, so a known
  file link remains openable. Index state is still reported independently.
  Markdown opening checks disk identity when daemon-based identity is absent,
  preserving other-worktree absolute paths.
- Local reads are the desktop user's filesystem capability, like existing native
  open/reveal, not permission to execute an agent or mutate a session. There is no
  duplicate session authorization database or stale authorization cache. IPC stays
  restricted to product windows; arbitrary embedded pages gain no filesystem API.
- Move the existing path resolver to `shared/node/file-preview-path-policy` without
  changing case/NFC matching, symlink handling, whitespace or error classification.
  The CLI wrapper supplies the same remote default roots; the legacy
  `file/resolve-local` remains available for older clients. Electron reuses bounded
  resource reads, revision checks, and renderer lifetime fencing. External files
  remain readonly; no new write API is added.
- The file path hook is shared with native file actions. No Effect workflow or
  lifecycle owner changes; migrating the surrounding runtime/cache would not help
  this direct file-read boundary and is outside this fix.

This supersedes the earlier proposal to build a persistent desktop session
permission context: it was unnecessary for a desktop user's local preview.
The [cold-chat fix](2026-10-09-cold-chat-file-preview-workspace.md) still applies to
legacy/remote daemon reads; the [route cache](2026-09-29-local-file-preview-route-cache.md)
is no longer needed for current desktop previews. Preserve the error semantics
from [failure recovery](2026-10-16-file-preview-failure-recovery.md).
Intent: [file links](../../../../specs/local-file-link-actions.md).

## Validation

Behavioral coverage exercises real disk credentials and file reads without a
running daemon, invalid/missing roots and paths, remote-machine rejection, local
failure without cloud fallback, remote routing, and preview acquisition while the
index fails. Existing resource and CLI path/service suites retain revision,
range, symlink and remote-authorization coverage. Full check results and any
remaining environment limitations are recorded in the PR; no packaged UI
cold-start or live-daemon termination experiment is claimed.
