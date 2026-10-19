# Project default MCP selection

Status: draft
Translation: current

[中文](project-default-mcp.zh.md)

## Scenario

A project's **Default MCP** tab lists the current workspace MCP catalog with a
switch per server. New conversations in the project preselect those servers;
users can change the selection before sending. Worktrees and branches share the
project preference. UI, CLI and MCP creation belong to the same feature scope;
staged delivery must not advertise complete support before all entries work.

## Ownership and selection

The workspace Flock document owns MCP catalog entries and one optional
`projectMcpDefault` row per project, containing only `{ ids: McpServerId[] }`.
No row means inherit workspace `enabledByDefault`; a row replaces the entire
selection, including `[]` for none. The first switch edit saves the currently
effective selection with that change. Once customized, new globally enabled
servers do not automatically join this project. Concurrent edits to the same
project use Flock's last-write ordering; this deliberately accepts whole-list
conflicts rather than introducing per-server inheritance.

Local identity is machine id plus local project id; GitHub identity is the
case-normalized repository name. Neither includes branch or worktree path. A
local checkout with a GitHub remote remains distinct from a GitHub project.
Workspace scoping comes from the document. Machine identity identifies the local
project, never an MCP machine binding. Catalog entries alone own connections.

Authoring precedence is explicit ids (including `[]`), then the target
conversation's selection on continuation, then project/workspace defaults on
creation. Existing conversations with no recorded selection stay empty; opening
one does not retroactively enroll it in new defaults. New delegated conversations
use their target project, not the caller's selection. Role configuration does not
own MCP ids. Fork/edit-resend retain their existing source-selection behavior.

## Acceptance and execution

Resolve defaults from a ready workspace snapshot before writing the turn or
accepting its Operation. Failure to read defaults is an error, not an empty
selection. Explicit ids do not require resolving defaults. Store ids in the
existing per-turn `inputConfig.mcpServerIds` and, for Operations, the existing
per-target dispatch configuration. No additional freeze mechanism is needed.
Retries/recovery use those ids; ACP startup does not reapply defaults. Legacy
Operations with no captured selection preserve empty selection on recovery.
Only ids are frozen; current catalog connections and runtime capabilities still
resolve at startup. Missing/deleted ids are filtered from derived defaults;
explicit/historical ids retain existing runtime diagnostics, without name-based
rebinding.

CLI creation and continuation accept `--mcp-server-ids <json>`, including `[]`.
MCP single/batch creation and chat accept optional `mcpServerIds`; omission on
chat inherits the target's selection, while omission on creation resolves defaults.
This also makes workspace defaults apply to those new creation paths.

## UI and durability

Place **Default MCP** after Skills. Show name, description, switch, missing
connection warning, loading, save failure and read-only states. An empty catalog
links to MCP management. Explain that defaults apply to new conversations and can
be adjusted in the composer. Search, counters and per-server inheritance controls
are outside the first version.

Draft overrides are isolated by workspace/project immediately on a scope change.
Do not allow default-derived sends until the snapshot is ready. Deferred attachment
sends preserve the click-time selection. A selected switch means selected, not
connected or successfully loaded.

Project mutations validate project management authority, workspace scope and input.
Success means local durable persistence; subsequent upload failure cannot roll back
or fail the edit. Local desktop uses existing platform/repo ports without product
cloud requests. Choosing Flock alone does not establish that guarantee.

## Compatibility and verification

The dispatch wire field already exists; no new machine capability is introduced.
Old clients ignore the new preference family and continue using their existing
composer behavior. Verify preservation of unknown rows and unchanged explicit-id
dispatch rather than adding a broad version matrix.

Acceptance covers absent/empty/custom selection, removed ids, project/machine and
workspace isolation, loading failures, authorization, failed saves, UI/CLI/MCP
creation and continuation, explicit opt-out, accepted-operation retries, deferred
sends, and local zero-cloud behavior. The shared contract must name catalog,
project defaults and turn selections as separate durable responsibilities.

## Evidence and implementation status

- [Selection and identity](../packages/shared/src/workspace-mcp.ts)
- [Flock rows](../packages/shared/src/workspace-flock.ts)
- [CLI turn authoring](../apps/cli/src/commands/session.ts)
- [MCP authoring](../apps/cli/src/mcp/lody-mcp-server.ts)
- [Decision and remaining work](../.agents/notes/implemented/architecture/2026-10-09-project-default-mcp.md)

Shared storage, CLI/MCP authoring, the desktop project tab and composer integration
are implemented. Behavioral tests cover the boundaries above; packaged Electron
walkthrough remains unverified. The Spec stays draft pending human review.
