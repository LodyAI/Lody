# Copy relative and absolute file paths

Status: implemented
Translation: current

PR: https://github.com/LodyAI/Lody/pull/920

[中文](2026-09-23-copy-relative-and-absolute-file-path.zh.md)

## Abstract

The Files tree context menu and the right-side panel More menu offered one
`Copy file path` action that silently copied the resolved absolute path when the
owning machine's workspace root was known and the workspace-relative path
otherwise, so users could not choose which form reached the clipboard. Both
menus now offer `Copy relative path` for the path the viewer holds and
`Copy absolute path` for the path resolved on the owning machine; the absolute
row is hidden while neither the workspace root nor an already-absolute path
supplies one. The file-error card and the Markdown-link menu keep their single
adaptive copy action, which is the remaining difference between those surfaces.

## Decision and evidence

This extends the shared file-action decision in the
[local file links note](../bug-fix/2026-09-09-local-file-link-actions.md): copying a path
stays available on every surface, while reaching a shell remains gated on the
local-host half. `useSessionFileActions` keeps `copyPath` for the file-error
card and the agent Markdown-link menu, and adds `copyRelativePath` /
`copyAbsolutePath` for `menuItems`. The menu item type gains an optional
`isAvailable(filePath)` predicate so the absolute row can decline a path at
render time; the Files tree and `SessionFileActionsMenu` both filter on it, so
the decision stays in the one model rather than being re-derived per surface.

`isAbsoluteFilePath` in `lib/session-local-file-path.ts` now owns the
absolute/UNC classification and is reused by the workspace-root resolver and by
the hook's `resolveAbsoluteFilePath`, which returns the resolved host path, the
path itself when it is already absolute, or `null`. A canonical workspace
viewer path is already relative, so `copyRelativePath` needs no root and works
for remote sessions; `copyAbsolutePath` stays correct for remote sessions once
their workspace root is known, because that root is the machine's own path and
is never handed to the viewer's shell.

## Alternatives considered

Always rendering the absolute row and falling back to a copy when the path
cannot be resolved was rejected: a menu row that copies something other than
its label is a lie, and the existing surfaces already prefer hiding an action
over letting it disappoint. A disabled row was rejected because the shared menu
model has no disabled state and both surfaces render a hidden item cleanly.
Stripping the workspace root to derive a relative path from an absolute one was
unnecessary for the tree and side panel, whose canonical paths are already
relative, and would have added a second path-identity rule.

## Verification

`use-session-file-actions.test.tsx` covers the two rows, the resolved absolute
value, the unavailable-absolute case, and an already-absolute external path;
`session-local-file-path.test.ts` covers the absolute/UNC classifier. Validation
passed: 27 targeted tests, the full `@lody/components` suite (487 files, 3954
tests), `pnpm typecheck`, `pnpm lint`, `pnpm run docs check`, and the three
repository boundary guards. The monorepo `pnpm check` was interrupted by the
environment with SIGTERM while running the unchanged `apps/cli` tests; no test
failure was observed before the kill.
