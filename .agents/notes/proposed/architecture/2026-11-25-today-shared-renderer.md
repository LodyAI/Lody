# Reuse the desktop renderer for a lightweight Today window

Status: proposed
Translation: current

[中文](2026-11-25-today-shared-renderer.zh.md)

## Abstract

The desktop Today's current native window loads the normal renderer and starts a new workspace
runtime. A same-origin Electron companion can mount only the Today interface from its source
renderer and reuse that renderer's live notes cache. An isolated Electron experiment confirmed
direct object access in both windows and tested the companion lifetime option. The production
workspace runtime, editor and window lifetime still require integration work.

## Proposal

For a window opened by a renderer with access to the selected workspace, mount Today into a
controlled companion document. Share the source renderer's workspace scope and `todayPages` cache.
Acquire the selected day immediately and use the cache's date index when available. Its first
consumer may still initialize the Today document prefix listing. The companion does not need an
application router or a second workspace runtime. Session features such as mention menus and
Convert to task should load on use where they are not already available.

The companion must bind to the source runtime's account, workspace and lifetime. A workspace
switch, sign-out, or source renderer loss invalidates that binding. If the companion is expected
to stay editable after the source closes, it needs an explicitly retained, authorized runtime or
a handoff to a matching live owner. A new renderer can also reuse dates and page state through a
narrow notes interface, but edits and persistence need an explicit protocol in that design.
Keep the [existing standalone path](../../implemented/architecture/2026-11-25-today-window-local-open.md)
available for opens without a matching live source while evaluating a replacement.

## Evidence and limits

An isolated Linux arm64 Electron app opened a same-origin `about:blank` child. The parent and
child had the same renderer PID. A child call updated the same JavaScript Map read by the parent.
The default child closed when the parent was destroyed. With `outlivesOpener: true`, the child
stayed open and could still read and update the retained Map. This verifies the browser mechanism.
Lody's React providers, IPC, editor selections and native menus also depend on the document or
workspace lifetime. A production test needs to cover editing and input methods in the companion,
simultaneous editing, workspace invalidation, main-window close, and reopening the app to verify
persistence.
