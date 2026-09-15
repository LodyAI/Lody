# Codex per-model usage attribution

Status: proposed
Translation: current

[中文](2026-09-15-codex-per-model-attribution.zh.md)

## Abstract

Codex thread totals previously had no model attribution, so the usage UI showed an
opaque `codex:unattributed` bucket. The pinned runtime also emits exact
per-response usage events; the adapter now attributes those to the resolved
model, keeps only the unaccounted remainder unattributed, and restores a small
cumulative sidecar on resume. Review found that raw events are not enabled in
the actual native requests, and fork exclusion and restart continuity still
have accounting defects. This proposal is not ready to merge.

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

### Review and ablation (2026-09-16)

Review of adapter PR [#45](https://github.com/LodyAI/acp-extension-codex/pull/45)
at `94f51b7` and Lody PR [#736](https://github.com/LodyAI/Lody/pull/736) at
`bb0052d8` found no P0 and no new P1 in the CLI fallback removal. Adapter P1s
remain unresolved; the description above states the intended approach:

- Pinned `rust-v0.153.4` filters `RawResponseCompleted` unless the thread opts
  into `experimentalRawEvents`. The adapter never opts in; initialize's
  `experimentalApi` is insufficient, and native resume/fork listeners use false.
  Consequently the first fork total also excludes the first new response.
- A fork opened and resumed before any usage loses its in-memory pending
  exclusion. A synthetic source-only total of 900 input / 100 output was counted
  in the resumed child instead of zero.
- Native-only accounting loses its reset cursor on restart: 1000, reset, 10
  produces 1010; after restart a native total of 20 still produces 1010, not 1020.
- Enabling raw events alone cannot fix model attribution: native previous-model
  inline compaction uses the new turn ID with the previous model. A turn-level
  model map assigns that response to the new model.

Native source confirms raw completion precedes the corresponding total; adapter
notification queues serialize the handler. Shared subagent total/reset state
and the consumer accounting identity limitations predate these PRs.

One-at-a-time ablations removed the pass-through accounting factory and the
second model-name trim. Bundled synthetic output, including persisted sidecar
state, remained identical. Removing response deduplication doubled a repeated
110-token response to 220, so it was restored. Removing CLI model projection
exposed model-level contextWindow and unknown fields, so it was retained.
No further CLI runtime deletion was justified.

Executed validation: esbuild 0.25.12 accounting bundle plus synthetic disjoint
buckets, duplicate response, model switch, subagent model, native reset, output
mutation isolation and fork/resume scenarios. Full checks and Vitest were
attempted but unavailable due to missing workspace dependencies; no real Codex
session, Windows filesystem or process-crash injection was run. Repository docs
checks also report the existing oversized CLI agent AGENTS.md.

- `src/CodexUsageAccounting.ts`
- `src/CodexUsageBaselineStore.ts`
- `src/CodexEventHandler.ts` (`rawResponse/completed`, `thread/settings/updated`,
  `model/rerouted`)
- `src/__tests__/CodexACPAgent/token-usage-events.test.ts`
- `apps/cli/src/agent/agent-client.ts` (no UI-model fallback)
