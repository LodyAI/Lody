# E2EE execution journal MVP recovery

Status: proposed
Translation: current

[中文](2026-10-27-e2ee-realtime-journal-recovery.zh.md)

## Abstract

A bad local clock could persist a machine-wide floor that rejected unrelated
workspaces after restart, and interrupted first creation could leave an unusable
empty file. The owner decision of 2026-10-27 withdraws that accepted availability
limit: use workspace clocks, reject large forward skew against authenticated time,
and provide an explicit local archive/reset operation. Current-format old request
IDs remain fenced across reset; unknown outcomes never authorize takeover or replay.
This is a dormant host-storage change, not M5 dispatch or desktop acceptance.

## Decision and scope

This partially replaces the [journal proposal](../architecture/2026-10-26-e2ee-realtime-journal.md).
The former permanent file-global clock floor is withdrawn, but its original reason
remains: wall time alone cannot establish whether a clock correction or real elapsed
time occurred. Preserve original deadlines and at-most-once claims. Production has
no encrypted workspaces; journal schema 3 is current-only, without schema 2 decoding,
migration, archive import, or a second supported wire profile. The narrow archive
exception is recorded in the [foundations draft](../../../../specs/e2ee-foundations.md#format-compatibility).
The proposal status remains because this change is submitted for review, and does
not approve pending realtime wire or product integration decisions.

`trustedNow` is an optional injected callback returning current independently
authenticated reference time in epoch milliseconds, or `undefined`. The caller must
project a fresh authenticated service sample to the current instant; a request's
opaque bytes or timestamp are not a reference. Before updating a floor, local time
more than 600,000 ms ahead returns `clock_skew` with a clock-calibration message.
Exactly ten minutes is allowed. Accepted referenced calls use reference time, not
the ahead local value. A retained floor more than ten minutes ahead of the reference
also refuses advancement; explicit reset clears that workspace's poisoned floor.
No network, server-time cache, timer or new authorization source is introduced.

Floors are keyed by `(genesis, workspaceId)`. Without a reference, retain the
conservative local maximum within that workspace. A forward error can still reject
new work in that workspace until explicit reset; it cannot poison another workspace.
This fallback does not silently renew deadlines or guess how far to move time back.
Completed results and retained response frames stay readable despite clock errors.

## Reset, archive and ownership

```text
lody e2ee journal reset --file <account-private-journal-path> [--json]
  commit retired current request IDs + reset intent in stable control SQLite
  recover/checkpoint old journal through SQLite; close it
  rename old journal -> unique archive path
  initialize schema 3 with fresh journal identity
  clear reset intent; return archive path
```

Stop execution owners before resetting. The explicit file path is necessary while
M5 has no product-owned journal location. The command is hidden from ordinary CLI
help, lazily loads storage, uses the existing one-shot exit/flush path, and opts
out of cloud time sync and analytics initialization. It does not probe custody or
contact the daemon. Desktop wiring remains deferred.

Ordinary adapter operations hold shared transactions on the stable adjacent
`.control.sqlite`; reset stages require exclusive transactions. Independent opens
remain usable while another owner retains a failed-close handle, but reset waits
for confirmed closure. Keep this file: it owns SHA-256 identities of retired
current-format request keys and the pending archive/replacement identity. These
are execution fences, not copied runnable rows. Resetting again retains earlier
fences. A resend of a retired ID returns `archived_request`; a previously used owner
or permit cannot operate on a fresh journal identity (`journal_reset`). Archives
are never scanned for work, decoded as legacy formats, or imported automatically.
Format version and complete schema usability are separate checks. A schema-3 store
must retire every readable request key before archival, even when response, clock,
or other request columns are incomplete. Reading these current-format keys does
not depend on the damaged tables or grant authority to execute their rows. If the
request-key table, a key column, or any key value cannot be read and validated,
`request_keys_unreadable` refuses archival/reset and keeps the original for repair.
The control transaction rolls back partial retirement and publishes no reset intent;
repeating reset remains safe, and repairing the key evidence permits normal retry.
Older/unknown versions are never decoded; their archived rows are never submitted
to execution by this module.

Reset uses a durable intent before rename because SQLite cannot atomically commit
an OS rename with SQL. Other calls observe `reset_required` while intent remains.
If archive or replacement initialization fails, retry explicit reset to continue
that same intent and archive path. After rename but before schema commit, the empty
replacement is initialized with the retained identity on retry. No automatic
replacement is created merely because an archive exists or a file is missing.

SQLite normal recovery precedes inspection. Only version zero with no schema
objects is treated as interrupted first initialization. Unknown versions and missing
required schema are archived with a typed error and evidence path, provided current
request keys can be retired; explicit reset is needed to proceed. Raw corruption remains a storage failure. Before rename,
SQLite switches to DELETE mode, consolidates WAL, and obtains an exclusive database
transaction. Busy native readers/writers refuse that operation; no sidecar is copied
or removed by application code. Committed logical evidence and schema are preserved,
although native recovery/checkpoint and journal mode may change physical files.

The synchronous SQLite adapter remains synchronous; adding Effect wrappers here
would introduce a separate execution boundary without replacing an unfinished
product owner. No migration is claimed. Transactions contain no asynchronous wait
or cancellation point. Normal close failures retain at most one main handle and
its control-lock handle, plus one pending diagnostic. Independent owners can continue ordinary SQLite
operations under shared locks; only reset needs exclusive access. Retry closes main before
releasing the lock; other owners cannot rename it while cleanup is unresolved.
A committed result remains readable and successful even when close fails. Owner
or process termination bounds the retained lifetime; there is no background retry.

## Failure containment and unknown outcomes

| Trigger | Scope and recovery |
| --- | --- |
| Clock skew | Only the new claim fails; no floor write, key access, or workspace teardown. Calibrate or explicitly reset; completed evidence stays readable. |
| No reference plus bad maximum | Only the matching genesis/workspace rejects; explicit reset provides a finite operator recovery path. |
| Empty first creation | Initialize atomically after native recovery proves no committed schema; independent opens serialize. |
| Incomplete current schema | Retire readable keys before archive despite unrelated schema damage; unreadable current keys refuse reset and preserve the original for repair. |
| Unknown version | Retain archive, report path, require explicit reset; no old-version decoder. |
| Reset interruption | Stable pending intent blocks claims; operator retry completes the same replacement. |
| Failed close | Original owner retains main plus shared mutex; other owners can continue ordinary work, but rename waits. Bounded diagnostic and explicit cleanup retry. |
| Crash after start | `state: uncertain`, `outcomeStatus: unknown`; only the original live permit can settle. A new request ID in that workspace remains independent. |

## Evidence and limits

Real on-disk SQLite tests use injected clocks and explicit worker/subprocess signals.
The five primary recovery regressions were run against unchanged main first and
all failed, then passed with the fix. Coverage retains hot-journal rollback, WAL
checkpoint, COMMIT BUSY, exact response/result originals, immutable identity and
competing claim coverage. New cases cover ten-minute boundary/reference rejection,
cross-workspace clocks, empty initialization, archive evidence, repeated reset,
retired IDs, old permits, interrupted replacement, cleanup/rename exclusion and
CLI reset receipts. The incomplete-current-store regression first fails on the
reviewed implementation: a completed original can be claimed again after reset,
and archive-first reset retains zero retired IDs. Both direct and archive-first
routes now cover completed, uncertain and received identities, while independent
new IDs remain usable. Missing request tables/key columns refuse repeated reset
without changing evidence; repair restores normal use and safe reset. All four
new cases were confirmed RED before the fix. No sleeps or network are used.

Run only affected tests and static checks locally; exact commands/results belong
in the PR. Remaining gaps: authenticated-time plumbing, sender freshness and query
authorization, dispatch and Meta/history fencing, UI, daemon quiescing, full CLI
packaging, Windows/Linux execution, power-loss/fsync acceptance, malicious local
replacement and storage-size/retired-ID reclamation. The new control file and
unexpired evidence can grow; exhaustion refuses dependent work, not deletion.
