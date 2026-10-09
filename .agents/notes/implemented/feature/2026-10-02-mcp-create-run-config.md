# Explicit MCP create configuration

Status: implemented
Translation: current

[中文](2026-10-02-mcp-create-run-config.zh.md)

## Abstract

MCP session creation could select model and planning controls but required a Role
to explicitly select permissions. Single and batch creates now accept ACP
`modeId` and `configOptionValues`, using the existing CLI capability validation
and durable Operation configuration. All advertised options are eligible,
including uncategorized permission selectors; no permission mapping or escalation
policy is introduced. Fixture tests and deletion experiments establish dispatch
configuration and retry identity, not real-provider enforcement or desktop acceptance.

## Decision and evidence

[Issue #1172](https://github.com/LodyAI/Lody/issues/1172) requests explicit ad-hoc
creation configuration. The [creation contract](../../../../specs/session-orchestration.md#session-creation-configuration)
owns precedence, authorization, merge and recovery behavior. The existing semantic
resolver continues to handle model/reasoning/Fast/Plan; raw options go through CLI
advertised-id/type/value validation. A permission option does not replace explicit
semantic controls. No category whitelist, semantic permission alias, provider map,
permission ranking or second resolver is needed.

Two existing composition details need explicit handling. Runtime dispatch applies
scalar mode/model before raw selectors, so create must clear inherited scalar
selectors when a corresponding raw selector is explicit, as chat already does.
Semantic effort must use a model selected by a raw option when no semantic model
is supplied. Legacy Plan occupies the ACP mode selector and therefore conflicts
with a different explicit mode; independent Plan options coexist with permissions.
The raw option map still replaces the inherited map as a whole.

Discovery projects mode and option selector metadata without current values or
launch configuration. Both MCP discovery paths use the shared summary. Operation
storage already supports the concrete mode/map; no migration or recovery branch
is added. The accepted target configuration remains frozen, while explicit input
participates in command identity. Role-owned overrides remain ignored.

## Verification and deletion experiments

The owning MCP suite composes real schemas, dispatch builders, capability
resolution, CLI validation and SQLite acceptance/reopen. Synthetic advertised
capabilities include Grok-shaped permissions without a category, Codex independent
Plan, and Claude legacy Plan. Single/batch identity tests verify unchanged target
ids and frozen configs after reopening, equivalent map order, and changed-selection
rejection. These tests do not execute a daemon recovery worker or a real provider.

Each deletion below was applied to source, tested, and reverted:

| Removed behavior | Observed regression |
| --- | --- |
| Legacy Plan conflict guard | The conflict test fails: explicit `auto` is silently replaced by `plan`. |
| Clearing inherited mode/model for raw selectors | The inheritance test fails: parent `agent` and model remain authoritative. |
| Selecting the raw model for semantic reasoning validation | The target-model test fails: unsupported target effort is accepted against the probe model. |
| Mode/map in command identity | Both single and batch identity tests fail: changed selections are accepted as retries. |

Retain these small checks at existing boundaries. The discarded category whitelist
and permission resolver alternatives have no implementation. No new persisted
format, runtime policy layer or provider-specific dispatch path is retained.

The five targeted suites pass 202 tests; shared typecheck, scoped formatting/lint
and public boundary check pass. CLI typecheck is blocked by missing installed
dependencies and a Streams transport type mismatch. Temporarily reverting the
three production-file changes reproduces the same eight diagnostics; restoring
the patch preserves its exact SHA-256. Root `pnpm check` stops during the
Claude adapter build with dependency/API mismatches. Documentation checks retain
unrelated missing-submodule links. Real-provider permission enforcement, full daemon
replay and packaged desktop acceptance remain unverified; no live session permissions
were changed.

Implementation: [MCP server](../../../../apps/cli/src/mcp/lody-mcp-server.ts),
[CLI create boundary](../../../../apps/cli/src/commands/session.ts),
[shared capability summary](../../../../packages/shared/src/acp-run-config.ts),
[MCP regression suite](../../../../apps/cli/src/mcp/lody-mcp-server.test.ts).
