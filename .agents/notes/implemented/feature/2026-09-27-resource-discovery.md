# Shared MCP and CLI resource discovery

Status: implemented
Translation: current

[简体中文](2026-09-27-resource-discovery.zh.md)

PR: https://github.com/LodyAI/Lody/pull/1045

## Abstract

Sparse session-creation candidates could not enumerate projects, Agent configs or
offline machines, and Role creation accepted ids without a discovery tool. Shared
directory queries now serve MCP and CLI, with bounded pagination, safe summaries
and explicit unavailability. Operation summaries restore requester-scoped task
discovery, while Session queries gain title and target filters. This changes CLI
workspace list output to paginated summaries and retains existing local-only and
explicit detailed inspection paths; it does not add local-platform cloud access.

## Decision and responsibilities

Keep `session_create_options` as a lightweight creation helper rather than growing
every call into a workspace dump. `resource-discovery.ts` owns directory projection
and visibility; `resource-discovery-runtime.ts` supplies synced catalogs and
caller-specific access checks. MCP and CLI translate inputs and present results.
`discovery-query.ts` owns shared schema/filter/cursor behavior. The existing SQLite
Operation store performs bounded requester/user/workspace-scoped reads.

Duplicating new tool-specific readers would preserve the old divergent visibility,
paging and credential behavior. One generic public catch-all tool would hide useful
resource-specific schemas, so resource tools remain explicit over one service.
Keyset paging avoids offset shifts but is not snapshot isolation. Machine catalog
reads are sequentially bounded; this first implementation still scans directory
metadata before projecting a page and does not introduce another persisted index.

Role discovery follows readable catalog visibility and normalizes sensitive options.
Explicit-id Role creation remains separate, as described in the
[catalog explanation](../../../docs/workspace-catalog-durability.md). Directory
availability does not reserve targets. See the [Spec](../../../../specs/resource-discovery.md)
for compatibility and platform limits and the [CLI guide](../../../../apps/cli/README.md)
for commands.

## Evidence and verification

Inspected `buildSessionCreateOptions`: project/config/repository matches were capped
at 20 without continuation; Role lookup existed only on creation. Existing CLI
readers had different projections. No existing active note owned unified discovery.
The Role mention decision remains intact:
[Role availability](2026-09-09-agent-role-mention-availability.md).

Behavior tests exercise catalog pagination beyond 20, cursor scope rejection,
authorization and visibility, unknown presence, unavailable Role bindings, safe MCP
projections, real in-memory MCP requests and CLI page traversal. SQLite tests cover
Operation reader isolation. Tests use synthetic catalogs and explicit state; no
production write or deployment is part of verification. Live mixed-version rollout
has not been tested. Spec status remains draft; implementation does not approve it.

The 178 targeted tests, full-workspace typecheck/lint, formatting, documentation,
i18n and boundary checks passed. Full `pnpm check` stopped in the unchanged
`code-review-helper` renderer test (`act is not a function`) under inherited
`NODE_ENV=production`. That test passed when rerun with `NODE_ENV=test`; the
remaining full-suite tests were not completed.
