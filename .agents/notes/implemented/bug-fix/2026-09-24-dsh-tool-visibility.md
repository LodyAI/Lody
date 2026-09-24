# Expose Harness tool execution through ACP

Status: implemented
Translation: current

[中文](2026-09-24-dsh-tool-visibility.zh.md)

Provider PR: [acp-extension-dsh #22](https://github.com/LodyAI/acp-extension-dsh/pull/22)

## Abstract

The DSH adapter executed tools but only exposed compaction as ACP tool calls, so
users could not inspect commands or results and approvals carried only an ID.
The provider now projects native durable tool events, including PTC dispatches,
into standard ACP lifecycles and enriches approval requests. Session-local state
and ordered output preserve identity and image delivery; successful result-time
diffs show applied edits. Missing terminal results are explicitly unknown, while
live stdout and child-agent transcript forwarding remain outside this change.

## Decision and evidence

Harness 0.1.5-rc.2's published `dsh-agent-loop` appends `tool/call` before execution
and a `tool/result` message containing a `tool-result` block afterwards.
`dsh-tools` separately records PTC start/result events with sub-call IDs and
already-decoded arguments. Use those committed facts rather than speculative
assistant stream tool blocks, which can be retried and would duplicate rows.

`ToolCallBridge` retains native inputs and outputs and resolves optional pure
presenters through the calling Agent's scoped registry. Unsupported output blocks
fall back to JSON; missing images have a visible placeholder. Presenter errors
never erase native results. Only successful result-time diffs become edit evidence.
Approval waits for prior notifications; turn-end and exceptional prompt settlement
close unresolved rows without claiming their side effects failed or succeeded.

This complements the [user-question bridge](../feature/2026-09-20-dsh-user-questions.md).
No host UI or shared protocol changes are required. The
[visibility contract](../../../../specs/deepseek-harness-tool-calls.md) remains draft.

## Verification and limits

Provider build, typecheck, formatting and ACP boundary tests cover native/MCP/PTC
calls, approval details, duplicate starts, malformed arguments, throwing presenters,
failed edits, cancellation, unknown blocks, missing/ordered images and concurrent
session isolation. Fixtures are synthetic; no model request or user transcript was
used. A real desktop/model session was not exercised.

Root `pnpm check` and `pnpm format` were attempted but this nested checkout lacks
workspace dependencies (`tsgo` / `oxfmt`). Documentation checks retain pre-existing
broken links into uninitialized unrelated adapter submodules. These limits do not
replace provider verification.
