# `components/src/lib` — file-surface invariants

`CLAUDE.md` is a symlink to this file. Edit `AGENTS.md` only.
Package [AGENTS.md](../../AGENTS.md) applies; this file adds the rules for the
client half of Code Collab / File Preview file surfaces.

## The Electron IPC type-only edge is intentional

`electron-ipc-client.ts` imports `ElectronIpcServices` from the Electron main-process
registration module with `import type`. This resembles a package cycle because the
Electron renderer also consumes `@lody/components`, but it is deliberately a source-type
edge only: TypeScript erases it, browser/mobile bundles never load main-process code, and
there is no `@lody/electron` runtime or package dependency here.
The type checker still follows the referenced source, so the components project keeps
`experimentalDecorators` enabled and a direct catalog-pinned `@types/node` dev dependency;
those settings make the main service declarations parse under the same assumptions as the
Electron node project without changing any emitted renderer code.
The Node declarations are compiler plumbing, not permission for shared UI to use Node APIs;
the repository lint boundary rejects `node:*` imports and common Node globals in components
source.

The alternative is a second handwritten mirror of every invoke method in a shared
contract or platform port. That mirror previously drifted independently from
`@IpcMethod()` registration and the preload policy. Keep the service classes plus the one
constructor list as the invoke signature source instead. Do not replace this type-only
edge with another invoke contract, spec, or one-for-one platform port. If a future build
cannot erase or resolve the edge, fix that explicit type boundary or reconsider where the
Electron-aware caller lives; never turn it into a runtime import. Push events and one-way
sends remain platform-neutral maps in `@lody/shared/electron-ipc`.

## Where a path came from decides whether it may be rewritten

`session-file-open-target.ts` owns this and is the only place that should.

- **Canonical** — the caller already holds the workspace-relative path the
  machine indexed: file tree, quick open, mobile file browser, an LSP jump
  target. Sent VERBATIM.
- **Markdown href** — a link an agent wrote in chat. Gets parsed: URL-decoded,
  trailing `:<line>` / `#L<line>` split off, absolute host root and
  `.../worktrees/<uuid>/` prefix stripped.

Running a canonical path through the href parser is what this split exists to
prevent, because every one of those sequences can be a real part of a real
filename: `docs/report%20v2.md` decodes to a different file,
`logs/2024:30.txt` loses its tail, `fixtures/worktrees/<uuid>/case.txt` gets
re-rooted. A line anchor travels as a FIELD, never encoded into the path.

Known gap: `ai-gui/view.tsx`'s tool-call card sends an ACP `locations[].path` —
a filesystem path, not an href — through `onFilePathClick`, so it still rides
the href parser. It needs a third kind that strips roots without decoding.

## ACP dispatch

Rate-limit window labels are provider-supplied scope names, displayed alongside
localized durations through `formatAgentRateLimitWindowLabel`. Preserve every
window even when durations, utilization, and resets match: a model weekly
sub-cap and the shared weekly pool are concurrent constraints, not alternatives.

Before creating a top-level or child session, call
`filterAcpSessionConfigOptionValues()` so cached values outside the current
selector schema are not dispatched or persisted again.

## A resolved open is cached under BOTH spellings

The machine may answer with a different on-disk spelling than the one requested
(letter case, Unicode normalization), so `openFile` caches the result under
`response.path` AND under the path it asked for. Each key has a caller that
breaks without it:

- `response.path` becomes `entry.fileId`, so it is what `saveText` is later
  called with. Missing it, save reports "Open the file before saving it." for a
  file that is open on screen.
- The requested path is what the viewer tab keeps — `session-detail.tsx`
  refreshes a tab's `fileId` from the file INDEX, which never learns the
  resolved name — so `checkTextChanged` and the next `openFile` still arrive
  with the original spelling. Missing it, the external-change pre-check silently
  no-ops and every re-open re-downloads the file, because no `knownDigest` can
  be sent.

A save must then refresh EVERY key of the entry (`cacheKeys` on the cache
entry), because the save arrives under one spelling and the next change-check
under the other — refreshing only the save path leaves the alias holding the
pre-save digest, and the pre-check reports our own save as an external change.

Related: preview READS case-tolerantly while `save-text` WRITES case-exactly.

## Known gap: scan-failure skip reasons

`codeCollabFileTreeValueToSessionFileEntry` maps every `kind: 'skipped'` index
entry to `unavailableReason: 'unsupported-special'`, so a file the scanner
merely failed to read once (EBUSY/EMFILE, deleted mid-scan) renders as "File
type is not supported" and stays unclickable until the next full rescan. Fixing
it needs care that a naive allowlist does not give: the same reasons are emitted
for DIRECTORIES whose read failed, and `openFile` does not clear an index
`readonly`, so the obvious patch trades "unopenable" for "uneditable".

## Error copy

`session-file-error-state.tsx` maps a machine message + reason to a
presentation. Two rules run BEFORE the reason mapping, because the machine's
coarse error code misdescribes them:

- "outside the workspace" — a policy rejection arrives as `permission_denied`;
  "Access denied" would blame the filesystem. The CLI is required to keep that
  exact phrase in the message.
- "owner session mismatch" — a startup race (the client derives the owner from
  synced session meta, the machine from the live session) that also arrives as
  `permission_denied`. The only correct advice is "try again".
