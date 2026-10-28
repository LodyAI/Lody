# Keep native iOS side drawers sized to the current viewport

Status: implemented
Translation: current

[中文](2026-10-27-ios-drawer-resize.zh.md)

## Abstract

A native iOS conversation drawer could keep its expanded-display height after a
keyboard-open fold or rotation, leaving the composer below the smaller display.
Vaul remembers the focused drawer's initial height and later restores that value.
The shared side-drawer adapter now disables that height owner on native iOS,
preserving CSS sizing and the surface's existing native keyboard offset. Other
hosts retain the live viewport inset; bottom sheets and snap-point drawers retain
their separate behavior.

## Decision and evidence

The native simulator reproduction opened an existing conversation, focused its
composer, resized between outer and inner displays, then dismissed the keyboard.
The conversation header remained visible while its composer fell below the outer
display. Navigating back showed a correctly sized conversation list, isolating the
retained side-drawer geometry rather than the whole native viewport.

Vaul 1.1.2's `onVisualViewportChange` stores `initialDrawerHeight` once and can write
it back after the available window has changed. Native iOS was excluded from the
shared adapter's protection against this cached height. iOS conversation composers
already lift themselves with the host keyboard offset; file drawers explicitly own
their bottom inset. Keep those owners rather than adding another drawer resize.

The adapter applies this rule only to eligible left/right drawers. Explicit opt-out,
snap points and bottom sheets keep their previous behavior. No remount key is added:
rebuilding a drawer on every resize would discard focus and transient input state.
This extends the ownership established by the
[file-editor keyboard decision](2026-10-08-mobile-file-editor-keyboard.md) to native
iOS side drawers without changing bottom sheets.

## Validation

The existing drawer suite renders the real Vaul adapter with a focused field and
synthetic draft, then drives keyboard-open expansion, folding and dismissal. Before
the fix it fails on a cached inline height; after the fix CSS sizing, focus and draft
survive all transitions. The drawer, mobile file-viewer and mobile diff suites pass
(33 tests), including the existing Android/browser inset behavior. Native product
retesting crossed from a wide chat with the keyboard open back to a phone layout:
the same chat and composer remained visible after the keyboard dismissed.
Typechecking and linting passed. Mobile-to-mobile transitions, physical devices and
floating-keyboard acceptance remain distinct from JSDOM geometry checks.
