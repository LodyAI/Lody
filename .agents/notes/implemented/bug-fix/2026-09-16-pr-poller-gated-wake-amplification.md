# An exhausted PR-poll quota turned every external event into a full wake

Status: implemented
Translation: current

[中文](2026-09-16-pr-poller-gated-wake-amplification.zh.md)

## Abstract

With six repositories on one GitHub credential and a 4 points/minute bucket, an
empty quota bucket is the reconciler's steady state, not an edge case. In that
state the poller woke about 14.6 times a minute instead of the designed ≤2 —
measured over the 70 minutes of `~/.lody/logs/2026-09-16.log.1` in which the
bucket was empty, by grouping 2239 `Bucket empty` lines into wake passes at a
400 ms gap. Each of those wakes rebuilt the target set, resolved a credential
per repository, and then discovered the scope was gated, writing one log line
per repository per wake. The excess came from two external trigger paths —
presence heartbeats and session-metadata writes that had nothing to do with
PRs — both of which called `runWake` directly. The fix makes `scheduleWake` the
single wake entry point (it may only move a wake earlier, never past a gate),
drops gated batches before credential resolution using the last observed
`repository → credential scope`, and throttles scope-wide skip logs to one per
gate window. The scope mapping deliberately expires after ten minutes: gating by
a remembered scope is a fast negative only, and without expiry a long freeze
would lock out a newly available credential belonging to a different, healthy
scope.

## The diagnosis that was wrong, and the one that holds

A `scheduleWake()` livelock through `anyDue ? nowMs : …` was proposed and does
not hold. `scheduleWake()` had exactly two call sites, `start()` and the
workspace-ready path; `runWake()` ends with `computeNextWakeAtMs`, which only
lowers the wake toward targets whose `dueAtMs > nowMs`, so a skipped-but-due
target cannot pull the next wake back to now; and `preflightScope` already
pushed `scopeQuotaAvailableAtMs(...)` into `deferredHints`. Deferred wakes on
skip were already the behaviour, and were left alone.

What the log actually shows is amplification from outside the wake loop. Both
external paths bypassed `scheduleWake` entirely and enqueued `runWake`:

- `onSessionMetadataChanged` → `scheduleMetadataUpdate` (2 s debounce) →
  `applyPendingSessionMetadata`, which set `changed = true` for any successfully
  read meta on the local machine without comparing content. A title,
  `lastReadAt`, status, or usage write — the bulk of session metadata traffic —
  therefore bought a full re-projection and a wake.
- `onPresenceChanged` (1 s debounce) → `runWake`, so viewing heartbeats,
  including the 10 s heartbeat of a stuck session, pulled a wake each time.

`runWake` then entered its batch loop without asking whether the scope was
already gated, so the cost per wake was one `resolveCredential` plus one
`Bucket empty` line per repository.

The cost is structural rather than occasional: `pr-poller-config.ts` defaults to
`bucketRefillPointsPerMinute: 4` and `bucketCapacityPoints: 20`, which for six
repositories means the bucket is empty far more often than not.

## What changed

Three mechanisms, each with a distinct responsibility:

1. **Projection-relevant metadata only.** `computePrPollMetaSignature` (in the
   pure `pr-poll-targets.ts`) names exactly what the target projection and the
   lane rule read out of one session meta: `machineId`, `parentSessionId`,
   `isArchived`, `lastMessageAt`, the discovery branch, the resolved GitHub
   repository, and the `pullRequests` list including order (the current PR is
   the last item). The replica still takes every fresh meta; only a moved
   signature counts as `changed`, re-projects, and schedules a wake.
2. **Gate before credentials.** `evaluateScopeGate` moved into the pure
   `pr-poll-quota.ts` and answers "can this scope spend on this repository now,
   and if not, when" for repo cooldown, freeze, and empty bucket in that order.
   `runWake` now drops gated batches before the batch loop, and `preflightScope`
   is the same decision applied after a credential is known — one rule, two
   call sites. Gating before the loop needs the scope without resolving a
   credential, which is what the `knownRepoScopes` map provides.
3. **One skip line per gate window.** Scope-wide skips (`frozen`,
   `bucket-empty`) log once per `(scope, reason)` until the gate can next open;
   repo cooldowns stay silent because they are already logged with their backoff
   when entered.

Externally triggered wakes now go through `scheduleWake`, which computes
whether any due batch is actually dispatchable and otherwise schedules at the
earliest gate opening. Because `scheduleWakeAt` only ever moves a wake earlier,
an external trigger can still promote a viewed session immediately when the
scope is open, but can never jump a gate.

## The trade-off in gating by a remembered scope

A credential decides its scope, so skipping a scope without resolving the
credential necessarily uses the scope observed last time. Left unbounded that is
a correctness hazard: a one-hour rate-limit freeze on the ambient `gh` scope
would suppress polling even after a managed credential on a different, healthy
scope became available. `SCOPE_MAPPING_TTL_MS` (10 minutes) bounds it — a stale
mapping falls through to a real `resolveCredential`, which re-stamps the
mapping. The remaining exposure is that a new credential can wait up to ten
minutes behind a long freeze, which is accepted: the alternative, resolving a
credential per repository per wake, is the defect being fixed.

An alternative considered and rejected was persisting `repository → scope` in
the state store so a daemon restart would not need one ungated wake to learn it.
One extra wake per daemon start is not worth growing a store whose stated
contract is disposable scheduling memory.

## Verification

`npx vitest run src/lib/pr-poller` from `apps/cli` (183 tests). The behavioural
coverage sits in `pr-poll-scheduler.test.ts`, extended rather than duplicated:
three repositories on one exhausted scope survive 50 seconds of presence
heartbeats and unrelated metadata writes with three credential resolutions, one
`Bucket empty` line, and a bounded skip count, then poll at refill time; a
viewed session heartbeating under a freeze cannot dispatch before the thaw; and
a replacement credential on a healthy scope polls ten minutes into an hour-long
freeze on the old scope.

Each mechanism was ablated to confirm the tests fail without it: removing the
pre-loop gate, the log throttle, the `scheduleWake` gate, the routing of
presence/metadata through `scheduleWake`, and the mapping TTL each fails one or
more of the new tests, and narrowing the signature fails the
`computePrPollMetaSignature` contract test.

One honest limit: ablating the signature check in the scheduler alone (treating
every metadata write as changed) leaves all tests passing. Once the wake is
gated, an extra wake is cheap, and the remaining cost of an unrelated write is
`enumeratePrPollTargets` over every session — real CPU on a large workspace, but
not observable through the workspace handle. That mechanism is therefore pinned
at its pure-function contract rather than through a mock tally.

## Documentation gap found

`specs/pr-status-reconciler.md` is cited as normative by `apps/cli/AGENTS.md`,
`.agents/docs/cli-overview.md`, and `apps/cli/src/lib/pr-poller/AGENTS.md`, and
by section name throughout the pure modules, but it has never existed in this
repository — `git log --all` finds no revision that added it. The wake semantics
this change alters could therefore not be revised as a `draft` Spec. They are
recorded here and as an invariant in `apps/cli/src/lib/pr-poller/AGENTS.md`
instead; a Spec revision is still owed if the document exists outside the public
boundary.

## Evidence

- `~/.lody/logs/2026-09-16.log.1` — 2239 `Bucket empty` lines, one credential
  scope, six repositories; 1022 wake passes at a 400 ms grouping gap; 14.64
  passes per minute averaged over the 70 minutes containing them.
- `apps/cli/src/lib/pr-poller/pr-poll-scheduler.ts`,
  `pr-poll-quota.ts`, `pr-poll-targets.ts` — implementation.
- `apps/cli/src/lib/pr-poller/pr-poll-scheduler.test.ts`,
  `pr-poll-quota.test.ts`, `pr-poll-targets.test.ts` — tests and ablations.
