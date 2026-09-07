# apps/cli/src/lib/file-preview — responsibilities and rationale

Binding rules live in [AGENTS.md](AGENTS.md); this file is the navigation index and
the reasoning behind those rules.

## Files

- `file-preview-service.ts` — resolves the workspace, authorizes the path, reads,
  classifies text vs binary, encodes, and answers.
- `file-preview-path-policy.ts` — the security boundary: allowed roots, symlink
  resolution, case/NFC-tolerant path resolution, and missing-path classification.
- `file-preview-path-policy.test.ts` — exercises the fold walk through an injected
  `FilePreviewDirectoryReader`.

## Why resolution folds case but authorization does not

Case-folded CONTAINMENT would be unsound on case-sensitive APFS (`/Users/x/Data` and
`/Users/x/data` are different directories). Case-folded RESOLUTION only hands the
containment check a real on-disk path, so it grants nothing on its own.

The two halves of that tolerance are not the same claim. NFC/NFD is a RESTORATION:
`code-collab/open-text` resolved it via `resolveExistingPathWithoutConflicts`, v3
dropped it, and files that had always opened stopped opening. Letter case is NEW —
`open-text` matched on `entry.name === segment` then NFC-equality, so `readme.md`
never found `README.md` there either. The consequence is that preview reads
case-tolerantly while writes stay case-exact, which is survivable only because the
client adopts the machine's reported `path` as the file identity.

On a case-insensitive volume — the macOS default, and this repo gates on a LOCAL
check — the fold walk is unreachable through the public entry point, so fs-backed
tests alone would leave it with zero executed coverage.

## Why missing-path classification uses `every`

With `some`, a request like `" /etc/passwd"` keeps its leading space in the verbatim
candidate, which then resolves under the workspace and vouches for the trimmed
candidate that escaped — turning `file_not_found` vs `path_not_allowed` into an
existence oracle for the whole filesystem.

A missing target has no realpath, so classification compares against both the
resolved and the unresolved roots: roots are routinely reached through a symlink
(macOS `os.tmpdir()` is `/var/folders/…` living at `/private/var/folders/…`), and
resolved-only comparison reported every deleted temp file as "outside the workspace".

## Why oversize is refused rather than truncated

Half a PNG is a corrupt file and half a JSON is a syntax error.

## Local resolution and resource IO are separate

`file/resolve-local` resolves the session owner and canonical file path without
reading contents. Electron's `local-file-resource.ts` provides small full text for
editing and opaque resource URLs for paged text or streaming images. Per-read budgets,
revision checks, cancellation, and virtual rows replace the old whole-file IPC ceiling.
The remote `file/preview` retains its complete, bounded response for the remote wire.

`maxBinaryBytes` is pinned to `SESSION_IMAGE_MAX_SIZE_BYTES` because that is the only
budget for this payload shape (base64 image bytes in one Machine RPC response)
already proven in production, via `local-project/control` image reads. The gateway's
real per-append ceiling is not asserted anywhere in this repo.

## Why the `path_not_allowed` wording is load-bearing

The generic `permission-denied` copy ("Access denied") misdescribes a policy
rejection as a filesystem one, so the web surface keys a dedicated presentation off
the phrase "File is outside the workspace".
