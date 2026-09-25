# Close the command palette from its own Escape handler

Status: implemented
Translation: current

[中文版](2026-09-25-command-palette-escape-dismiss.zh.md)

## Abstract

The command palette stayed open in the desktop smoke journey after Escape because Base UI focuses the dialog popup itself, outside cmdk's keyboard handler. The popup now handles Escape in its capture phase, while an active IME composition keeps first refusal of Escape. A stateful component test sends Escape directly to the popup surface; the packaged Electron smoke journey still needs a fresh CI run to confirm the original failure is cleared.

## Evidence and decision

The `LODY-SHORTCUT-001` smoke run failed after `Meta+K` opened the palette: its follow-up Escape left the exact command-palette input visible until Playwright's five-second assertion timed out. The trace and retained failure screenshot show the palette still open at capture time. The failing journey was unrelated to the mention-menu files in the PR, but it exposed that this palette relied entirely on the Base UI Dialog's document listener for Escape dismissal.

`CommandPaletteView` now handles Escape on `Dialog.Content` in the React capture phase and closes through its existing controlled callback. The CI screenshot shows focus on the popup surface, not inside the cmdk subtree, so a handler on cmdk's root cannot receive the key event. The popup boundary handles the event regardless of which descendant or the popup itself has focus. The shared IME predicate leaves Escape available to cancel composition. The dialog continues to provide focus management and other dismissal behavior.

The behavior is recorded in the [sidebar search Spec](../../../../specs/sidebar-search.md), which remains draft because this change has no human approval. The regression test asserts the visible input remains during composition and disappears after a normal Escape.

## Verification limits

- `packages/components/tests/command-palette-view.test.tsx` covers Escape dispatched to the popup surface and IME composition behavior.
- The OSS Electron app builds locally, but this Linux runner has no X server or `$DISPLAY`; every smoke scenario fails before Electron can open a window. A fresh CI run is required to verify the original `LODY-SHORTCUT-001` failure is cleared.
