# apps/cli/src/lib/file-preview — responsibilities and rationale

Binding rules live in [AGENTS.md](AGENTS.md); this file is the navigation index and
the reasoning behind those rules.

## Files

- `file-preview-service.ts` — resolves the workspace, authorizes the path, reads,
  classifies text vs binary, encodes, and answers.
- `file-preview-path-policy.ts` — CLI default allowed roots and the shared
  `@lody/shared/node/file-preview-path-policy` resolver, also used by Electron.
  The shared resolver preserves symlink, case/NFC and failure classification rules.
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

Remote preview uses MessageHandler's read-only workspace resolver. A chat
whose runtime has been evicted resolves from its durable metadata to the existing
`<LodyDataDir>/chats/<ownerSessionId>` directory. Child tabs share their parent's
directory. Missing or invalid owner metadata and unavailable project/worktree
roots never fall back to another chat directory. This neither starts an agent nor
activates Code Collab; see the [cold-chat fix](../../../../../.agents/notes/implemented/bug-fix/2026-10-09-cold-chat-file-preview-workspace.md).

The legacy `file/resolve-local` validates durable session, machine, and child-owner identity
before resolving the canonical path without reading contents. If the workspace is
unavailable, absolute and home-rooted paths still resolve as external readonly files;
relative paths fail rather than using a substitute directory. Remote preview and
Code Collab retain their workspace requirement. See the
[local workspace independence fix](../../../../../.agents/notes/implemented/bug-fix/2026-10-10-local-preview-workspace-independence.md).

Current Electron verifies its on-disk machine identity and resolves paths directly,
without calling `file/resolve-local`. Its cached owner-session workspace root is
path context, not a filesystem authorization grant. Absolute/home paths work
without that root; remote reads still use this service's restricted policy.

Electron's `local-file-resource.ts` provides small full text for
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

## Failure classification and diagnostics

Only ENOENT/ENOTDIR imply absence. Both realpath implementations may fail; retain
permission and other I/O errors, including directory-listing failures during the
case/Unicode fallback. Remote unresolved paths still require every candidate to
be inside an allowed root before exposing a filesystem classification.

The daily log's `[file-preview]` JSON events distinguish `resolve-workspace`,
`resolve-owner`, `resolve-path`, and Electron/remote `read` failures. Resolution
records the requested path, session/owner, workspace root, canonical path on
success, and up to eight failed probes with operation/path/errno. Electron records
read outcome and duration with machine/workspace/session identity. These are local
diagnostics, contain no content or resource tokens, and are not protocol fields.
Pair events by session and requested path to distinguish a wrong root, a missing
file, a permission failure, and a file disappearing between resolution and read.

## Markdown links in nested worktrees

`markdownFileLinks` v1 adds an opt-in `resolveMarkdownLink: true` to `file/preview`.
It returns `resolved-link` candidates (no content) from the session root and
same-repository Git worktrees contained in it, via the shared
`@lody/shared/node/file-link-resolution`. If Git discovery is unavailable the link
resolves against the session root alone, as before. See the
[decision](../../../../../.agents/notes/implemented/bug-fix/2026-10-21-nested-worktree-file-links.md).

## Paid remote file downloads

The Download action previously reused `file/preview`, so a file above its text
or binary budget could not be downloaded even though chat attachments allow
100 MiB. `file/download-chunk`, negotiated through `fileDownload: 1`, returns
original bytes in 512 KiB ranges up to 100 MiB for a positively entitled paid
workspace. It uses the existing owner-scoped content envelope and path policy.
Each request rechecks workspace ownership and paid entitlement; file identity,
size and high-resolution modification/change timestamps bind all ranges.
A changed file fails instead of producing a mixed download.

The browser assembles one bounded byte array outside the preview/editor cache,
then uses the existing browser download or native sharing implementation.
Cancellation stops additional requests and suppresses export. A pending range
may finish on the machine but carries at most 512 KiB. Older machines and free
workspaces retain the existing preview-sized downloads. Same-machine local file
opening remains on the local IPC path; this capability adds no local-to-cloud
fallback. See the [decision](../../../../../.agents/notes/implemented/bug-fix/2026-10-26-paid-file-download.md).
