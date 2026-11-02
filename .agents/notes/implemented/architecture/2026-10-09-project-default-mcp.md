# Project default MCP authoring policy

Status: implemented
Translation: current

[中文](2026-10-09-project-default-mcp.zh.md)

## Abstract

Project conversations need reusable MCP selections without changing accepted
turns. The revised design stores one optional ids array per project in workspace
Flock, resolves it when authoring a new conversation, and reuses existing per-turn
and Operation dispatch configuration. This replaces the initial per-server override
proposal, accepting whole-list conflict resolution and no automatic additions after
customization. Shared, CLI/MCP and desktop project UI are implemented. Packaged desktop
walkthrough remains unverified.

## Decision and responsibilities

The [Spec](../../../../specs/project-default-mcp.md) owns semantics.
Draft PR: [#1708](https://github.com/LodyAI/Lody/pull/1708).
The 2026-10-19 design revision simplifies project policy to one row and preserves
UI/CLI/MCP coverage as the final scope. An absent row inherits workspace defaults; an
explicit empty list disables all. A customized project stops following later
workspace default edits. Concurrent edits to one project replace the list under
Flock ordering. This is a deliberate trade-off against per-server tri-state
inheritance and independent switch conflict resolution.

```mermaid
flowchart TD
  C[Workspace catalog] --> R[Shared default resolver]
  P[Optional project ids array] --> R
  R --> A[UI / CLI / MCP authoring]
  E[Explicit or existing conversation selection] --> A
  A --> T[Existing turn and Operation dispatch config]
  T --> D[Dispatch / retry / recovery]
  D --> L[Runtime connection resolution]
  C --> L
```

Shared owns project identity, row validation and the pure default resolver.
Components owns the Tab, authorized durable writes, ready snapshot and scoped draft
selection. CLI/MCP authoring resolves target-project defaults or target-conversation
selection and writes ids. Operation acceptance uses its existing per-target config;
recovery never rereads defaults. Runtime continues to resolve connections from the
catalog and driving turn. Preserve [catalog durability](../../../docs/workspace-catalog-durability.md)
and the [local orchestration boundary](2026-09-29-local-session-orchestration.md).

The earlier proposal added per-server overrides, extensive UI controls and new
protocol negotiation. These are unnecessary for the initial scope. The existing
wire field carries explicit ids, so use targeted compatibility checks. Loading,
permissions, durable writes, click-time snapshots and local boundaries remain
correctness requirements; Flock or an existing `synced` flag does not prove them.

## Implementation evidence and limits

`workspace-mcp.ts` now supplies project keys and replacement-default selection;
`workspace-flock.ts` parses, scans and writes project preference rows. The shared
invariant is updated from two layers to catalog/project defaults/turn selections.
CLI create resolves defaults before preparation; continuation retains the target's
selection. CLI JSON selection and MCP optional arrays preserve explicit `[]`.
Single/batch MCP Operations freeze resolved ids in existing target dispatch configs;
recovery preserves old Operations as empty when no ids were captured.

Shared tests exercise absence/empty/replacement, removed ids, identity isolation and
row updates. CLI tests exercise ready-read failures, frozen selection after preference
edits, and explicit opt-out. The local integration suite verifies real daemon-backed
MCP creation and continuation, persisted Operation configuration, batch opt-out
inheritance, and zero product-cloud access. Final full-check results belong in the
PR; do not infer packaged UI validation from these tests.

The desktop project tab and all three composers are integrated. The catalog room
exposes local-load readiness and read failure; selection resets synchronously on
workspace/project scope changes. The writer checks workspace and project authority
before persisting, and upload failure does not roll back a local save. Local
projects require the machine owner; GitHub projects require a signed-in user and
a repository connected to the workspace. This follows existing client-side
management boundaries, not a new server-side row authorization mechanism.

UI Designer reported 4,910 passing component tests and light/dark Storybook checks.
After integrating current main, 83 tests across selection, catalog room, writer
and input submission passed, along with 22 shared and 244 CLI tests. Attachment
inputs, Role/default provenance and Operation origin metadata from main are retained. The packaged Electron app was not walked through. Mobile project
settings retain their existing layout. Local snapshots now allow sends in every composition without waiting for remote
catch-up. Unread catalogs retry while borrowed and offer explicit one-send opt-out;
[the availability decision](../bug-fix/2026-10-26-mcp-defaults-send-gate.md) explains
why the original remote-sync and permanent local-read gates were insufficient.
No additional project policy is resolved at ACP startup, and Role rows do not gain
MCP selections.

## Ablation of the settings adapter

Compared with `b3036abdd`, remove one mechanism at a time and run the existing
behavior suites. The settings hook had one production consumer; its memoized
values were passed through a freshly allocated model and callback to a non-memoized
view, with no identity-sensitive consumer.

| Experiment | Result | Decision |
| --- | --- | --- |
| Baseline selection/room/writer/input suites | 83 passed | Comparison baseline |
| Remove hook model/status exports and memo wrappers | 22 passed | Keep removal |
| Remove the single-consumer hook and model adapter | 22 passed | Keep removal; Tab owns its edit state |
| Replace two save flags and catch/rethrow with one save state and one handler | 23 passed | Keep; failed-write/retry scenario passed before and after |
| Remove exported project-row write helper with no production consumer | 22 shared + 120 CLI passed | Keep; fixtures seed Flock directly, authorized UI writer unchanged |
| Temporarily remove composer readiness guard | 3 failed, 6 passed | Restore guard |

Production code shrank by 70 lines and one module; the final UI suites passed 84 tests.
The direct unauthorized-write assertion now uses the real writer rather than a
probe of the deleted hook. No behavioral test was removed; failed-save recovery
coverage was added. Permissions, catalog ownership, composer scope isolation and
click-time snapshots remain unchanged. These experiments establish behavior under
the tested cases, not a packaged-desktop or performance guarantee.
