# Local project sidebar ordering

Status: implemented
Translation: current

[中文](2026-09-20-local-project-sidebar-ordering.zh.md)

## Abstract

GitHub repository groups in the desktop sidebar could be reordered, while local
project folders were fixed in creation order. Local projects now use the same
drag-handle interaction within each machine section, with a workspace-scoped,
machine-qualified persisted order. Saved entries survive temporary catalog
disappearance so an offline or reconnecting machine does not reset the user's
layout; mobile remains non-draggable.

## Decision and evidence

The ordering preference belongs to sidebar state rather than project metadata:
it changes one user's presentation and must not mutate a shared project catalog.
`localProjectOrderAtom` therefore mirrors repository ordering's per-workspace
storage, but stores `${machineId}:${localProjectId}` keys because a local project
id is scoped to its machine.

Each visible machine section owns one dnd-kit context. This keeps reordering
inside the machine boundary and moves the complete project group, including its
expanded Sessions. The activator is an explicit hover handle, so the project row
continues to navigate and Session rows continue to provide their existing HTML5
mention drag behavior.

The catalog projection first applies saved ranks, then the previous deterministic
creation-time/name fallback for unseen projects. Discovery appends keys without
deleting absent ones; a transient visibility or connection change therefore does
not erase an existing preference.

## Verification and limits

- `sidebar-local-project-order.test.ts` verifies workspace isolation and the
  no-workspace write guard for the persisted atom, plus retention of hidden and
  other-machine entries during a move. Existing rendered local-project row and
  worktree sidebar tests also pass.
- The Components type check reached pre-existing Electron login/update and
  session activity errors, with no diagnostic in the changed files. The docs
  check likewise reached only the repository's pre-existing broken submodule
  links.
- Reordering is intentionally desktop-only and cannot cross machine sections.
