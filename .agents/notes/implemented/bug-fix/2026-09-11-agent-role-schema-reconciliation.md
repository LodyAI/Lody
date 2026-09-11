# Reconcile obsolete Role options at workspace startup

Status: implemented
Translation: pending

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
All 56 tests across the Role form, startup hook, workspace writer, catalog room and
catalog write suites pass. Scoped lint, formatting and `git diff --check` pass.
`pnpm format` completed; its unrelated Electron formatting was excluded.
`pnpm check` stops in `@loro-dev/ignore` because this nested checkout lacks its Node,
Effect and test dependencies. Component typecheck also encounters missing Electron
and hotkey dependencies. Public-boundary and docs checks remain blocked by other
uninitialized ACP submodules; the documentation check reports no errors in the new
documents. No running desktop or actual user catalog was exercised.

PR: [#588](https://github.com/LodyAI/Lody/pull/588).
