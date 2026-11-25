# Share the desktop renderer in the lightweight Today window

Status: implemented
Translation: current

[中文](2026-11-25-today-shared-renderer.zh.md)

## Abstract

A local desktop Today window opened from the matching primary workspace shares the
primary renderer and its live notes cache. The child is a separate native window with
its own pin state and document. It mounts the Today surface through a React portal.
The independent desktop entry still serves windows without a matching source and
replaces a child whose source closes, reloads, or crashes.

## Decision

- The primary runtime supplies the page cache and observes the Today date prefix.
  The child acquires a reference to the same page store and can display its current
  snapshot immediately. A first consumer may still initialize the Today date index.
  The child starts no router, workspace admission, Repo, or broad metadata scan.
- Main admits a single-use named blank popup from the registered primary window.
  It blocks child navigation and grants no new IPC authority to that document.
  Pin and fullscreen updates are addressed to the native companion. Product menu
  actions use the opener, and the close-window shortcut closes the companion.
- A binding is valid only for the exact active runtime and workspace. Leaving that
  scope or disabling Today closes the child and releases its page reference. Native
  source close, reload, crash, or a failed first reveal returns to the
  [independent window](2026-11-25-today-window-local-open.md) with the last member,
  date, and pin state. Quit suppresses the replacement. Main does not replay edits.
  Existing per-window storage separates the successor's replica and cursor.
- The shared path inherits the opener's renderer scheduling and crash boundary.
  Editor geometry, clipboard handling, pointer listeners and popup hosts use the
  companion document. The isolated renderer path remains available to cloud mode
  and local attempts without the matching primary runtime.

## Evidence

The repository's built Electron and bundled CLI ran with a synthetic local workspace
of 300 conversations on Linux arm64 and Xvfb. The native window IDs differed while
their renderer PID matched. The companion displayed a saved day, pinned independently,
edited the page with its own text focus, displayed a menu in its own document, and
handed off to the independent window on source close or reload with the edit and pin intact.
Force-crashing the shared renderer reopened the saved day through the standalone path. Closing
and reopening the child reused the source renderer again. Disabling Today closed it without
starting a replacement. Five opens took 60–63 ms from main receiving the request to showing
the native child, with the source workspace loaded.
The [editor suite](../../../../packages/components/tests/today-editor.test.ts) covers
selection in the document that owns the outline. Native IME, macOS and Windows
window-manager behavior still require platform acceptance.
