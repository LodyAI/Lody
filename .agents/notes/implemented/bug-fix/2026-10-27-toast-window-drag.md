# Toast controls over the window drag strip

Status: implemented
Translation: current
PR: https://github.com/LodyAI/Lody/pull/1943

[中文](2026-10-27-toast-window-drag.zh.md)

## Abstract

The reported toast close button sits over the desktop header. Portalled toast
cards had pointer events enabled but no native drag exclusion, leaving their
controls exposed to Electron's window drag hit testing. The shared toast card
now declares `-webkit-app-region: no-drag`; the viewport remains pointer-transparent.
The patch has not been verified in a running desktop.

## Evidence and scope

The existing Tailwind drag exclusion covers controls descended from
`app-region-drag`; the toast portal is outside that subtree. CSS stacking and
`pointer-events: auto` alone do not exclude native dragging. The exclusion belongs
to each visible card, preserving dragging in gaps between cards and covering both
close and action buttons without changing their handlers.

This extends the [feedback primitives](../feature/2026-09-12-ui-feedback-primitives.md)
implementation. The existing feedback suite exercises close-button dismissal,
but its DOM environment cannot validate Electron native hit testing. Package
typecheck and tests were attempted and blocked by missing dependencies
(`@types/node` and `vitest`); desktop pointer validation remains outstanding.
