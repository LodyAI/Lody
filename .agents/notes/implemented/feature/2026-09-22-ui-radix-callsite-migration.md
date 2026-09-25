# UI v2 call-site migration: every Radix primitive's callers land on `@lody/ui`

Status: implemented
Translation: current

[中文版](2026-09-22-ui-radix-callsite-migration.zh.md)

## Abstract

The `@lody/ui` primitives existed but served zero callers: every Radix file in
`packages/components/src/ui` still owned its whole call graph. This change
migrates the remaining overlay and feedback call sites — tooltip, popover,
menu and context menu, dialog and alert dialog, toast, card, tabs, kbd,
progress and spinner, roughly 400 call sites across ~200 files — and deletes
the Radix wrappers. Three compatibility adapters stay in `src/ui` (`menu.tsx`,
`dialog.tsx`, `card.tsx`) for product semantics the primitives do not own; the
local `spinner.tsx` survives as a deliberately different component, the icon
animator, while `@lody/ui`'s Spinner takes the plain loading marks. The
migration cost one new prop on `@lody/ui` (`Dialog`'s `noAnimation`) and a
`data-slot="spinner"` test hook.

## Problem

The primitives shipped in the earlier notes of this series were verified on the
gallery board but idle: `Tooltip` served 49 local Radix callers, `Menu`/`ContextMenu`
37, `Dialog`/`AlertDialog` 60, `Popover` 14, `Toast` 60, plus 116 more across
card, tabs, kbd, progress and spinner. Until the callers moved, every Radix
file kept its Tailwind styling, its event semantics, and its test selectors,
and the token system the new package declares had no effect on product
surfaces.

## What migrated and what did not

Every in-repository caller of a deleted wrapper now imports `@lody/ui` directly
or through one of the three adapters. The deleted files: `tooltip.tsx`,
`popover.tsx`, `dropdown-menu.tsx`, `context-menu.tsx`, `dialog.tsx`,
`alert-dialog.tsx`, `sonner.tsx`, `tabs.tsx`, `kbd.tsx`, `progress.tsx`,
`loading.tsx`, `form.tsx` (dead), `workspace-list.tsx` (dead). The barrel
`src/ui/index.ts` re-exports the package modules for the names callers already
used.

`spinner.tsx` stays: it is the icon ANIMATOR (`icon` + `spinning`), a different
job from `@lody/ui`'s loading MARK (`size`/`label`/`tone`, no glyph prop). 11
callers need the animator; the other ~100 moved. `drawer.tsx` (Vaul bottom
sheet with mobile keyboard handling), `scroll-area.tsx` (patched Radix scroll
area), `command.tsx` (cmdk), `sidebar.tsx`, `resizable.tsx`, `slider.tsx` and
the product components (`collapsible-card`, `diff-viewer`, `mention`,
`emoji-picker`, `menu-styles`) have no package equivalent and are unchanged.

## The adapters and why they exist

`src/ui/menu.tsx` re-exports `@lody/ui`'s `Menu` and `ContextMenu` and owns
three pieces of product policy the primitives cannot know: the composer-focus
policy (an item press returns focus to the composer unless the item's own
`finalFocus` says otherwise; escape and outside press use Base UI's default),
`MenuSearchInput`, and a standalone `Menu.Label` for group headings that are
not a `Group`'s child.

`src/ui/dialog.tsx` owns `data-lody-dialog-content` (mention and editor code
finds the nearest dialog through it), the `WindowDragStrip` as backdrop
content, and `DialogContentWithoutClose` for the command palette.
`AlertDialog.Action`/`Cancel` are `Close` rendered as styled buttons — an
answer runs its `onClick` and then closes. The twelve async confirm callers
(revoke credentials, clear cache, delete provider, …) that used Radix's
`preventDefault`-keeps-open idiom were migrated to the Base UI model instead:
an answer that stays open is a plain `Button`, and the dialog closes through
the root's controlled `onOpenChange` when the work resolves. Every one of
them already owned a controlled `open`; `machine-detail-pane.test.tsx` is the
pinned proof that a failed revoke leaves the dialog open.

`src/ui/card.tsx` adds the `Card.Content` div the package export does not
carry.

## What the migration surfaced

- **Event semantics differ.** Base UI menu triggers open on `mousedown`
  scheduled in a frame, not Radix's `pointerdown`; submenu hover is
  `mousemove`; context menus still take `contextmenu`. A dozen test files
  opened menus with `pointerdown` and read them synchronously; all were
  switched to `mousedown` plus a real-timer frame flush. jsdom's rAF is a real
  timer, so the flush is a `setTimeout` beat, not a scheduler guess.
- **A popover whose rows are menu items is a `Menu`.** The fork-destination
  surface marked its `Popover.Content` `role="menu"` and hand-wrote
  `role="menuitem"` buttons; it is `SessionForkDestinationMenu` on real
  `Menu.Item`s now, which also gives it the arrow-key navigation the manual
  rows lacked. Base UI's `Popover.Popup` stays `role="dialog"`.
- **Composition state is tracked at document level.** The bug-report dialog's
  IME test needed a `compositionend` between the Escape that cancels
  composition and the Escape that closes — realistic IME sequencing, not a
  workaround.
- **Chromium compositing rule moved with the component.** `@lody/ui`'s
  Spinner animates a `data-slot="spinner"` HTML wrapper, never the `<svg>`
  (crbug.com/1186312). The components-side invariant tests now accept either
  wrapper marker; the package's own test pins the structure.
- **`Tooltip` is visual-only in Base UI** — no `role="tooltip"`, no
  `aria-describedby`. Tests that queried the role now find the positioner;
  icon-only triggers name themselves, which the migrated callers already did.

## Verification

`pnpm check` green: full typecheck, the boundary guards, and both suites —
`packages/components` 484 files / 3858 tests, `packages/ui` 23 files / 275
tests. `pnpm run docs check` clean; `pnpm format` applied.

## Limits

The three adapters mean `src/ui` is not empty; deleting them is a caller-by-
caller API change, not a wrapper removal. `Spinner`'s two identities are a
documented split (`src/ui/AGENTS.md`), not a migration debt. Vaul drawer and
the patched scroll area stay on their own dependencies until the package grows
equivalents. Mobile surfaces were migrated by typecheck and the shared tests;
no device pass ran.

The real-Electron P0 smoke suite later caught the regressions unit tests
could not — a popup `z-index` trapped inside its positioner's stacking
context, dropped `closeButton={false}` flags, and per-level Escape. See
[popup positioner stacking](../bug-fix/2026-09-23-popup-positioner-stacking.md).
