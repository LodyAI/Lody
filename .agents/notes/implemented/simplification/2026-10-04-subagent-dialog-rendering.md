# Share conversation rendering in the subagent dialog

Status: implemented
Translation: current

[中文](2026-10-04-subagent-dialog-rendering.zh.md)

## Abstract

The subagent dialog rendered tools with the parent conversation's components,
but placed every item in a flat list, used a separate plain command brief, and
omitted the parent file-open callback. The dialog now shares conversation activity
grouping, command highlighting and file links while keeping its own task-scoped
folding state. Task state, rows, dialog details and message layout have separate
owners, with adjacent StyleX files for each visual surface. The dialog still reads
only retained child output and adds no child execution controls.

## Decision

`SubagentRunMessageList` uses `buildAssistantTurnRenderBlocks`; the host supplies
its existing Markdown, plan, tool and activity-header renderers. Keeping renderer
injection avoids a dependency from the task panel back into the session's large
view module. Groups initially expose all steps and preserve reader folding across
updates. Surrounding prose remains visible, and dialog rows never register search
blocks in the parent conversation.

The background-command brief uses `ToolCommandSection` inside `ToolDetailSheet`,
sharing the worker-backed shell highlighting introduced by the
[tool detail decision](../feature/2026-09-26-tool-step-detail-sheet.md).
The brief's separate vertical height cap is removed so the dialog body owns
vertical scrolling. Task state and cancellation semantics remain those in the
[subagent Spec](../../../../specs/subagent-events.md); the
[earlier client-surface decision](2026-09-12-subagent-client-surface.md) continues
to explain why unused output/list APIs are absent.

The panel retains its existing import path. Task-state helpers and dialog behavior
move into separate modules; panel, detail and message layout have adjacent
`.stylex.ts` files. The conversation supplies spacing tokens, and UI text roles
replace fixed detail font sizes. Storybook uses the production history renderer
instead of displaying step titles as plain list items.

Thought prose in both parent and child activity rows explicitly uses compact
Markdown, sharing the summary/tool subheadline role and leading. The prior
secondary-text class could not override Markdown’s inline body size, leaving
thoughts at 14px beside 13px summaries. This corrects the typography mismatch
without changing ordinary answer prose.

## Verification

The four focused suites pass 39 tests, including command-sheet rendering,
activity folding, live-tail state, task updates, cancellation failure and mobile
drawer portal ownership. Scoped formatting and lint pass. Browser checks exercised the production Storybook dialog on desktop and at
390px inside the mobile drawer, including folding and one body scroller.
Two browser regression tests verify that thought prose, the activity summary and
tool rows all compute to 13px in light/dark themes, with 18px thought leading.
Full component type checking still reports three dependency-version diagnostics
in untouched Markdown/runtime modules; no diagnostics remain in changed source.
The documentation and public-boundary checks pass after initializing the ACP
submodules. No SHA-protected documentation topics changed. Root `pnpm check` was
attempted but cannot complete with the worktree dependencies: the documentation
precheck lacks `fumadocs-mdx`, and the initialized Claude ACP adapter lacks its
Node types and `@tsconfig/node22` dependencies.
Native Electron and physical-device touch verification were not run.
