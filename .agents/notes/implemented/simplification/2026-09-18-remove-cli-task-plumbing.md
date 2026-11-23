# Remove CLI Tasks product plumbing

Status: implemented
Translation: current

[中文](2026-09-18-remove-cli-task-plumbing.zh.md)

Related: [workspace Tasks product](2026-09-18-remove-legacy-tasks.md)

PR: https://github.com/LodyAI/Lody/pull/800

## Abstract

The Lody Tasks product documents and MCP tools were already deleted, but CLI
session dispatch, fleet automation, sync/export, and MCP still compiled against
them. This change removes the remaining `lody_task_*` tools, `taskToolsEnabled`
gating, session `--task` linking, delegated task automation, and task
enumeration on sync/export so the public CLI compiles without the Tasks product.
ACP subagent task notifications and scheduled-tasks-from-history are unchanged.
Shared history may still parse leftover `task_proposal` notices; the CLI no
longer writes or advertises Task tools.

## Decision

Built-in Lody MCP no longer registers a Task family on stdio or HTTP. Session
startup no longer carries a `taskToolsEnabled` bit, HTTP header, or
`LODY_MCP_TASK_TOOLS_ENABLED` env var. Create no longer inherits or writes a
`taskId`, and fleet no longer starts delegated task automation. `lody sync` and
`lody export` stop listing Task rooms or writing task artifacts; export
manifests keep `taskCount: 0` for the existing shape. Stored Operation
dispatch configs may still contain the old gate field; recovery strips it
instead of rejecting the row.

## Verification

`pnpm --filter lody typecheck` passed. Focused Vitest covering MCP, session
create/chat dispatch, session manager, fork, execution, fleet catalog, operation
store, and sync helpers passed (371 tests). `pnpm run docs check` reported no
errors for this note pair.
