# Emoji picker renders on the popup's own rung, not `--popover`

Status: implemented
Translation: current

[中文](2026-09-25-emoji-picker-surface.zh.md)

## Abstract

The Agent Role emoji picker rendered as a near-black slab (`#101010`) inside the
lighter popup that hosts it, because the shadcn `frimousse` registry code paints its
root with `bg-popover` — a Tailwind variable this repo derives from the bundled VS
Code theme's `editorWidget.background`, while the `@lody/ui` `Popover` surface uses
the StyleX floating-rung token `colors.raisedBackground` (`#232323` in Vesper dark).
The picker now carries no surface color of its own: the root is transparent and only
the sticky category header keeps a fill, set to `raisedBackground` so it stays
identical to the popup in both palettes. The same pass fixed the registry's dead
`data-[active]:bg-accent` (`--accent` is never declared, so cell highlight silently
resolved to nothing) with the app's overlay hover convention, and tightened the
popover chrome around it: `EmojiField` now passes `gap-1 p-1` on `Popover.Content`
(the shared panel's 12px padding and 10px gap read loose around a dense grid).
The "reset to default" ghost button stays centered under the picker — a
full-width left-aligned row was tried and read worse.

## Problem and evidence

In the "New Agent Role" dialog the picker was visibly darker than the popover frame
around it. Two theming systems meet there: `Popover`'s popup reads the `@lody/ui`
StyleX token `popup.background` = `colors.raisedBackground`, while the picker's
registry `bg-popover` reads `--popover`, which `vscode-theme-css.ts` resolves from
`editorWidget.background → quickInput.background → panel.background →
sideBar.background`. Vesper sets `editorWidget.background: #101010`, so the picker
painted a darker layer over the surface meant to be seen.

Measured in Storybook before the change: picker root and category header computed to
`rgb(16, 16, 16)`; after, the root computes `rgba(0,0,0,0)` and the sticky header and
popup both compute `rgb(35, 35, 35)`.

## Constraints discovered

- frimousse's category headers are `position: sticky; top: 0` by default, so the
  header still needs an opaque fill or scrolling rows show through — it takes
  `colors.raisedBackground` via StyleX rather than naming the popup token.
- `--accent` is declared nowhere in the repo, so `data-[active]:bg-accent` produced
  an invalid `hsl()` and no highlight at all. Cells now use the overlay hover fill
  from `src/ui/AGENTS.md` (`bg-foreground/[0.05]` light, `bg-white/[0.10]` dark).
- Storybook's `viteFinal` had not registered `vite-emojibase-assets.ts`, the plugin
  that serves the picker's bundled dataset. The emoji-picker section of
  `src/ui/AGENTS.md` requires every host build to register it; Storybook now does,
  or the picker would spin forever in stories.

## Alternatives

- Overriding `bg-popover` with another Tailwind surface token (`bg-card`, etc.) at
  the call site: still a different color than the popup rung, and the sticky header
  is internal to the primitive so the divergence would remain.
- Changing the `--popover` alias rule or Vesper's `editorWidget.background`: moves
  every `bg-popover` consumer (mention menus, command palette, annotation overlays,
  mobile pickers) or every editor widget — too wide for this defect.

## Verification limits

Verified in Storybook (`Settings/AgentRoleForm`, dark + zh_CN) with before/after
screenshots and computed-style reads, including a scrolled list where the sticky
header masks rows correctly. Light mode is covered structurally (both sides read
`raisedBackground`) but was not screenshotted.
