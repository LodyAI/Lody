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

## Ablation-guided cleanup

The original five-suite baseline passed 157 tests. Before deleting production code,
the two discovery suites were expanded to 22 behavioral cases covering CLI input
normalization/bounds, Role machine filters, GitHub-only reads when machine metadata
is unavailable, and mixed project results. Deletions were applied incrementally:

| Candidate | Evidence and decision |
| --- | --- |
| CLI's generic query parse | Removing it kept all 22 tests green; the service still validates inputs against its strict resource schema. |
| Factory branches for machine/project commands | No production callers use these branches; those commands own their compatibility flags. Narrowed the factory to its three real callers; 22 tests and CLI typecheck passed. |
| Repeated project-kind guard and machine-list machine-id alternative | Earlier return/schema rejection makes them unreachable. Removed them and evaluated Agent capabilities once per row; 22 tests passed. |
| Repeated resource schema fields | Derived explicit field allowlists from the shared schema. All five MCP tools and direct service calls still reject irrelevant fields; 22 tests passed. |
| Agent summary forwarding wrapper | Replaced it with an import alias; the expanded six-suite regression passed 174 tests. |

As a negative control, removing the final machine filter made the Role test return
both `one` and `two` instead of only `two`. Restored that filter and reran the green
suite: the earlier machine-reader filter is not equivalent because unreadable or
missing Role bindings intentionally remain visible. The GitHub-only early return,
authorization, cursor validation, safe projections and legacy CLI paths remain.
These experiments support the scoped cleanup, not a proof for every runtime state
or a performance benchmark; public parameters and Spec intent are unchanged.

The cleanup's full-workspace typecheck/lint, formatting, documentation (61 existing
warnings), i18n and boundary checks passed. `NODE_ENV=test pnpm check` reached the
CLI suite: 3116 passed, 7 failed, 1 skipped. Six cloudflared lifecycle cases timed
out; workspace Git metadata backfill had one assertion failure. With all four
changed production files temporarily restored to pre-cleanup HEAD, the
`stops through IPC` and `backfills an existing local owner` cases reproduced their
respective failures. The cleanup was then restored and all 174 targeted tests
passed again. The full check is not green; its remaining stages were not completed,
and these unrelated failures were not changed in this PR.
