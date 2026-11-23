# Bound hosted PR association failures

Status: implemented
Translation: current

[中文](2026-10-10-bounded-pr-association.zh.md)

## Abstract

An unlinked repository previously retried hosted PR association indefinitely at a
15-minute interval. The shared cloud port now stops after six consecutive failures
per workspace/repository, logs one actionable error, and keeps further callers
unconfirmed without sending requests. GitHub observation remains independent.
Repairing access after exhaustion requires recreating the machine's cloud client,
usually by restarting its Lody background agent.

## Decision

The gate is shared by turn finalization and the PR poller, independent of session,
PR number and repository-name casing. Success before exhaustion clears the gate;
recreating the runtime starts a new budget. Keeping a 15-minute cooldown alone
was insufficient because it bounded rate, not total attempts.

The existing 256-entry failure cache used eviction. Eviction would silently
replenish exhausted budgets, so the new tracker reserves a slot before I/O and
refuses new repositories while full. Existing gates can still recover and free
space. This trades rare high-cardinality admission for a real bound on retries
without growing memory or persisting scheduling state.

Only a parsed `repository_not_linked` envelope is labeled as that reason. Generic
HTTP and network errors retain their own diagnostics. The CLI logs exhaustion
once; the existing PR identity error explains Settings > GitHub and agent restart.
The GUI does not receive the CLI's exact attempt counter or claim to know when it
was exhausted. No new synchronization field or authorization bypass is introduced.

Deterministic tests use an injected clock and deferred fetches to cover cooldown,
exhaustion, cross-session sharing, isolation, capacity, concurrency, success and
runtime recreation. This extends the [observation contract](../../../../specs/local-github-pr-observation.md).
Live GitHub installation repair and deployment are not part of the local tests.

## Ablation evidence

In [PR #1382](https://github.com/LodyAI/Lody/pull/1382), removing the old
Map delete/reinsert operation preserved all 13 association tests: insertion order
is no longer used for eviction. Removing only the separate pending Set failed the
concurrent-session test. Using the existing reserved Map entry with an infinite
retry deadline until settlement passed all 13 tests, including concurrency and
capacity, and replaced the duplicate Set/finally cleanup. Each variant was tested
independently; the failure is evidence to retain the gate, not the second container.
