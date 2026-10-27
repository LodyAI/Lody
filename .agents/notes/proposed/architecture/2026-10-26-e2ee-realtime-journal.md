# M5 host execution journal boundary

Status: proposed
Translation: current

[中文](2026-10-26-e2ee-realtime-journal.zh.md)

## Abstract

Encrypted RPC needs durable evidence that an original request already started,
including when its response is lost or its machine restarts. The isolated host
journal retains exact opaque frames, claims a start once through SQLite, and
preserves the first outcome independently of response delivery and cleanup. It also
retains exact opaque response frames before either transport may publish them.
It opens no product channel and supplies no authorization or approved wire format.
Product integration must also fence the existing durable dispatch path; storage
tests alone do not establish safe agent execution. Only the current journal format
is accepted. The 2026-10-27 owner decision withdraws the earlier permanent global
clock-floor limitation. The [MVP recovery decision](../bug-fix/2026-10-27-e2ee-realtime-journal-recovery.md)
adds workspace clocks, trusted-time checks, evidence-preserving reset and empty-store
recovery. SQLite-native recovery remains permitted; application schema migrations
remain forbidden.

## Existing evidence and reuse

The [foundations Spec](../../../../specs/e2ee-foundations.md) owns the public
cryptographic contract. Realtime wire and authority decisions still require owner
approval. This journal accepts internal opaque identifiers and bytes without
implementing a proposed encoding.

- `session-dispatch-watcher.ts` shares a per-session check between RPC offers and
  history. Its RPC stash is memory only, and its response acknowledges delivery.
- `session-dispatch-logic.ts` intentionally dispatches `processing` history after
  restart. `lastHandledUserMsgId` is a moving pointer, not a complete request journal.
- `session-execution-service.ts` retains steer submission and delivery uncertainty.
  Integration should query that evidence, retaining the existing userTurnId.
- `machine-rpc-server.ts` deduplicates concurrent history requests in memory.
  `session-history-rpc-rejections.ts` persists selected refusals only until expiry.
- The orchestration store already demonstrates SQLite identity checks and retired
  IDs. Its MCP task identity, ownership and result delivery are different; the
  journal does not create another task system or depend on that store.

This is host execution evidence, distinct from the renderer send journal removed
by [the earlier decision](../../implemented/simplification/2026-09-29-remove-session-send-journal.md).
Ordinary sends and their existing durability remain unchanged.

## Local contract

`apps/cli/src/lib/e2ee/realtime-journal.ts` is a synchronous Node storage adapter:
no timers, network, background work or Effect workflow is introduced. One owner
retains failed handle cleanup; synchronous SQLite transactions cannot be cancelled
mid-body and hold no network wait. Each operation opens the existing database,
uses zero busy timeout and closes its handle. Explicit first provisioning creates
the file exclusively. Short transactions use the
[upstream synchronous transaction contract](https://github.com/WiseLibs/better-sqlite3/blob/v13.0.3/docs/api.md#transactionfunction---function),
without catching mutation failures inside a transaction. Reopen accepts schema 3
only. After native recovery, version zero with no schema objects may complete first
initialization; other unsupported/incomplete schemas are renamed and reported,
without decoding or upgrading them. Replacement requires explicit local reset.
The stable adjacent control database coordinates shared opens against exclusive reset and retains retired
current-format request IDs and interrupted-reset intent. See the
[recovery decision](../bug-fix/2026-10-27-e2ee-realtime-journal-recovery.md) for its
ownership, crash boundaries and limits. Corruption still refuses dependent work.

The preservation boundary is committed logical evidence and application format,
not physical SQLite file identity. The owner approved SQLite-native transaction
rollback and WAL checkpoint, including before an unsupported application version
can be identified and rejected. Recovery can modify main/WAL/journal/SHM files;
it does not authorize application migration, evidence deletion, database replacement
or format repair. The recovery exception permits renaming evidence and explicit fresh
provisioning, without importing old rows. Closed rollback-mode stores needing no native recovery retain
byte/mode checks; WAL and interrupted-transaction cases instead verify committed
schema, version and evidence. SQLite owns its locks and recovery; the application
does not copy, delete or bypass journals to inspect an uncommitted header. Real
cross-platform and power-loss acceptance remains outstanding.

```text
receive(original) -> durable received
claim(original)   -> durable started + one owner-local permit
                 -> existing uncertain/completed, or expired; no new permit
finish(permit)    -> durable immutable completed outcome
retainResponse(permit, index, original) -> durable immutable response original
retryResponse(permit) -> settle only the retained pending response bytes
readResponse(originalRequest, index) -> retained response or absent
```

The key is `(genesis, workspaceId, targetMachineId, requestId)`. Requester identity,
deadline and exact frame bytes are immutable under that key. SHA-256 checks the
stored original and outcome against their retained digests; it does not authenticate local disk
against an attacker. A different valid requester cannot reuse an ID to start again.
The caller supplies an account-private path and must verify the frame and authority.

`BEGIN IMMEDIATE` and a stored random claim token serialize competing SQLite
connections. A successful claim returns one module-owned permit to its winning
owner. There is no lease expiry, replacement permit or ownership adoption.
Read/reopen maps started state to uncertain; only the original live owner may
settle it. A crash after a side effect therefore cannot authorize automatic replay.
The interface also reports `outcomeStatus: unknown`. Independent request IDs in
the same workspace remain runnable. Uncertainty needs existing execution evidence;
it grants no replacement permit.

The first `finish` attempt retains a copy of its outcome in the permit owner before
I/O. Failed persistence leaves started evidence; `retryFinish` retries only those
same result bytes. A crash before successful result persistence still loses that
in-memory result and remains uncertain. Committed outcomes are queryable after
restart and expiry. Repeated identical settlement is safe; replacement is refused.
Handle-close failures cannot replace a result or original operation error: the owner
retains the handle and first unconsumed diagnostic cause, and retries cleanup
separately. Repeated cleanup failure admits no new handle, and retains at most one
main handle plus its control lock and one pending diagnostic; successful cleanup permits the next call.
Corrupt or locked storage fails closed; restoration allows the next call to reopen.

Response positions are local storage indexes, not an approved wire sequence or
progress/final encoding. Only the original live permit owner can append, from
position zero without gaps. Repeating an occupied position requires identical
bytes; another original is refused. Queries match the complete original request
and return an owned copy of the saved frame after checking its digest. The table
is keyed by the full request identity and position, with a foreign key to the
request row. Restart retains those frames but cannot recreate the permit or
authorize a new signature, encryption or execution.

Once the next position and owner are validated, an attempted write retains at most
one pending response original in that permit owner before SQLite mutation. While
it is unresolved, another position or replacement bytes are refused.
`retryResponse` persists only that original; confirmed storage releases the pending
copy. Invalid positions and identity conflicts do not poison later valid calls.
Response-write failure leaves an already completed business outcome intact. The
caller must retain its original bytes and must not publish before storage confirms;
open/validation failure supplies neither delivery nor permission. There is still
no sender request outbox, acknowledgement policy or expiry-based response cleanup.

## Interrupted current-store recovery

A current schema-3 database may require rollback writes before SQLite can inspect
its committed schema. Read-only preflight prevented that normal recovery with
`SQLITE_READONLY_ROLLBACK`; it is removed under the narrow native-recovery decision.
A controlled subprocess exit after an uncommitted spilled outcome update exercises
the actual rollback boundary. Reopen must expose the original uncertain claim,
not the uncommitted outcome, and must not issue another execution permit.

The same native recovery applies before rejecting unsupported schemas. Their
committed version, schema and rows remain unchanged by the application, even when
SQLite consolidates WAL or removes a recovered rollback journal. Busy or failed
native recovery reports the original storage cause; after the lock or fault is
removed, the next call can retry ordinary recovery without replacing the database.

## Clock floor and explicit recovery

The earlier owner decision accepted one file-global maximum timestamp and persistent
rejection after a bad forward jump. The owner withdrew that availability trade-off
on 2026-10-27. Its rationale remains useful: local wall time alone cannot distinguish
clock correction from genuine elapsed time followed by rollback, and old deadlines
must never be silently extended.

Current floors are keyed by genesis/workspace. A caller-supplied current authenticated
reference rejects local time more than ten minutes ahead before any floor write;
accepted calls advance from reference time, not the ahead local value. Without a
reference, keep the conservative workspace maximum. The operator can archive/reset
the machine journal rather than wait for real time to catch up. Known old request
IDs remain fenced, so resetting a floor does not revive them or adopt uncertain work.
Details and CLI usage are in the [recovery decision](../bug-fix/2026-10-27-e2ee-realtime-journal-recovery.md).

No evidence is reclaimed at `expiresAt`; no GC or retired-ID policy is implemented.
Retained storage can grow without bound; exhaustion refuses dependent new work
instead of deleting evidence.

## Product integration still required

Both encrypted transports must enter one verified authorization boundary, persist
the same original, and use this shared claim before actual side effects. The
dispatch ACK is not the agent's final result. Bind each request to its real
userTurnId, steer/fork receipt and execution result without redoing those workflows.
The watcher and Meta/history fallback must observe the same start fence, otherwise
they can bypass reception-only deduplication. Recheck machine sharing, verified
ledger state, freshness, epoch/rotation pause and cancellation immediately before
new execution and subsequent actions. Wire, target-device binding, encryption,
sender request persistence and result-query authorization remain unconnected.
Opaque response retention alone enables no product reply or query endpoint.

## Verification and limits

`realtime-journal.test.ts` uses real disk SQLite, independent opens and competing
worker-thread connections. It covers exact bytes/identity, retained outcomes,
crash uncertainty, expired evidence, observed-clock rollback, owner-only settlement,
lock contention, missing/corrupt originals, interrupted empty-store initialization, rollback on injected SQLite
receive/start/result failures, and committed results with failed handle cleanup.
Response tests also cover immutable ordered originals, independent reopen,
pending-write recovery, completed-outcome preservation and rejection of non-current
or incomplete stores through archival without application migration or committed-evidence rewriting.
Signals coordinate concurrent workers; no sleep or network is used.
Database snapshots compare each BLOB by its SHA-256 digest and byte length, while
retaining schema, version, journal mode and every other column value. This avoids
Vitest's expensive deep traversal of multi-MiB Buffers without shrinking recovery
payloads or extending test deadlines. A same-length 4 MiB committed BLOB with one
changed byte fails snapshot equality. This changes only test evidence representation;
the journal and its persisted bytes are unchanged.
Zero-timeout contention may reject both workers, including at COMMIT. Tests allow
that valid schedule, then release competing owners and prove a normal claim either
observes the original uncertain start or obtains the one remaining permit. A real
held reader separately proves COMMIT failure rolls back and the next call recovers.

These are storage-boundary tests. They do not verify the full encrypted dispatch
chain, platform packaging, power-loss behavior, malicious local storage replacement,
real gateway behavior, native iroh, UI recovery or latency. Affected local checks and their limits are recorded in the recovery decision; full
repository checks and independent adversarial review remain unverified in that change. The proposal
does not approve a Spec or claim M2/M5 product acceptance.
