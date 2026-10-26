# Preserve Claude task actors across completion

Status: implemented
Translation: current

[中文](2026-10-26-claude-task-actor-preservation.zh.md)

## Abstract

Claude terminal task events can omit their type after a start event identified a Bash task. Writing the display fallback `Claude task` into actor metadata lets the later history merge replace `local_bash`, so completed rows lose their Bash label and linked command. Keep the fallback in the rendered title, but omit actor metadata when no provider identity is present. Explicit subagent, workflow, and task types remain recorded; the existing task-id merge preserves earlier identity when a later event omits it.

## Evidence and decision

`convertClaudeTaskLifecycleNotification` creates an ACP task update from each Claude lifecycle event. History materializes `_meta.lody.task` and merges updates by `taskId`, with later defined fields winning. The task panel recognizes Bash through `actor === 'local_bash'` or `taskType === 'local_bash'`; the fallback actor therefore hides the linked command as well as changing the label.

The fix omits only an absent actor from task metadata. The title still uses the established localized display fallback, and explicit `subagent_type`, start-event `workflow_name`, or `task_type` values still populate actor metadata. Adding a separate task-type field would require changing the shared schema, parsing and UI consumers without improving this case: omission already represents “no new identity” in the existing merge contract.

The task id and ACP session scope are unchanged. Events continue through the existing delivery-order history merge. Terminal status monotonicity remains owned by `mergeSubagentTaskPayload`; this change only makes absent actor metadata preserve the earlier value during normal and reconstructed history.

## Validation

The regression test converts a synthetic `local_bash` start and untyped completion, applies both through the history writer, and checks the reconstructed task retains the Bash actor, completed status and summary. Converter tests check that the display fallback remains while absent actor metadata is omitted, and that an explicitly reported task type is retained.

The test could not run locally because this nested checkout has no `node_modules` and
`vitest` is unavailable. The repository check and full formatter also stop on missing
workspace tools; the changed files pass the pinned Oxfmt check through `pnpm dlx`.
The checkout has Node 26.11.1, below the declared 26.12.1 floor, and no other installed
version meets the floor. The local desktop build stops before launch for the same missing
dependencies, so no actual UI before/after capture was produced. `pnpm run docs check`
reports existing broken links to absent ACP submodules and missing translations; neither
new note is reported. These limits are recorded rather than treated as passing acceptance.

PR: pending
