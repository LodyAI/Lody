# Preserve Claude task actors across completion

Status: implemented
Translation: current

[中文](2026-10-26-claude-task-actor-preservation.zh.md)

## Abstract

Claude terminal task events can omit their type after a start event identified a Bash task. Writing the display fallback `Claude task` into actor metadata lets the later history merge replace `local_bash`, so completed rows lose their Bash label and linked command. Keep the fallback in the rendered title, but omit actor metadata when no provider identity is present. Explicit subagent, workflow, and task types remain recorded; the existing task-id merge preserves earlier identity when a later event omits it.

## Evidence and decision

`convertClaudeTaskLifecycleNotification` creates an ACP task update from each Claude lifecycle event. History materializes `_meta.lody.task` and merges updates by `taskId`, with later defined fields winning. The task panel recognizes Bash through `actor === 'local_bash'` or `taskType === 'local_bash'`; the fallback actor therefore hides the linked command as well as changing the label.

The fix separates the rendered title fallback from an optional task-metadata fallback. Claude omits the latter, so an untyped event leaves the actor undefined and the existing merge preserves prior identity. Explicit `subagent_type`, start-event `workflow_name`, or `task_type` values still populate actor metadata. The shared converter also serves Kimi, whose established `Kimi task` actor fallback is retained through the explicit option; the Kimi test failed when that fallback was removed globally. Adding a separate task-type field would require changing the shared schema, parsing and UI consumers without improving this case.

The task id and ACP session scope are unchanged. Events continue through the existing delivery-order history merge. Terminal status monotonicity remains owned by `mergeSubagentTaskPayload`; this change only makes absent actor metadata preserve the earlier value during normal and reconstructed history.

## Validation

The owning behavior test converts `task_started(task_type=local_bash)`, an untyped
completed `task_notification`, and a late untyped `task_progress`, applies them through
the history writer, then checks the reconstructed task keeps one task id, the Bash actor,
completed status, and summary. In the independent clone at source commit
`779edf736b072965dcfb92618352e050a02620b5`, temporarily restoring Claude's missing-type
metadata fallback made that test fail: expected `actor: local_bash`, received
`actor: Claude task` (1 failed, 26 skipped). Restoring the committed converter made the
same owning suites pass: `33 passed` across `history.test.ts` and
`claude-task-lifecycle.test.ts`. Those suites also verify explicit task type updates and
the unchanged Kimi fallback. No regression test was added for this follow-up.

Storybook rendered the existing `SubagentTaskPanel` with a synthetic session-history
projection for the same event sequence. The real panel shows `Claude task` and no
Command section in the baseline; the fixed panel shows `Bash` and the linked synthetic
command. The screenshots identify the source SHA and input: [baseline panel](https://github.com/user-attachments/assets/b5b3dd76-9619-4ee2-bb6e-5db0993ec563), [baseline detail](https://github.com/user-attachments/assets/333e5b35-53aa-4f54-8604-dd882494a8a7), [fixed panel](https://github.com/user-attachments/assets/c0e930ff-179a-4c66-9e84-dc138ae1c001), and [fixed detail](https://github.com/user-attachments/assets/a72f27f5-95c6-4ce8-8f30-3ded400e95bb). The temporary story and fallback edit were confined to `/tmp/lody-1809-verify` and are not part of the PR.

Validation used Node 26.12.1 and a frozen root install in that independent clone. `pnpm
format` passed there. Full `pnpm check` stops in `prepare:acp-adapters` because the locked
Claude ACP submodule does not have its package-local TypeScript dependency installed;
the root workspace excludes that submodule's isolated dependencies. The changed behavior
is covered by the green local owning suites and the latest remote CLI and Static checks:
[CLI job](https://github.com/LodyAI/Lody/actions/runs/40297222519/job/121486103742),
[Static job](https://github.com/LodyAI/Lody/actions/runs/40297222519/job/121486103559).
The remote desktop smoke, browser tests, remaining test shards, and contribution checks
also passed on the same PR head. `pnpm run docs check` reports existing broken links to
absent ACP submodules and untranslated notes; the changed notes are not among them.

PR: https://github.com/LodyAI/Lody/pull/1906
