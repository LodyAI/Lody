# Automation ledger query columns and deadline scheduling

Date: 2026-11-21
Status: implemented
Translation: current

[中文](2026-11-21-automation-ledger-query-columns.zh.md)

## Abstract

The automation ledger stored nearly every queryable field inside JSON `payload`
columns, so hot predicates ran `json_extract`/`json_each` full-table scans with
synchronous parsing on the main thread, and provider capacity events flooded the
table by republishing recovery on every observation whose previous snapshot was
stale or fingerprint-mismatched. Schema version 4 lifts every predicate field into
real indexed columns, keeps the payload as the frozen acceptance-time record, and
moves wait resource reads into a `wait_reads` table. The engine loop now races an
explicit wake signal against a sleep until the earliest durable deadline, capped at
15 seconds, replacing the work-remaining rescan and the one-second probe. Capacity
publication requires a confirmed unavailable-to-available transition while recovery
wake scanning still follows every fresh matching available observation, resolved to
candidates for that binding/model through normalized columns instead of a workspace-
wide payload scan.

## Decisions and ownership

Every predicate field is a real column with an index covering its access path;
`payload` is written and read only to reconstruct domain objects. `waits.due_at`
stores `min(nextCheckAt, expiresAt)` computed at write time, so `dueWaits` is a
single indexed range scan. `receipts.session_id` replaces a three-way OR over
`sessionId`, `target.sessionId` and `parameters.sessionId` because acceptance
guarantees the three agree. `retry_at` stores `0` for "due now" rows — fresh
receipts and staged turn outcomes — while claiming a submission writes
`now + 15s`: an in-flight submit must never hold the ledger's next deadline at 0,
and a crash mid-submit still reconciles within the same 15-second bound as every
other retry. The migration is
idempotent — each `ALTER` is guarded by `table_info`, so partially columnized
databases upgrade cleanly — and backfills by re-parsing payloads through the same
`columnsFrom*` helpers the write paths use, which removes the SQL/JS drift a SQL
`json_extract` backfill would introduce. Backfill reads run in bounded rowid-keyed
batches (512 rows): a whole-table `.all()` materializes the entire payload column
in memory, and streaming `.iterate()` cannot share the connection with the write
cursor inside the same transaction.

Optional predicates never compile to `(? IS NULL OR col=?)`: SQLite abandons the
column's index for the whole statement, so `wantsRead`, `waits` and `activityPage`
emit parameter-specialized statements instead. Driving queries keep positive
`state IN` lists over the shared nonterminal set — `NOT IN` made SQLite ignore the
deadline index entirely — and `receipts_due_active` is a partial index over that
list, so `pending` and `nextDueAt` search live rows only.

Demand readers take a workspace-scoped set, never a per-session lookup. The PR
poller previously called `wantsRead(resource, sessionId)` once per tracked session
inside `buildTargets` — roughly 460 synchronous reads per pass on a real workspace,
each pass running two to three times per wake. `wantsReadSessions(resource)`
returns the same demand as a `Set` in one indexed join; `buildTargets` and the
workflow-recording loop do `Set.has` membership checks, so demand cost is constant
in session count.

A durable denial converges instead of re-verifying forever. `admit` re-checks each
queued input at dispatch; a `no` carrying `terminalState`, a `guard:` verdict, or a
reason in the durable set (revoked grant or authorization, deleted target, ended or
mismatched pending work) moves the receipt to `cancelling`, so the engine's cancel
path removes the queue row and settles it. A queued receipt whose row is still
live runs the same check inside `reconcile` before re-signalling the queue.
Stopped and archived targets stay transient — both are user-reversible — and keep
the retrying `queued`/`blocked` states by design. The alternative, a boolean
"admission denied" retried on a timer, is what produced unbounded
`automation-admission-blocked` churn on dead inputs.

Guard verdicts share one `guard:` reason namespace at every evaluation site —
the engine's `check()` and the resource-admission `recheck()` both prefix a guard
denial, so `isDurableSessionDenial` classifies them identically. Without the
shared namespace a stale Auto Delivery guard (`delivery_pr_changed`,
`delivery_step_replaced`) returned raw at admission escaped the durable set and
the superseded input re-verified forever — the confirmed review defect this
namespace exists to close. Cancellation preserves the denial: a `guard:` receipt
settles `superseded`, other durable denials settle `cancelled`, both with their
original reason instead of `user_cancelled`.

`nextDueAt()` reports the minimum due timestamp across nonterminal waits, nonterminal
receipts and staged turn observations, with an accepted delivery forcing "due now".
Each loop iteration sleeps until `min(nextDueAt, now + 15s)` or until a wake signal;
the 15-second bound keeps `host.observe` — staged-outcome reconciliation and
auto-delivery advancement — progressing when no ledger deadline exists. A staged row
is deferred 15 seconds before its owner read, so `retry_at = 0` only occurs between
staging and the next pass, exactly when an immediate pass is wanted.

`provider.capacity.available` publishes only when the prior same-fingerprint
observation evaluated `no` and the current one is `yes`. Recovery wake scanning is
not gated on the event: every fresh matching `yes` bumps `capacityWakeRevision`
once per push, because a receipt parked at `MAX_SAFE_INTEGER` has no other revival
path and `unknown`→`yes` still constitutes new evidence. The scan is scoped to the
observed binding/model — `receipts.work_id` joins to `work(binding_id,
fingerprint, model_id)` columns — so its cost follows the matching candidate set,
not the workspace's recovery-receipt count. A `capacity` marker row records the
highest `observedAt` scanned per binding/model key; re-pushed snapshots with the
same or older `observedAt` skip the scan entirely since they can produce no new
wake.

## Rejected alternatives

- Expression indexes over `json_extract`: predicate text must match the index
  expression literally, the `json_each` lateral join cannot be indexed at all, and
  storage stays unnormalized. `operation-store.ts` is the owning precedent for
  real columns plus payload records.
- An SQLite worker thread: synchronous better-sqlite3 was not the defect — the
  schema was — and moving the ledger off the main thread forces the synchronous
  admission callbacks (`canSubmit`, `setPendingWork`) async.
- Event retention/deletion: deferred. Deleting an event row allows the same
  source/id to republish and collide with the deliveries primary key that currently
  deduplicates it; safe retention needs a separate `event_keys` table.
- A correction to the original diagnosis: schedule `isFinished` reads in-memory
  snapshots via `hasAutomationSessionWork`; the ledger scans it was blamed for
  actually run inside `SessionAutomationAuthority.inspect()` on the admission path.

## Verification and limits

Tests cover the v2→v4 migration including a partially columnized database and
staged-outcome preservation, an `EXPLAIN QUERY PLAN` ratchet over the query
whitelist (any `SCAN` on the hot tables fails, covering-index sweeps included;
small rule/source scans are allowed), column↔payload consistency after every write
path, capacity publish gating with wake decoupling, deadline/wake/15-second-cap
scheduling under fake timers, a scheduler regression bounding workflow-demand
reads per build regardless of session count, and queue-boundary convergence:
a queued continuation whose admission guard went stale is cancelled by the real
`cancelInput` removal and settles `superseded` with its guard reason, while a
stopped target keeps waiting. Event growth remains bounded only by source
discipline until the deferred retention design lands; the durable-denial set is
maintained by hand next to the authorizer that emits those reasons.
