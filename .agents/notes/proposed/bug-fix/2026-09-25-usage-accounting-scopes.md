# Usage accounting scopes survive adapter restarts

Status: proposed
Translation: current

[中文](2026-09-25-usage-accounting-scopes.zh.md)

## Abstract

Token usage for every builtin ACP agent except Codex was under-counted. Adapters
report per-model totals that restart from zero with their process, but the CLI kept
the same accounting identity (the ACP session ID) after a resume, and the hosted
endpoint keeps the per-identity maximum. After each restart, new usage stayed hidden
until it passed the previous total. Core now defines a never-reused
`_meta.lody.usageScopeId`: Claude scopes each SDK result, Codex its native turn,
Kimi its activation, and the shared accumulator (Grok, DSH) its own instance. The CLI
turns every scope into its own identity, and the hosted endpoint is unchanged. Data
already under-counted cannot be recovered, and Pi usage is still not persisted.

## Problem

The hosted `upsertSessionUsageFromCli` treats `modelUsage` as cumulative for each
`(session, user, acpSessionId)` and merges it field by field with `max`. A
regressive snapshot yields a zero delta by design, so a stale report cannot subtract
usage that is already stored.

Adapters kept their cumulative totals only in memory: Claude's `usageBaseline`,
Kimi's `lodyUsageSinceActivation`, and the Core `SessionUsageAccumulator`. Idle
collection, CLI restarts and crashes restart the adapter, and it resumes the *same*
ACP session. Its totals then start from zero under the old identity. Each restart
lost `min(new usage, previous peak)`, which is large for long sessions dominated by
cache reads. The Core contract already required "a new consumer accounting identity
or a restored baseline" for this case. Only Codex met it, through `usageTurnId`.

## Decision

- **Core**: `_meta.lody.usageScopeId` (at most 256 characters) marks `modelUsage`
  as cumulative only within that scope. A scope id is unique within the ACP session
  and is never reused. Each `SessionUsageAccumulator` instance scopes its output
  with a random id.
- **Claude**: each SDK result is one scope, keyed by its `uuid`. It carries only
  what the result added to the query-wide reading. A reading below the previous one
  marks a new `query()`, so the whole reading counts. Nothing carries across query
  replacement.
- **Codex**: the native turn id is sent as the Core scope and, for one release, as
  the legacy `codex.usageTurnId`.
- **Kimi**: each activation has a random scope.
- **CLI**: any provider's scope becomes `nativeSessionId:scope:encodedId`. Unscoped
  updates keep the ACP session ID.

Hosted persistence, the schema and the queries are unchanged. Each scope becomes
one `sessionUsageTotals` row, so row count grows with results (Claude) or turns
(Codex), as Codex rows already did.

## Alternatives

- **Delta-only reporting with idempotency keys.** Delta delivery is not
  exactly-once. The adapter, CLI coalescing and hosted endpoint would all need a
  new ledger. Rejected as more invasive than scoping.
- **A per-process generation suffix added by the CLI.** This would fix restarts,
  but the adapter knows its native lifetimes better. Scoping in the adapter also
  keeps retries idempotent per result or turn.
- **Claude scoped per user turn (`promptUuid`).** Autonomous results
  (task-notification follow-ups) have no user turn, and their cost is real.
  Per-result scoping covers them.

## Limits and follow-up

- Already under-counted history is not recovered.
- Pi sends `modelUsage: {}`, which the CLI skips, so Pi usage is never persisted.
  This needs a separate decision on model attribution.
- Adapters take effect only after Core is published and each adapter is released
  or rebuilt. Unscoped adapters keep the under-count.

## Verification

- Core: `npm test`, including restarted-instance scopes.
- Claude: `vitest run`. Per-result increments, restart counted in full and no-op
  results are covered. One unrelated `acp-agent-settings` test failed under load
  and passed when run alone.
- Codex: `token-usage-events` test.
- Kimi: `e2e-turn` and `lody-extension` tests, plus `tsc`.
- CLI: `lody-acp-extension` and `usage-tracking-service` tests.
