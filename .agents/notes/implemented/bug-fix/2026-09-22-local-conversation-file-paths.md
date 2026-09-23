# Preserve local conversation file targets

Status: implemented
Translation: current

PR: https://github.com/LodyAI/Lody/pull/892

[中文](2026-09-22-local-conversation-file-paths.zh.md)

## Abstract

Conversation links stripped any `worktrees/<uuid>/` prefix, so a local artifact
in another worktree was looked up in the current workspace. This could report a
missing file or open a different file with the same name. Same-machine Electron
opens now retain those paths, and tool entries pass their original targets rather
than shortened display paths. Remote preview authorization and external-file
readonly behavior remain unchanged; the exact reported desktop failure has not
been replayed in the running app.

## Decision and evidence

This complements the [local file actions fix](2026-09-09-local-file-link-actions.md).
The CLI's local `file/resolve-local` already permits arbitrary regular files;
widening remote roots would not fix the renderer's incorrect target.
`resolveSessionFileOpenTarget` now carries an explicit same-machine preservation
option through Markdown normalization. The session preview and file-action hook
both set it only for Electron on the session's own machine. Paths under the known
workspace still share their relative identity with the index. Nonlocal opens
retain portable worktree mapping. Tool labels may shorten paths, but click targets
must reach that resolver intact.

The [draft Spec](../../../../specs/local-file-link-actions.md) records the behavior.
No RPC or save authorization changes are needed.

## Validation

The owning resolver suite covers other worktrees, unresolved workspace metadata,
Windows and parent-relative paths, line anchors, and current-workspace identity.
A real-filesystem regression distinguishes same-named files in two workspaces and
keeps a deleted target missing rather than falling back to the other file. The
file-action suite exercises an external worktree through the Markdown menu.
Validation passed: 82 targeted tests, `pnpm check` (including full CI tests),
`pnpm format`, and `pnpm run docs check`. The installed desktop app has not
been replaced or manually verified.
