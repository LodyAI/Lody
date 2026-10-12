# Link background Bash tasks to their commands

Status: implemented
Translation: current

[中文](2026-10-12-background-bash-command.zh.md)

## Abstract

Claude background tasks surfaced the internal `local_bash` actor and displayed
only the SDK description, which is not necessarily the executed command. The
panel now labels these tasks Bash and resolves their command from the spawning
tool retained in the same turn. The dialog keeps the brief separate from the
command; missing tool evidence leaves a plain brief. This changes presentation
without adding a protocol, log reader, or persisted task field.

## Decision

The Core metadata reader already maps `parentToolCallId` to `toolUseId`.
`collectSubagentTasks` joins that exact id to an execute tool's `toolCallId`,
using its structured `terminal_command` block and the conversation's command
formatter. Both Core `actor: local_bash` and legacy `taskType: local_bash` are
recognized. Collection handles either item order and recomputes when the turn
changes; it does not scan other turns or guess from descriptions.

The UI-derived command has its own highlighted, copyable section. This extends
[shared dialog rendering](../simplification/2026-10-04-subagent-dialog-rendering.md)
while retaining the existing task status and cancellation behavior. The scope is
command association only; background output needs a separate transport/read path.

## Verification

The owning panel suite covers Core and legacy association, unrelated tool ids,
missing commands, late tool arrival in an open dialog, and preservation of briefs.
All 19 panel tests and the component package typecheck pass. Scoped formatting
and lint pass (lint retains one existing test-helper ordering warning). The docs
check reports six links into uninitialized Kimi/Pi submodules, with none in changed
documents. Root `pnpm format` passes. Root `pnpm check` passes typechecks and
type-aware lint, then stops at the untouched CLI recursive SSH submodule test
with credential-helper `context_unreadable` (4,058 CLI tests pass); remaining
stages did not complete. No live Claude prompt or native-app visual check was run.
