# Preserve builtin Claude Bash task identity

Status: implemented
Translation: current

[中文](2026-10-26-claude-task-actor-preservation.zh.md)

## Abstract

Builtin Claude task lifecycle events use standard ACP `session/update` messages. An untyped terminal event must keep the display title fallback without replacing the task's previously reported `local_bash` actor in shared history. The adapter now omits only the absent actor field; task identity, merge behavior, and rendered title handling stay with their existing owners. A real adapter-to-history test and the task panel confirm the completed task remains Bash and keeps its linked command.

## Ownership and decision

`packages/acp-extension-claude/src/acp-agent.ts` owns `createClaudeTaskLifecycleUpdate`. Background tasks that do not negotiate async-task events reach `emitTaskLifecycle`, which sends standard ACP updates through `sendUpdate`. `AgentClient.sessionUpdate` forwards those updates to CLI history; the legacy `_claude/taskLifecycle` handler is a separate compatibility input and does not receive the current builtin producer's standard messages.

The adapter writes `_meta.lody.task.actor` only when `subagent_type`, `workflow_name`, or `task_type` supplies one. Its ACP tool-call title still falls back to `Claude task`. Shared history therefore merges completion and late-progress fields by task id while retaining the earlier `local_bash` actor and `toolUseId`; no new task-type schema or history branch is needed.

The CLI continues to consume `_claude/taskLifecycle` for older adapters, so its converter remains covered as a legacy path. The shared converter's optional `taskMetaFallbackActor` also remains: the Kimi test verifies its existing `Kimi task` fallback, while explicit event types continue to update the actor.

## Verification and ablation

The CLI history test now instantiates the real `ClaudeAcpAgent`, feeds a deterministic Bash tool call, `task_started(local_bash)`, untyped completion and late progress through its actual `sessionUpdate` callback, then replays those notifications into a fresh history document. It checks the final actor, task id, linked tool use, command, status and summary. The adapter owning suite covers the emitted standard payload, title fallback and explicit workflow type.

- **Red:** with adapter source `269960a27ef6679813c569cc0c73bf501114a23a`, the test fails at the emitted completion payload: expected no `actor`, received `Claude task` (1 failed, 26 skipped; exit 1).
- **Green:** with adapter source `cad4342265634ba3dcdc9f37e587a096596eaa67`, the same command passes (1 passed, 26 skipped; exit 0). `history.test.ts` plus `claude-task-lifecycle.test.ts` pass 33 tests, including explicit-type and Kimi compatibility cases.
- `npm run check`, `npm run build`, and the adapter `src/tests/acp-agent.test.ts` suite pass (604 passed, 10 skipped).
- `pnpm format` passes in the independent clone using Node 26.12.1. Full `pnpm check` completes typecheck, lint and effect lint, then `test:ci` reports 4,657 passed, 4 skipped and one failure in `src/session/git-identity.test.ts`: its explicit relative Git config case reads the host identity `wibus-wee` instead of the test's `Requester`. The focused case reproduces this local Git environment failure; it is outside this change.

Removing the conditional actor omission restores the red failure above. Keeping the display fallback in `title` preserves the current ACP presentation, and retaining the existing Kimi option is required by the Kimi compatibility assertion. No new abstraction or state was introduced.

## Visual evidence

The actual history records emitted by the baseline and fixed adapter runs feed the production `SubagentTaskPanel` and detail dialog. Both stories show the source SHA and the identical deterministic input sequence. Baseline shows `Claude task` without a Command section; fixed shows `Bash` and the linked `printf synthetic-background-output` command.

| Baseline (`269960a`) | Fixed (`cad4342`) |
| --- | --- |
| [Panel](https://github.com/user-attachments/assets/6c073031-f649-4090-9fb5-1aae6147a34a) · [Details](https://github.com/user-attachments/assets/c9f0120e-811c-43d6-9cef-0aee89a6d4d6) | [Panel](https://github.com/user-attachments/assets/40e8917a-b32b-436f-8e04-844b1471d594) · [Details](https://github.com/user-attachments/assets/a865040e-b419-425b-a70f-a58b12b113e5) |

The adapter commit is published on `LodyAI/acp-extension-claude` branch `fix/omit-missing-task-actor`; this PR pins that commit as its submodule gitlink. PR #1906 remains the only pull request for this issue and stays draft.

PR: https://github.com/LodyAI/Lody/pull/1906
