# CLI session create --agent-role

Status: implemented
Translation: current

[中文](2026-10-07-cli-session-create-agent-role.zh.md)

## Abstract

`lody session create` could not select a workspace Agent Role, so CLI operators
had to hand-assemble the machine, agent config and run configuration that the
MCP create tools already resolve from a Role id. The command now accepts
`--agent-role <idOrName>` and reuses the exact MCP resolution: the Role row is
authoritative for machine, agent config, run config and Prompt prefix, manual
overrides are ignored with a stderr warning, and id/revision/snapshot freeze as
creation provenance. The shared resolution moved from the MCP server module
into `apps/cli/src/lib/agent-role-create.ts` without behavior changes. A Role
that is missing fails fast with the candidate list; an unavailable machine,
config, model or mode still fails in the existing create validation, matching
MCP semantics.

## Decision and evidence

[Issue #1282](https://github.com/LodyAI/Lody/issues/1282) asks for a CLI Role
selector with MCP-identical resolution. The [creation contract](../../../../specs/session-orchestration.md#session-creation-configuration)
owns Role precedence; the MCP rules in `apps/cli/src/mcp/AGENTS.md` require
manual Machine/Agent/run-config fields to be removed before resolution when a
Role is present, and `packages/shared/AGENTS.md` freezes Role revision, Prompt,
target and dispatch config at creation.

Three functions the MCP server already had — the workspace catalog read, the
Prompt prefix composition, and the provenance binding onto `CreateOptions` —
moved verbatim into `lib/agent-role-create.ts` (the catalog sync reason string
became `agent-role-catalog-read`). The CLI adds two pure pieces on top: an
id-or-unique-name selector mirroring `selectUniqueAgentConfigByIdOrName`, and
`resolveAgentRoleCreate`/`applyAgentRoleCreateTarget`, which derive the same
`{ ...role.runConfig, inheritSessionDefaults: false }` dispatch config and
composed Prompt as `resolveMcpSessionCreate`, then clear the manual flags so
nothing downstream can observe overridden values. The create action resolves
the Role inside `withWorkspaceManager` before building the dispatch config;
`resolveCreateContext` and capability validation run unchanged, so machine
access, online checks and mode/model validation keep their existing hard-fail
behavior. Work-context flags (`--repo`, `--local-project`, `--branch`,
`--worktree`) and `--parent` are untouched.

Alternatives considered and rejected: importing the MCP internals object from
the command layer (creates a commands→mcp dependency against the established
direction) and duplicating a second CLI-side resolution (violates the
single-contract rule and drifts from MCP). Checking
`resolveAgentRoleAvailability` up front was also rejected: the MCP path checks
catalog existence only, and the existing create validation already fails fast
on offline/inaccessible machines and unadvertised modes/models, so an extra
availability gate would be a second, divergent policy.

## Verification

The new suite `apps/cli/src/lib/agent-role-create.test.ts` covers selector
resolution (id first, unique name, ambiguity and not-found errors with the
candidate list), dispatch config and Prompt derivation, ignored-override
listing, catalog loading through a mocked `LoroDocumentManager`, provenance
binding, and a parity test asserting the CLI resolution equals
`resolveMcpSessionCreate` + `buildMcpCreateOptions` for the same Role fixture.
The MCP suite keeps its original coverage with only the sync-reason string
updated.

Not verified: an end-to-end `lody session create --agent-role` run against a
live workspace (no commander-level harness exists for this command, matching
the existing unit-test-only coverage of the other create flags).

Implementation: [shared resolution](../../../../apps/cli/src/lib/agent-role-create.ts),
[CLI create boundary](../../../../apps/cli/src/commands/session.ts),
[MCP server](../../../../apps/cli/src/mcp/lody-mcp-server.ts),
[regression suite](../../../../apps/cli/src/lib/agent-role-create.test.ts).
Related: [MCP cross-machine Role](../bug-fix/2026-09-28-mcp-cross-machine-agent-role.md),
[explicit MCP create configuration](2026-10-02-mcp-create-run-config.md).
