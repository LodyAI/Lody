# Bind Roost cached bodies to their checkpoint

Status: implemented
Type: bug-fix
PR: https://github.com/LodyAI/Lody/pull/1765
Translation: current
Date: 2026-10-21

[中文](2026-10-21-roost-cache-checkpoint-body-binding.zh.md)

## Abstract

A legacy full-body refresh could advance cached text while retaining an older checkpoint. If owner capabilities arrived later, content patches replayed an already applied append and persisted duplicate text. Cache writes now invalidate checkpoints unless the retained bodies remain bound to them, and incremental readers rebuild an unbound snapshot before resuming patches. A new disposable cache namespace isolates already persisted bad heads and old tabs that still write the old format. Authoritative Roost history and its database format are unaffected; upgrading requires an initial owner read to populate the new cache.

## Decision

- A cached checkpoint certifies every body in the retained window. Legacy changed-turn writes clear it atomically with the bodies. Page writes without a checkpoint also clear it; a protected partial page cannot certify an unbound prefix or combine it with a different checkpoint. A complete consecutive change can preserve the established binding while advancing it.
- An incremental reader finding an unbound head uses the existing protected paged snapshot replacement. It stages complete pages in the other slot and publishes only after they form a coherent snapshot. Existing bounded reads, disposal, error handling and supersession backoff remain in charge. Failure retains the previous durable head and retries; it never enables patches over an uncertain base.
- Keep the existing atomic body/head transaction and checkpoint compare-and-swap. Invalidating a checkpoint also rejects an older in-flight patch even when the revision is unchanged.
- Use `lody:roost-history-v2` instead of trying to interpret or repair v1 heads. Old clients spread unknown head properties, including during same-revision page merges; a presence marker would not establish provenance. A separate namespace avoids trusting any old writer. V1 is left untouched; old and new tabs can read the same authoritative history without sharing a patch baseline. This is an on-demand rebuild of a read-only renderer projection, not a Roost migration or deletion of locally accepted input.

The cost is one cold-cache fetch after upgrading, and a coherent snapshot rebuild when a legacy refresh transitions to incremental reads. Steady-state patch watches keep their existing transfer savings. A first offline open cannot reuse the old cache until the owner has populated v2. V1 storage remains until ordinary cache cleanup.

## Verification and limits

The real Native SQLite owner and real IndexedDB bridge reproduce revision 1 / C1 / `base`, a legacy refresh to revision 2 / `baseA`, then late capability negotiation. The fixed cache equals the complete owner read (`baseA`). Temporarily removing checkpoint invalidation makes that same regression fail with `baseAA`.

The owning frontend suite covers legacy changed-turn and page writes, different-checkpoint partial pages, atomic complete recovery, rejection of stale in-flight changes, persisted v1 heads and concurrent old-page writes. All 46 frontend bridge/cache tests and 81 Native backend contract tests pass, including the existing patch-budget and encrypted-RPC tests. These are deterministic synthetic fixtures; they establish the covered transitions, not an exhaustive proof over arbitrary storage corruption.

This corrects the cached-base assumption in the [content-patch decision](2026-10-20-roost-history-rpc-patches.md) without changing its protocol or native eligibility rules.
