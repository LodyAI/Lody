# Session residency: leased Session documents and atomic retirement

Status: proposed
Translation: current

[中文](2026-10-17-session-residency.zh.md)

## Abstract

The #1607 consumer implementation and its dependent patches were withdrawn on 2026-10-19. The dependency upgrade remains. The sections below preserve historical implementation and verification, not the current product boundary. See the [rollback decision](../../implemented/simplification/2026-10-19-repo-upgrade-without-consumer-migration.md).

## Historical implementation (withdrawn)

## Problem

- `LoroDocumentManager.sessions` is a shared cache without reference counts.
  `cleanSessionDoc` disposes every holder's Mirror and subscriptions.
- `SessionGCManager.sweep` checks eligibility, then awaits
  `cleanSessionForGC`, which clears presence, closes previews, terminates the
  process and destroys the document. Anything that starts between the check and
  the destroy loses its document.
- Two notions of "active turn" disagree. GC reads the MessageHandler store
  phase, which stays idle through pre-prompt startup; dispatch reads the
  execution service registry.

The release half of the incident is fixed separately by
the turn release fix ([#1652](https://github.com/LodyAI/Lody/pull/1652));
this note addresses the ownership half.

## Behavior contract

| Question         | Contract                                                                                                                                                                                                                                                                                                 |
| ---------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Trigger          | Turns, dispatch watches and readers acquire. The GC sweep and memory-pressure eviction request retirement for idle Sessions. Archive and one-shot cleanups request retirement for a specific Session.                                                                                                    |
| Owner            | The residency owns each Session's resident value and the gate. Only a retirement holding the gate with zero leases may tear it down.                                                                                                                                                                     |
| Cancellation     | Acquire is uninterruptible as a whole, so a lease can never leak between taking the reference and registering its finalizer. Waits are bounded because every gate holder (`open`, `close`, teardown) is bounded by its owner.                                                                            |
| Handoff          | A retirement removes the generation only after its teardown and close succeed. A waiting acquire then opens a new generation. Two generations of one Session never exist at once.                                                                                                                        |
| Failure recovery | A failed teardown aborts and leaves the Session resident for the next sweep. A failed close keeps the value `retained`, and the next normal acquire reinitializes it (matching #1607's retained replica). A retirement deferred to the last release reports its failure and leaves the Session resident. |

## Process retention

A lease is not a teardown. Releasing the last lease starts the idle clock and
nothing else. The document and the Session's agent process stay resident so the
next turn reuses them. Only these end them:

- the GC sweep retiring a Session idle for `LODY_SESSION_GC_IDLE_TIMEOUT_MS`
  (20 minutes by default), measured from the last lease release;
- memory-pressure eviction of an idle Session;
- archive;
- abnormal paths owned elsewhere (an agent that ignores Stop, a lost
  connection, recovery of a blocked turn release).

## Decisions

- **A custom gate, not `RcMap`.** In Effect 4.0.2 (`RcMap.ts`), idle expiry
  and `invalidate` both remove the entry from the map synchronously and only
  then close its scope. A `get` in that window starts a new lookup in parallel
  with the old close, which recreates the two-replica overlap behind
  `replaced this replica`. `invalidate` on an in-use key also lets a second
  generation open beside the first, and there is no "evict only if idle"
  operation for memory pressure. The kernel therefore uses one `Semaphore(1)`
  per Session plus an explicit reference count.
- **The GC sweep stays the timer.** The existing sweep already owns the
  configuration (`LODY_SESSION_GC_*`), lifecycle and memory-pressure policy.
  The residency adds atomic admission (`retire` with `minIdleMs`, a veto and a
  teardown) and no background fiber of its own.
- **Teardown runs inside the gate.** Process termination, preview and
  simulator closes happen under the same gate as the document close, so an
  arriving turn cannot start against a half-torn-down Session.
- **Observation leases do not count as use.** An `observe` lease protects the
  value while it is held, but its release leaves the idle clock where it was.
  Without this, GC's own goal check borrowed every candidate document and
  restarted its idle clock just before retiring it, so neither the idle sweep
  nor memory-pressure eviction ever retired anything. This was found in review
  of the wiring PR.
- **Deferred retirement for archive.** `deferWhileInUse` closes a leased
  Session after its last release instead of destroying it under the holder.

## Delivery

1. Kernel `apps/cli/src/lib/loro/session-residency.ts` with behavioral tests
   (this PR). It stacks on the native Repo adoption (#1607).
2. Wire `LoroDocumentManager` Session documents, the GC sweep, memory-pressure
   eviction and turn execution through leases. Legacy one-shot
   `getOrCreateSessionDoc` callers take a lease and release it at once, which
   refreshes the idle clock and keeps today's 20-minute safety margin.
3. Convert the remaining one-shot callers to scoped borrows and delete the
   unreferenced cache, `pendingSessionDocs` and `isDestroyed` checks.

## Wiring

The second step wires the residency into the daemon:

- **Document cache.** `LoroDocumentManager` keeps Session documents only in the
  residency. `sessions` becomes a read-only view, and `pendingSessionDocs` is
  gone.
  - `acquireSessionDocLegacy` returns a lease.
  - `getOrCreateSessionDoc` takes a lease and releases it at once.
  - `cleanSessionDoc` retires now, or defers to the last release.
  - `cleanUp` ends with `shutdown`. Opens and closes still run inside the
    per-document ownership chain shared with renderer room bridges.
- **Turns.** Every visible turn holds a lease from before it registers until
  after it releases, through the optional `leaseSessionDoc` dependency. This
  covers pre-prompt startup, which the store-phase check never saw.
- **GC.** `cleanSessionForGC` retires through `retireSessionLegacy`.
  - `minIdleMs` comes from the GC policy: the idle timeout for the sweep, and
    60 s for memory pressure, so Legacy one-shot borrows are not evicted under
    their callers.
  - The in-memory eligibility checks run again as a veto under the gate.
  - GC's goal check and read-only history snapshots take `observe` leases, so
    reading a candidate never restarts its idle clock.
  - Presence, simulator, preview and process teardown run under the gate. A
    teardown failure keeps the Session and its tracking for the next sweep.
  - `cleanSession` reports whether the Session was retired, so a kept Session
    is never counted as evicted.
- **Teardown must not re-enter.** Preview cleanup used to reacquire the
  document to mark the connection closed. It now writes through the document
  the retirement hands it, or writes only the metadata when none is open.
  Process `exit` and `terminated` events raised by the GC teardown are ignored,
  because finalizing them would reopen the document just retired.
- **Not leased yet.** Dispatch watches take no lease. GC already vetoes
  Sessions with pending user work, which is the only time a watch is held.

## Verification

`session-residency.test.ts` uses `TestClock` and explicit deferreds. It covers:

- shared opens;
- refusal while leased;
- the minimum idle time;
- an acquire arriving mid-retirement, which receives a fresh generation;
- teardown and close failures with recovery on the next acquire;
- vetoes;
- deferred retirement;
- open failure.

A temporary ablation that lets the fast path ignore the gate makes the
mid-retirement test fail.

Integration tests use a real `LoroDocumentManager` over an in-memory Repo. They cover:

- a leased document refusing retirement, staying resident after its release,
  and retiring only after the idle minimum;
- the incident ordering: a turn arriving during a blocked GC teardown waits and
  receives a fresh, writable document, while the teardown writes through the
  doomed one;
- cleanup deferred to the last release.

A regression test runs the real `SessionGCManager` sweep with the real
MessageHandler goal check and `cleanSessionForGC` over a real manager. A Session
idle for 21 minutes is retired. Reverting the goal check to a plain borrow makes
the test fail with the review's P1: the retirement reports `recently-used`.

The existing retained-replica test from the native Repo adoption still passes.
Execution tests show a turn holding its lease through the prompt and keeping the
agent process afterwards.

Limits: one-shot callers still rely on the refreshed idle clock rather than a
held lease (step 3). Dispatch watches are not leased. MessageHandler's veto and
event suppression have no dedicated test, because MessageHandler has no
lightweight fixture.
