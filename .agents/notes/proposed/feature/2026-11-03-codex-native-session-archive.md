# Native Codex archive synchronization

Status: proposed
Translation: current

[中文](2026-11-03-codex-native-session-archive.zh.md)

## Abstract

Archiving a Lody conversation currently releases its runtime but leaves its Codex thread active. This change mirrors committed archive and restore transitions to the exact native thread through Codex's app-server lifecycle API. The owning machine resolves the saved Provider and account home; native failures remain visible without preventing Lody cleanup. This first version covers builtin Codex and leaves historical backfill and a provider-neutral capability contract outside its scope.

## Ownership and ordering

`MessageHandler` observes committed archive metadata and coalesces changes arriving during cleanup. `SessionManager` serializes native operations per Lody Session and reads the latest metadata before each operation. Archiving follows runtime termination; a cold native resume joins the same serialization and requests restoration before starting ACP. A deleted record, foreign machine, absent native ID, unsupported Provider or superseded archive state authorizes no native mutation.

The native process uses the selected account's environment and process-use lease. It neither resumes a conversation nor starts a model turn. Its request budget is 30 seconds; the shared process owner terminates its tree on completion or failure with a bounded kill wait. A failed release preserves the process owner's error and account-use record. Ancillary synchronization failure emits an existing agent warning, while document cleanup still proceeds. A later archive/restore retries rather than caching the failure.

## Native state and alternatives

Codex rejects a repeated `thread/archive` request once the rollout has moved. The synchronizer first uses `thread/read`, verifies the returned native ID, and checks its path against the selected home's `sessions` and `archived_sessions` roots. Already-matching state is a no-op. Unknown storage paths fail visibly; titles and workspace names never identify a thread.

Direct SQLite updates and rollout moves bypass native index/file lifecycle and are excluded. Extending ACP Core and every adapter would expand this Codex-specific change into a separate protocol design. Existing daemon orchestration remains Promise-based, so the new transport consumes the shared legacy process facade instead of claiming an upper lifecycle migration.

## Verification limits

Synthetic subprocess tests cover native archive/restore, duplicate observations, identity refusal, errors and cancellation. The owning SessionManager suite covers machine/Provider/state guards, account-home selection, cleanup after failure and serialized restoration. Other Providers, automatic reconciliation of archives predating this feature, and a persistent success/pending status UI require separate work. The linked feature request remains open for those broader requirements.
