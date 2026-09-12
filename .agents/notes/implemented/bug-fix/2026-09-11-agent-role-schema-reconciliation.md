# Reconcile obsolete Role options at workspace startup

Status: implemented
Translation: current

[中文](2026-09-11-agent-role-schema-reconciliation.zh.md)

## Abstract

Plan schema changes left obsolete option keys in saved Agent Roles, producing
persistent warnings even after the new control appeared. Workspace startup now
silently probes bound agents and durably removes retired option keys for the Role
owner. Known legacy collaboration choices migrate to boolean Plan while permission
pins and invalid values of existing options remain unchanged. Missing or failed
capability discovery defers the work instead of treating absence as incompatibility.

## Decision

The workspace window owner mounts maintenance outside Settings, after workspace and
catalog readiness. It reuses Machine Flock subscriptions and the runtime's Machine
RPC, serializing probes and sharing their results across Roles of the same target.
Each startup may retry; persistence itself is idempotent. There is no persistent
global completion bit that could strand offline Roles, and no UI notification.

The previous editor-only proposal would still require opening and saving a Role.
Unconditional filtering against static selectors could erase options simply because
discovery was incomplete. Fresh raw config options define field presence; selector
projections and model-dependent value lists do not authorize removal.
Unknown option removals also require a matching pinned model; the known obsolete
independent Plan keys can be reconciled when the new boolean contract is present.

`WorkspaceWriter.flockRowUpdate` reads and conditionally replaces a row in a local
Flock transaction. Reconciliation checks ownership, revision, content and the active
effect after document acquisition. This fences intervening local edits/deletion and
workspace changes; it does not introduce distributed compare-and-swap or change
Flock's existing offline concurrent row conflict semantics. Upload remains best effort
after the durable mutation. Historical Session/Operation configuration is untouched.

This extends the [Plan consumer repair](2026-09-10-core-plan-mode-consumers.md), which
deliberately did not rewrite stored state. Current intent is the
[reconciliation Spec](../../../../specs/agent-role-schema-reconciliation.md).

## Verification

Behavior tests cover startup readiness, failed/mismatched/incomplete probes, legacy
Plan migration, preserved model/permission/value pins, idempotence and real Flock
writes with delayed acquisition, edits, deletion, cancellation and write failure.
All 63 tests across the Role form, startup hook, workspace writer, catalog room and
catalog write suites pass, including sign-out/disposal during a pending probe and
rejection of mismatched config/provider/agent, future cache versions and provisional
capabilities. No running desktop or actual user catalog was exercised.

### CI repair and ablation

The complete Static checks job log for run `34554474320` showed formatting and all
scoped typechecks passing, then type-aware lint failing with `consistent-return`.
The readiness branch returned implicitly while the active effect returned cleanup.
Explicit `return undefined` fixes the return contract without removing cancellation.
The initial ordinary scoped lint missed this type-aware rule. Dependency limitations
from the initial local validation were resolved with pinned submodules and an
independent frozen-lockfile install; the checkout's install guard permits this layout.

Sequential ablations used the five suites above (63 tests); the negative control
used the startup suite (12 tests). Passing tests alone are not equivalence evidence.

| Experiment | Evidence / outcome | Decision |
| --- | --- | --- |
| Explicit-undefined baseline | 63 pass; scoped type-aware lint has no errors | Keep CI fix |
| Remove caller-side machine ID deduplication | Subscription owner already normalizes via `Set`; 63 pass | Keep deletion |
| Remove separate machine ID from probe key | Exact-target config lookup guarantees the serialized config already contains that ID; 63 pass | Keep deletion |
| Remove effect cleanup | 2 fail / 10 pass: sign-out and workspace disposal incorrectly mutate the stored Role | Restore protection |

The retained simplifications do not change migration intent or weaken identity,
schema freshness, ownership, model compatibility or transactional write guards.
After restoring cleanup, all 63 focused tests pass again. Full `pnpm check`,
`pnpm check:quick`, `pnpm format:check`, scoped test formatting, `pnpm run docs check`
and `git diff --check` pass. `pnpm format` completed; its unrelated Electron test
formatting was excluded. The full check includes 3,423 component tests and all
workspace typechecks; existing skipped tests and lint/document-size warnings remain.

PR: [#588](https://github.com/LodyAI/Lody/pull/588).
