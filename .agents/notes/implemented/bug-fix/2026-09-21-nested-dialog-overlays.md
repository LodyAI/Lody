# Nested dialog overlay order

Status: implemented
Translation: current

[中文版](2026-09-21-nested-dialog-overlays.zh.md)

## Abstract

Nested dialogs placed both backdrops below the parent panel because all overlays
used z-index 70 while all panels used 80. The shared Dialog overlay now uses the
same layer as its content, matching AlertDialog. Portal DOM order places a newly
opened backdrop between the earlier panel and its own panel. Browser validation
covered CSS stacking; application interaction remains unverified without dependencies.

## Decision and evidence

Correction 2026-09-25: the mechanism below described the Radix-era
`DialogOverlay` adapter. Under Base UI a nested root mounts no backdrop at all,
so the per-caller overlay classes silently stopped working; ownership moved to
the primitive — see
[2026-09-25-modal-nested-backdrop](2026-09-25-modal-nested-backdrop.md). The
shared-z-rung invariant this note established still holds.

[DialogOverlay](../../../../packages/components/src/ui/dialog.tsx) owns the fix for
both content variants. Sharing `--z-dialog` avoids a separate nesting counter and
preserves caller overrides, animations, and Radix focus/dismissal handling. Existing
popover portals already use the same layer and DOM ordering. This fixes implementation
behavior without changing product intent.

An isolated Chromium fixture reproduced the old ordering at 70 and checked the fix
at 80 with two and three panels, each top panel above its backdrop, and parent
restoration after removing child layers. This fixture does not exercise React or
Radix. Storybook could not start because this checkout has no node_modules; no
component tests or typecheck ran. `git diff --check` passed. Documentation checking
reports pre-existing broken links into unavailable ACP submodules.
