# Preserve received Loro updates across a restart

Status: implemented
Translation: current

[中文](2026-10-22-loro-pending-persistence.zh.md)

## Abstract

A remote update can wait for a missing predecessor without advancing the document's applied version or emitting a change event. The existing Promise Repo persistence path can therefore omit received data when it saves ordinary snapshots or applied updates. Adopt Loro 1.17.0 and loro-repo 0.24.0, so received updates survive the existing SQLite save and reopen boundary. This protects local durability; it does not establish the cause of the reported overnight traffic or bound Streams recovery downloads.

## Decision and responsibility

Loro exports pending remote operations separately from applied history. Repo owns observing imports, scheduling pending-only saves, preserving received input in the existing update journal, and retaining work that arrives while storage is saving. Built-in storage adapters merge journal data with snapshots; normal compaction may discard bytes only after their operations are recoverable. Lody consumes those releases through its workspace catalog and exact CLI runtime dependency, rather than adding another persistence owner or changing the storage schema.

Applied versions and individual import results are not global pending-state queries. A local save does not mean missing dependencies have arrived, and must not authorize a complete remote snapshot or advance another replica's cursor. Export failures retain the last recoverable checkpoint; permanently absent predecessors still require real missing data or a usable replacement snapshot.

The [traffic investigation](../../proposed/bug-fix/2026-10-22-desktop-network-amplification.md) owns the original evidence and proposed download limits. Retaining pending data is preferable to discarding it and fetching from an earlier offset: the latter couples recovery to remote history retention and can repeat large downloads. Network recovery limits remain separate work.

## Verification and limits

The CLI regression uses real Repo and SQLite: save `base|`, receive B before A, flush, close, reopen the same database, supply A, and require `base|AB`. It repeats the final reopen and covers both `import` and `importBatch`. On the existing registry dependencies both cases fail with `base|A`, establishing the missing durability boundary without a server or captured user data.

The frozen registry install resolves one Loro 1.17.0 instance within each runtime domain. All 41 core files and 103 Repo files match their SRI-verified npm tarballs; there are no candidate overrides. Both SQLite regressions pass with the released packages. The test-only legacy Loro CLI retains its separate 1.16.3 override.

Full `pnpm check`, formatting, document checks and the real CLI build passed. A separate harness imports the emitted Core/Repo chunks and passes 16 SQLite recovery assertions, including a second reopen. Snapshot tests drive zero-delay cooperative tasks while waiting for sync and cleanup, without advancing their explicit debounce timers. Received no-op imports can trigger the existing Repo fairness yield after storage I/O; freezing that timer while awaiting its barrier would stall the test. No user-specific network capture, Nightly installation acceptance, or production traffic measurement is implied.
