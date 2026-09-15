# Codex per-model usage attribution

Status: proposed
Translation: current

[中文](2026-09-15-codex-per-model-attribution.zh.md)

## Abstract

Codex thread totals previously had no model attribution, so the usage UI showed an
opaque `codex:unattributed` bucket. The pinned runtime also emits exact
per-response usage events; the adapter now attributes those to the resolved
model, keeps only the unaccounted remainder unattributed, and restores a small
cumulative sidecar on resume. Fork sessions exclude source history. A lost
sidecar and the long-lived consumer accounting identity remain unresolved.

## Context

Codex app-server `thread/tokenUsage/updated` carries a cumulative thread total
without a model field. The adapter previously kept that entire total in
`codex:unattributed`, so the usage UI could not attribute Codex tokens to the
model that produced them.

## Correction

Pinned Codex 0.153.4 also emits `rawResponse/completed` for each upstream
Responses API completion. Its `usage` is exact, not accumulated or replayed, and
its `responseId` provides idempotency. The adapter now attributes those events
to the resolved thread/turn model. Any thread total not covered by an exact
response remains in `codex:unattributed`, so an older runtime or an unresolved
model still keeps totals correct instead of inventing a model.

The adapter also keeps a small cumulative sidecar under `$CODEX_HOME` and
restores it on resume. Fork sessions persist the source-history total as
excluded, so forked children only report post-fork usage. The sidecar is not a
delivery ledger; the CLI still retries its own cumulative snapshot. The CLI no
longer synthesizes `modelUsage` from the selected UI model for legacy adapters;
missing attribution is skipped instead.

## Limits

- The sidecar is machine-local. Losing it on a resumed exact-attribution thread
  can make the new process treat historical tokens as unattributed. A durable
  consumer accounting identity remains the long-term fix.
- `rawResponse/completed` is an internal app-server event in the pinned runtime.
  It needs the same version/capability discipline as the generated client types.
- Subagent threads use their own `thread/settings/updated` model when available;
  otherwise their exact responses fall back to `codex:unattributed`.

## Evidence

- `src/CodexUsageAccounting.ts`
- `src/CodexUsageBaselineStore.ts`
- `src/CodexEventHandler.ts` (`rawResponse/completed`, `thread/settings/updated`,
  `model/rerouted`)
- `src/__tests__/CodexACPAgent/token-usage-events.test.ts`
- `apps/cli/src/agent/agent-client.ts` (no UI-model fallback)
