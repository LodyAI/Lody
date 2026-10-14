# Create a folder in the remote directory picker

Status: implemented
Translation: current

[中文](2026-10-14-remote-directory-creation.zh.md)

## Abstract

The remote Add folder picker could select an existing directory but could not create
one; its pencil edits the navigation path. It now offers a single-name New folder
form for capable machines, creates under the current remote parent and enters the
result. Add remains a separate registration action. Collisions fail without
overwriting anything; transport failures require checking the parent before retrying.

## Decision and ownership

```text
Desktop / mobile picker → shared hook and creation form
  → local-project/create-directory(machineId, workspaceId, parentPath, name)
  → Machine RPC / local daemon → LocalProjectControlService → mkdir
  → browse created path → existing Add / prepare-add → project registration
```

The new capability `localProjectCreateDirectory: 1` gates the entry for older daemons.
Shared TS, Zod and CJS guards carry the request and response; both dispatchers check
machine/workspace before creation. The service requires an absolute existing parent,
resolves its real path and accepts one nonempty name without separators, control
characters or surrounding whitespace. Windows reserved names and characters are
rejected on Windows. Non-recursive mkdir handles races and refuses existing files,
directories and symlinks. OS permission/read-only failures and invalid paths remain
structured errors. This uses the existing Promise service boundary: migrating daemon
ownership would extend into lifecycle dependencies unrelated to directory creation.

The hook blocks simultaneous creation/registration with a synchronous guard, preserves
failed drafts and ignores completion after navigation/close/unmount. A confirmed create
followed by failed browsing retries only browsing. No automatic mkdir retry is added.
Native pickers and rename are outside this change.

## Limits and verification

Machine ownership is the existing UI-only rule, not authenticated RPC caller ownership.
This feature does not invent a trusted user id from request payloads. Filesystem access
uses the daemon's OS identity. Canonicalizing a parent is not a portable mkdirat-style
defense against another local process replacing ancestors concurrently.

Behavior tests exercise real temporary directories (canonical parent, invalid names and
parents, file/directory/link collisions, concurrent creation), injected OS permission
errors, wire schemas/guards, both dispatchers, and picker state/UI including offline,
duplicate actions and separate registration. Dispatcher tests are focused mock tests:
they isolate installed Claude SDK metadata and exercise real routes and temporary
filesystems, but do not establish adapter/runtime integration. Windows name rules are
exercised by an injected platform; a real Windows filesystem and a live remote-machine
UI are not covered.
Package checks and their environment limits are reported with the commit; no PR is created.
