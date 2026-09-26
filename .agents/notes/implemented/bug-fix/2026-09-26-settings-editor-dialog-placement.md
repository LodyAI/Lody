# Centre settings editors on the page pane and keep them drawn while they close

Status: implemented
Translation: current

[中文](2026-09-26-settings-editor-dialog-placement.zh.md)

## Abstract

The settings editor dialogs (Agent Role, MCP server, Prompt Shortcut) were
centred on the window. The settings overlay puts a 240px nav on the left, so an
editor sat over the seam between the nav and the page it was opened from. They
also blinked on Escape: the body vanished in the first frame and the panel
collapsed to its header while it faded. The editors now centre on the page pane,
whose measured centre reaches the panel through a new `centerOn` prop on
`@lody/ui`'s modal panels. They also keep rendering the value they closed on
until Base UI reports that the exit transition has finished. CSS anchor
positioning was tried first. It was rejected because the Chromium that Electron
ships resolves `anchor()` without the settings panel's centring transform.

## Placement

`SettingsPaneHeaderProvider` now also carries the page pane element, and
`useSettingsPane()` returns it. `Dialog.Content` and `AlertDialog.Content` take
`centerOn?: Element | null`. `useInlineCentre` (`dialog/parts.tsx`) measures the
element's horizontal centre in a layout effect, so the first paint is already
placed. It re-measures on the element's `ResizeObserver` and on the window's
`resize`, because the settings panel is window-centred and can move without
resizing. The panel receives an inline `inset-inline-start` of
`clamp(reach, <centre>px, 100% - reach)`. Here `reach` is half the panel's width
plus half of `dialog.inset`, so a narrow window pulls the panel back inside
rather than pushing it off an edge. The declaration is inline for the same
reason `width` is: a second StyleX class for the same property would be ordered
by the stylesheet, not by the caller.

Only the inline axis is moved. The pane spans the settings panel's full height,
and that panel is window-centred, so the block centres already agree. With no
element — the composer's Role picker, the mobile settings routes — the panel
stays window-centred.

Alternatives considered:

- **CSS anchor positioning**: `anchor-name` on the pane with `anchor()` in the
  clamp. A standalone Chromium 154 page placed it correctly. In the built
  desktop app (Electron 39), `anchor(--settings-pane left)` resolved to 830px
  while the pane's box started at 334px. The 496px gap is exactly half the
  settings panel's width, which is its `translate(-50%, -50%)`.
- **Portalling the editor into the pane**: this makes the settings panel's
  `transform` the containing block and clips the backdrop to the pane.
- **A hard-coded `50vw + 120px`**: this would silently drift if the nav width
  changed.

## Close without blinking

These dialogs are opened by a value (`open={editor !== null}`) and closed by
clearing it. `useDialogExitSnapshot` (`hooks/use-dialog-exit-snapshot.ts`)
returns the last non-null value as `shown` and clears it from the root's
`onOpenChangeComplete(false)`, so the form fades out with the panel. `open` stays
on the live value. The Role editor also routes `onChange` and `save` through
the live value, so an edit during the fade cannot reopen the dialog.
`machine-agent-settings.tsx` already solved the same problem for the Agent
config dialog with a separate open flag; the hook is the reusable form of that.

## Verification and limit

A throwaway desktop E2E scenario, not committed, opened Settings → Agent Roles →
Add role in the built Electron app at a 1180px window. The pane's centre and the
editor's centre were both at 710px. Sampled every frame after Escape, the editor
kept its name input and its 606px height until its opacity reached 0, and then
unmounted. `packages/ui/test/dialog.test.tsx` covers the measured centre, its
update on window resize, and the window-centred fallback.
`packages/components/tests/dialog-exit-snapshot.test.tsx` holds the exit
animation open and asserts the body is still drawn during `data-ending-style`.
It fails when the hook returns the live value. Narrow-window clamping was
checked only in a standalone Chromium page, not in Electron.
