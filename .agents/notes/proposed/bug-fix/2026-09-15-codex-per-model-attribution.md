# Codex per-model usage attribution

Status: proposed
Translation: current

[中文](2026-09-15-codex-per-model-attribution.zh.md)

## Abstract

Codex thread totals previously had no model attribution, so the usage UI showed an
opaque `codex:unattributed` bucket. The pinned runtime also emits exact
per-response usage events; the adapter now attributes those to the resolved
model, keeps only the unaccounted remainder unattributed, and restores a small
cumulative sidecar on resume. Review corrections enable raw on new threads,
capture fork history before paid work, and persist the native reset cursor.
Cold resume/fork and ambiguous compaction/reroute responses remain unattributed
because the pinned protocol cannot identify their producing model.

## Context

Codex app-server `thread/tokenUsage/updated` carries a cumulative thread total
without a model field. The adapter previously kept that entire total in
`codex:unattributed`, so the usage UI could not attribute Codex tokens to the
model that produced them.

## Correction

Pinned Codex 0.153.4 can emit `rawResponse/completed` for each upstream
Responses API completion. Its `usage` is exact, not accumulated or replayed, and
its `responseId` provides idempotency. The adapter now attributes those events
to the resolved thread/turn model. Any thread total not covered by an exact
response remains in `codex:unattributed`, so an older runtime or an unresolved
model still keeps totals correct instead of inventing a model.

The adapter enables `experimentalRawEvents` on new threads. Cold resume and new
fork listeners in this runtime have no opt-in and use unattributed cumulative
usage. Compaction can execute on the previous model or a fallback, so its raw
responses also stay unattributed. Reroute evidence applies only to its next raw
completion, including completions without usage; later responses stay unattributed.

The adapter keeps a small cumulative sidecar under `$CODEX_HOME` and restores
the native total, reset offset and reset flag with the model ledger. Fork waits
for native `thread/started`, after the restored usage notification, and persists
that exact source baseline before accepting a prompt. Empty history means zero;
the first paid response is never used to infer source history. The sidecar is not a
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
  otherwise their exact responses fall back to `codex:unattributed`. Child native
  totals contain inherited history and reset independently, so only exact child
  responses join the root ledger; child activity without those events is not counted.
- Old sidecars without a native cursor are anchored to the captured native replay.
  Already missing historical usage cannot be reconstructed by this migration.

## Evidence

### Review and ablation (2026-09-16)

Review of adapter PR [#45](https://github.com/LodyAI/acp-extension-codex/pull/45)
at `94f51b7` and Lody PR [#736](https://github.com/LodyAI/Lody/pull/736) at
`bb0052d8` found no P0 and no new P1 in the CLI fallback removal. The adapter
findings below describe the reviewed revision and motivated the corrections above:

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
notification queues serialize the handler. The pre-existing shared subagent
total/reset state is now isolated from the root cursor. Pending exact root usage
is persisted until native totals cover it, including a restart that replays a
reset before the corresponding total was processed. Consumer accounting identity
limitations remain outside this adapter repair.

One-at-a-time ablations removed the pass-through accounting factory and the
second model-name trim. Bundled synthetic output, including persisted sidecar
state, remained identical. Removing response deduplication doubled a repeated
110-token response to 220, so it was restored. Removing CLI model projection
exposed model-level contextWindow and unknown fields, so it was retained.
No further CLI runtime deletion was justified.

Initial ablation validation: esbuild 0.25.12 accounting bundle plus synthetic disjoint
buckets, duplicate response, model switch, subagent model, native reset, output
mutation isolation and fork/resume scenarios. Full checks and Vitest were
attempted but unavailable due to missing workspace dependencies; no real Codex
session, Windows filesystem or process-crash injection was run. Repository docs
checks also report the existing oversized CLI agent AGENTS.md.

Repair validation used isolated dependencies with Codex 0.153.4 and Vitest 4.1.11:
639 tests passed, 27 E2E tests skipped; adapter and examples typechecks and the
official build passed. Tests cover both old-sidecar migrations, fork replay,
reset/pending-response restart combinations, child counter isolation and failed
atomic replacement. Independent re-review found no remaining P0/P1 in the repair.
No paid model completion or real process-crash injection was run. Outer workspace
checks/format remain blocked by missing unrelated dependencies; docs check still
reports the oversized CLI agent AGENTS.md. Both gitlinks remain uncommitted.

- `src/CodexUsageAccounting.ts`
- `src/CodexUsageBaselineStore.ts`
- `src/CodexEventHandler.ts` (`rawResponse/completed`, `thread/settings/updated`,
  `model/rerouted`)
- `src/__tests__/CodexACPAgent/token-usage-events.test.ts`
- `apps/cli/src/agent/agent-client.ts` (no UI-model fallback)
