# Close the command palette from its own Escape handler

Status: implemented
Translation: current

[中文版](2026-09-25-command-palette-escape-dismiss.zh.md)

## Abstract

The command palette stayed open in the desktop smoke journey after Escape because focus can remain on the Base UI dialog surface rather than inside cmdk. While the palette is open, a temporary window-capture listener now closes it regardless of that focus placement, while an active IME composition keeps first refusal of Escape. A stateful component test sends Escape from outside the palette subtree; the packaged Electron smoke journey still needs a fresh CI run to confirm the original failure is cleared.

## Evidence and decision

The `LODY-SHORTCUT-001` smoke run failed after `Meta+K` opened the palette: its follow-up Escape left the exact command-palette input visible until Playwright's five-second assertion timed out. The trace and retained failure screenshot show the palette still open at capture time. The failing journey was unrelated to the mention-menu files in the PR, but it exposed that this palette relied entirely on the Base UI Dialog's document listener for Escape dismissal.

`CommandPaletteView` now installs a window-capture Escape listener only while its controlled `open` state is true, and closes through its existing callback. The trace shows the palette input is visible after Escape, but the cmdk-root handler does not close it; the Base UI dialog may retain focus on its popup surface when opened from the global shortcut. Capturing while the palette is active makes dismissal independent of the focused descendant. The shared IME predicate leaves Escape available to cancel composition, and cleanup removes the listener as soon as the palette closes or unmounts. The dialog continues to provide focus management and other dismissal behavior.

The behavior is recorded in the [sidebar search Spec](../../../../specs/sidebar-search.md), which remains draft because this change has no human approval. The regression test asserts the visible input remains during composition and disappears after a normal Escape.

## Verification limits

- `packages/components/tests/command-palette-view.test.tsx` covers Escape dispatched outside the palette subtree and IME composition behavior.
- The OSS Electron app builds locally, but this Linux runner has no X server or `$DISPLAY`; every smoke scenario fails before Electron can open a window. A fresh CI run is required to verify the original `LODY-SHORTCUT-001` failure is cleared.
