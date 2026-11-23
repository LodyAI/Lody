# Reconcile the Dock badge from absolute workspace state

Status: implemented
Translation: current

[中文](2026-09-26-dock-badge-reconciliation.zh.md)

## Abstract

The Dock could retain an unread count after the sidebar was clear. Reports already
replaced absolute counts, but only count changes triggered them; a failed clear or
an abandoned renderer contribution had no guaranteed repair. The renderer now derives
one count from the sidebar's parent/child activity rules, publishes changes immediately,
and reasserts the full snapshot every 30 seconds and on focus/visibility restoration.
Main drops contributions on renderer crash or document navigation. Reconciliation
repairs delivery drift, not unavailable upstream metadata; background throttling and
sleep can delay the interval, and native Dock behavior still needs a desktop smoke test.

## Decision and evidence

- `sessionListAtom` omitted `isTabClosed` from its equality keys. A close-only write
  retained the old unread object until another compared field changed. Include the
  field so close/reopen propagates to list consumers.
- `workspaceBadgeAtom` uses complete active metadata and the existing sidebar
  activity summary, including child tabs and side chats. Count each owned root row
  once, with permission waiting taking precedence. The former root-only count missed
  unread/waiting children; this corrects the window-badge claim in the
  [closed-conversation note](2026-09-21-closed-conversation-unread.md).
- The timer reads current atom state and remains mounted across count changes.
  An unchanged zero must still be sent: a change-only effect cannot retry a failed
  clear. IPC failures are handled; the next reconciliation retries the snapshot.
- Main still replaces each window's contribution and sums active contributors.
  Renderer crashes/reloads cannot execute React cleanup, so native lifecycle events
  remove their contributions. Same-document navigation keeps the current contribution.
  Repeated snapshots retain the existing rising-edge-only permission bounce.

No incremental counter, read-receipt mutation, or unread-state reset is introduced.
The [desktop window Spec](../../../../specs/desktop-windows.md) remains draft and
records the reconciliation contract. The visibility/focus policy for marking messages
read is a separate issue and is not changed here.

## Validation

Deterministic regression coverage drives real Jotai metadata/presence, the React hook,
and `WindowBadgeService` with an injected Dock and IPC transport. Cases cover close,
reopen, archive/read, child waiting, expired presence, failed zero delivery, unchanged
snapshot repair, timer deadlines, visibility/focus, unmount, logout, and abandoned
window contributions. The existing metadata selector and sidebar suites remain the
owners of list behavior. Native Electron was not launched.

All 45 focused tests passed using the current sources and a temporary Vitest config
with reused dependencies. Changed-code lint/format and the platform boundary guard
passed. Full component typechecking could not pass with that partial dependency
installation; documentation/public-boundary checks report missing ACP submodules
in this checkout, outside the changed files. No full build or root suite is claimed.
