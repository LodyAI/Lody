# Remove the workspace Tasks product

Status: implemented
Translation: current

[中文](2026-09-18-remove-legacy-tasks.zh.md)

Related: [CLI plumbing](2026-09-18-remove-cli-task-plumbing.md)

PR: https://github.com/LodyAI/Lody/pull/800

## Abstract

The beta workspace Tasks board, `lody_task_*` MCP tools, task documents, and
session-linked automation are removed from the public desktop. Leftover
`task-<id>` rooms, the Task Index Flock document, stored `task_proposal`
notices, and old `taskToolsEnabled` / `SessionMeta.taskId` keys stay readable
and dormant so account deletion and history parse still work. Codex scheduled
tasks, ACP subagent task notifications, and the sidebar session list labeled
"My Tasks" are a different product and stay.

## Decision

Product UI, routes, hooks, beta gates, and MCP tools are gone rather than
hidden. Shared packages keep a tiny legacy id module (`TASK_DOC_PREFIX`,
`getLoroTaskStreamId`, `getTaskIndexFlockDocId`) so leftover CRDT rooms still
map to streams. History writers still parse `task_proposal` notices so old
sessions open; they no longer publish or resolve them. The conversation renderer
drops that notice name instead of showing a generic card. Share export continues
to strip those notices. Sync and export stop enumerating Task rooms. Hosted
task-image routes and Convex purge copy live outside this repository.

The alternative of a deprecation window was rejected: the feature was
beta-gated, and leaving MCP tools or routes would keep a dead surface online.

## Verification

Typecheck and focused tests for shared history, MCP catalog, and renderer
writer after the product files were deleted. `tsr generate` was not run in
this nested worktree because `node_modules` is absent; `routeTree.gen.ts` was
edited to drop the Tasks file routes. Hosted account-deletion dry-run remains
out of this repository.
