# Close the command palette from its own Escape handler

Status: implemented
Translation: current

[中文版](2026-09-25-command-palette-escape-dismiss.zh.md)

## Abstract

The command palette stayed open in the desktop smoke journey after Escape, leaving its controlled state dependent on the modal's document-level dismissal listener. The palette now closes from its own focused command surface, while an active IME composition keeps first refusal of Escape. A stateful component test covers both outcomes; the packaged Electron smoke journey still needs a fresh CI run to confirm the original failure is cleared.

## Evidence and decision

The `LODY-SHORTCUT-001` smoke run failed after `Meta+K` opened the palette: its follow-up Escape left the exact command-palette input visible until Playwright's five-second assertion timed out. The trace and retained failure screenshot show the palette still open at capture time. The failing journey was unrelated to the mention-menu files in the PR, but it exposed that this palette relied entirely on the Base UI Dialog's document listener for Escape dismissal.

`CommandPaletteView` now owns Escape on the cmdk root and closes through its existing controlled callback. It uses the shared IME event predicate so Escape during composition remains available to cancel composing text. This keeps the behavior local to the palette and avoids adding an application-wide keyboard listener. The existing dialog continues to provide focus management and other dismissal behavior.

The behavior is recorded in the [sidebar search Spec](../../../../specs/sidebar-search.md), which remains draft because this change has no human approval. The regression test asserts the visible input remains during composition and disappears after a normal Escape.

## Verification limits

- `packages/components/tests/command-palette-view.test.tsx` covers normal Escape and IME composition behavior.
- The OSS Electron app builds locally, but this Linux runner has no X server or `$DISPLAY`; every smoke scenario fails before Electron can open a window. A fresh CI run is required to verify the original `LODY-SHORTCUT-001` failure is cleared.
