# Mobile file editor keyboard layout

Status: implemented
Translation: current

[中文](2026-10-08-mobile-file-editor-keyboard.zh.md)

## Abstract

The full-screen mobile file drawer could leave the bottom of its editor behind
the software keyboard: iOS lacked the native keyboard inset, and browsers opted
out of repositioning. The drawer now uses the host-provided inset on native iOS
and the shared live viewport inset elsewhere. Vaul does not independently resize
this drawer, avoiding competing height adjustments. Automated tests cover inset
selection and restoration; physical-device keyboard animation remains unverified.

## Decision and evidence

`MobileFileViewerDrawer` owns native iOS's CSS bottom inset and disables Vaul
repositioning there. Other hosts explicitly enable repositioning; the shared
`Drawer` now accepts this explicit browser opt-in as well as its existing native
path. Browser callers that omit the option retain their previous behavior.
Keyboard hide and already-resized WebViews produce zero viewport inset. Existing
Monaco automatic layout observes the resulting smaller editor container.

Keeping Vaul's height adjustment alongside the native inset would give two owners
to the same geometry. Changing every drawer's iOS layout would also affect sheets
that already own their keyboard handling, so this fix stays at the file surface.
See [mobile UI](../../../docs/ui-mobile.md#pickers-and-keyboards) for ownership.
This repairs layout without changing editing or persistence intent.

## Validation

The owning drawer suites exercise the real shared drawer, browser/native overlay
resize and hide, native iOS inset selection, and retained CSS height. They cannot
establish native keyboard animation or caret visibility on physical devices.
