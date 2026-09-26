# One focus edge for nested editors

Status: implemented
Translation: current

[中文](2026-09-26-single-focus-edge-for-nested-editors.zh.md)
[PR #1030](https://github.com/LodyAI/Lody/pull/1030)

## Abstract

Several editing surfaces drew a focus edge on a wrapper and another on its inner input. The shell's legacy `:focus-visible` shadow affected bare native inputs, while the shared Textarea drew its own well ring. Wrapper-owned fields now suppress the inner edge; the message editor uses a bare Textarea appearance, and archive rows leave focus indication to their actual controls. This keeps keyboard focus visible while removing nested rectangles. Visual verification in the running app remains outstanding because this checkout has no installed dependencies.

## Problem and evidence

The Prompt Shortcut editor's mention textarea sits inside a `:focus-within` well, but the global input rule also draws an inset shadow on the textarea. The browser address field, mobile filter search, and queued-message editor used the same native-input combination. `focus-visible:ring-0` on the queued-message textarea did not affect that shadow because the global rule sets `box-shadow` directly. The in-place user-message editor nested the shared Textarea's well ring inside a card with its own focus edge. Archive rows similarly drew a row-wide ring whenever a title, checkbox, or action inside gained focus.

## Decision

The component that visually owns a field owns its focus edge. Native inputs inside wrapper-owned fields use `focus-visible:shadow-none`; the wrapper's focus style remains. The shared Textarea now offers `appearance="bare"` for a parent-owned field, reusing the existing `well.bare` style used by composed Inputs. The default Textarea remains a self-contained well. Archive rows keep their separator and hover behavior but leave keyboard focus indication on the actual title, checkbox, or action.

This follows the [field primitive decision](../feature/2026-09-09-ui-field-primitives.md) and the [UI primitive Spec](../../../../specs/ui-primitives.md). A single global exception for all inputs would also erase focus indication from standalone fields, so each composed field states which element owns its edge.

## Verification

The changed selectors were checked against the global focus rule, the StyleX field styles, and the rendered component structure. The bare Textarea appears in the UI gallery for visual inspection. `git diff --check` passed, and the edited TypeScript files were formatted with the repository's Oxfmt version. The full type/test/format scripts and visual checks could not run in this checkout because its `node_modules` directory is absent; the repository's nested-checkout guidance skips installation. The documentation checker reports existing broken links to absent ACP submodules, with none in the new note.
