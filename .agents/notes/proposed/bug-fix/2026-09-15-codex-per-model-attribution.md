# Codex usage: native snapshots instead of a model ledger

Status: proposed
Translation: current

[中文](2026-09-15-codex-per-model-attribution.zh.md)

## Abstract

The initial proposal rebuilt historical per-model usage from raw completions and
persisted a local sidecar. On 2026-09-16 the user chose native Codex snapshots
instead: model history and its recovery complexity are not required for total
usage reporting. The adapter now projects the root native snapshot without
accumulation, and the CLI no longer compensates native resets. Accurate
historical model costs and exact fork/reset lifetime accounting are not promised.

## Decision

Per-model history was needed only to preserve model-specific statistics and
match each historical model to its price across restarts. It is not required
to show native total usage. The user first rejected session metadata baselines,
then explicitly chose native snapshots over the entire extra ledger.

```text
Codex root thread/tokenUsage/updated
  -> stateless disjoint buckets (codex:unattributed)
  -> CLI latest snapshot / failed-payload retry
  -> hosted per-field high-water persistence
```

Delete raw-response accounting, model/reroute/compaction bookkeeping, sidecar
storage, deduplication, history exclusion, native-cache baseline plumbing and
adapter/CLI reset offsets. Keep ordinary token/cache/reasoning normalization,
context-window reporting, native lifecycle behavior, payload projection and
delivery retries. Do not enable experimental raw events solely for accounting.
Neither selected UI model nor its price is evidence of historical attribution.

## Tradeoffs and rollout

- Native resume/fork totals can contain inherited history; counters can reset.
  Child-thread totals are not added to the root. There is no extra delta.
- Codex owns native history restoration; old development sidecar files are
  ignored, not deleted. Session metadata stores no usage baseline.
- Hosted persistence still merges per-model fields by maximum. Lower native
  snapshots can leave an older high-water total; these PRs do not change that API.
- If an experimental per-model version already persisted model rows, switching
  the same identity to native unattributed history can double count old history
  across keys. These unmerged PRs do not migrate such development records.
  Reconciliation would need a separate scoped operation; do not claim it is done.
- Runtime artifacts still require rebuild/release. Both intentional gitlink
  changes stay uncommitted; no historical data or sidecar files are removed.

## Review history and evidence

Earlier review of adapter `94f51b7` found missing raw opt-in, fork-history
exclusion and restart/reset failures, plus ambiguous compaction/reroute models.
Corrections culminated in `9457493`; `c176b2b` removed session metadata
baselines and fork waiting. Those fixes addressed the now-rejected ledger design,
not a requirement to retain it. The current change deliberately removes it.

Validation of native snapshots: 620 adapter tests passed, 27 E2E skipped;
adapter/examples typechecks and build passed. All 16 CLI usage-delivery tests
passed, including native reset payloads `[1000, 0, 50]`, coalescing, retry and
concurrent flushes. Three independent code reviews found no new P0/P1 in the
snapshot implementation; the development-data migration limit above remains.
The root full `pnpm check:affected` and documentation checks also passed.
No paid model completion, deployed cloud reconciliation or real crash test ran.

- [Adapter PR #45](https://github.com/LodyAI/acp-extension-codex/pull/45):
  `src/CodexUsage.ts`, `src/CodexEventHandler.ts`, token-usage event tests.
- [Lody PR #736](https://github.com/LodyAI/Lody/pull/736):
  CLI usage-delivery service/tests and [Spec](../../../../specs/usage-delivery.md).
