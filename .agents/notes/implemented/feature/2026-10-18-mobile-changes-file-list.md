# Align mobile change navigation with the desktop list

Status: implemented
Translation: current

[中文版](2026-10-18-mobile-changes-file-list.zh.md)

## Abstract

Desktop change-stat presses open a categorized file list, while mobile previously entered the multi-file diff immediately. Mobile now opens the same Types/Files list first, preserving the shared classification, totals, unknown-stat and readiness behavior. Selecting a file enters All Changes with the complete path set and an exact focus request; Back retains the list and previously opened diff state while pausing hidden reads. Precise conversation-file and comment links continue to bypass the list. This is shared responsive UI, without a new native or data protocol.

## Flow and ownership

```text
change statistics → shared Types/Files list → select file → focused All Changes diff
                              ↑                    │
                              └────── Back ────────┘
file/comment link ───────────────────────────────→ precise diff
```

`SessionDetail` retains ownership of the source, selected file, comment focus and request sequence. Its mobile view records first-level browsing, diff viewing, or returning to the list after a diff has mounted. Selection clears any previous comment target and issues a fresh sequence, including repeated selections. Existing live summary updates retain this view state. New session/turn/comment navigation still replaces the target through the existing handlers.

`SessionMobileDiffDrawer` presents both levels in one drawer. It reuses `SessionChangesSidebar` rather than duplicating category inference, file-tree construction or statistics. Its initial list does not mount the diff subtree. After selection, the list remains mounted to retain category expansion, Types/Files mode and scroll; Back retains the diff subtree and marks the hidden branch inert. The caller passes `active=false` to the retained diff so existing viewport/request owners pause admission. The existing data hooks, caches, request fencing and complete-input comparison are unchanged; this presentation change adds no Effect migration unit.

Keeping both levels in one modal avoids a sibling-drawer handoff. The existing [mobile modal-containment decision](../bug-fix/2026-10-03-mobile-diff-portal-scope.md) still owns the popup host, and the [file-preview handoff](../bug-fix/2026-09-28-mobile-diff-file-handoff.md) remains unchanged. Opening a source file closes the diff before entering the file viewer. Existing local telemetry gating remains in place; summary entry and actual diff entry use the corresponding existing sidebar/viewer events.

## Validation and limits

The owning navigation suite covers the categorized first level, aggregate totals, exact-path/full-set selection in both modes, retained comment input and list mode across Back, missing statistics, readiness/errors and direct-diff entry. The existing drawer suite now mounts the complete production wrapper inside the legacy session modal for initially-open and click-open cases, verifying pointer containment, focus, selection and closing only the inner drawer. The existing diff-panel suite preserves focused-file and viewport behavior.

Computer Use exercised the real drawer, shared sidebar and diff panel at a 390×844 viewport using synthetic provider data: category selection, Back, directory-tree selection, another focused diff, and Chinese/dark rendering without horizontal overflow. This browser fixture does not run the full SessionDetail runtime or physical iOS/Android gestures; native-device acceptance remains separate. No private screenshots, transcripts or captured file contents are committed.

The [file-surface guide](../../../docs/sessions-file-surfaces.md) and [story guide](../../../docs/sessions-stories.md) describe current behavior and the dedicated fixture. The 41 targeted tests, root `pnpm check` (including 577 component files / 5,606 tests), root `pnpm format`, and diff whitespace checks passed. Docs check reports only six existing links into uninitialized Kimi/Pi submodules, with no protected-topic changes.
