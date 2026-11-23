# Prefetch Prompt Shortcut bodies while idle

Status: implemented
Translation: current

[中文](2026-09-29-prompt-shortcut-body-prefetch.zh.md)

## Abstract

Prompt Shortcut discovery intentionally carries only a small index, so the first invocation of an uncached Shortcut previously waited for its full Prompt and mention ranges. The workspace provider now schedules visible bodies during an idle window, while the runtime serializes all prefetch batches and coalesces a matching foreground read onto the same request. Loaded bodies reuse the existing durable per-account/workspace store, improving later and offline invocation without changing authorization. Remote body replicas still share a database with offline authored data, so reclaiming obsolete versions remains separate work.

## Decision

The index continues to omit the Prompt and mention ranges. Including bodies in every catalog sync would make discovery latency and bandwidth scale with authored Prompt size, even for clients that cannot use an entry in their current scope.

The provider starts prefetch only after a visible runtime snapshot exists and the browser reaches an idle window. The runtime, rather than React, owns network cardinality: it serializes batches across snapshot updates, ignores entries that are no longer current, and remembers successful bodies for the runtime lifetime. A foreground read bypasses the background queue but joins an identical in-flight read. Background failures remain silent and retryable; the ordinary selection path still reports an actionable error if the body is unavailable when selected.

Using the existing read path preserves directory checks before and after synchronization and preserves exact index/body revision validation. It also reuses the existing IndexedDB-backed Loro repository instead of adding an in-memory or second persistent cache. The trade-off is that prefetch increases the set of current remote bodies present in a database that normal cache clearing protects because it may contain the only copy of an offline edit. A reclaimable remote-replica store or explicit body garbage collection needs its own storage decision and migration evidence.

Alternatives considered were fetching bodies with the index, which would block lightweight discovery, and activating prefetch only after the command menu opens, which would preserve first-use latency and provide weaker offline behavior. Unbounded parallel prefetch was rejected because each miss obtains a scoped Streams room and catalog refreshes can overlap.

The product behavior is recorded in the [body-prefetch Spec](../../../../specs/prompt-shortcut-body-prefetch.md). This complements the [general-availability decision](2026-09-29-prompt-shortcuts-general-availability.md) and retains the [runtime retirement guarantees](../bug-fix/2026-09-25-prompt-shortcut-runtime-lifecycle.md).

## Validation

Runtime tests exercise foreground/background request coalescing, serial loading, failure continuation, retry, overlapping batches and cancellation of queued work. Provider tests verify that no body work starts before the idle callback. The focused suites pass with nine tests. Repository-wide type checking and linting, both affected package type checks, i18n checks and boundary guards pass after initializing the pinned ACP submodules.

The full `pnpm check` test phase did not complete in the sandbox because the inherited Git configuration required GPG signing for fixture commits; its affected 50-test Code Collab suite passes when signing is disabled for that process. `pnpm run docs check` recognizes both new language pairs without new document errors, but still fails on unrelated pre-existing broken links.
