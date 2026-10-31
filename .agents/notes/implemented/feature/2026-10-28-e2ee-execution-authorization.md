# Machine-owned execution authorization freshness

Status: implemented
Translation: current
PR: [#1991](https://github.com/LodyAI/Lody/pull/1991)

[中文](2026-10-28-e2ee-execution-authorization.zh.md)

## Abstract

An established encrypted connection and a locally verified ledger do not prove that a device still has execution permission. The machine now offers a narrow execution authorization gate that independently reads the authenticated current ledger, then verifies active membership and the existing non-Guest, non-recovery policy. Grants live only in memory for less than 15 minutes from the start of that read; restart requires a new read. Refresh failures reject only waiting new executions, leaving existing tasks and local work outside this gate. Request authentication and durable execution claims remain separate integration responsibilities.

## Decision and flow

This implements the execution freshness rule in the [whitepaper](../../../../specs/e2ee/whitepaper.md) and [permission ledger](../../../../specs/e2ee/permission-ledger.zh.md). It complements the [journal boundary](../../proposed/architecture/2026-10-26-e2ee-realtime-journal.md); neither the journal nor content authentication grants execution authority.

```text
new execution (authenticated requester key)
  authorizeExecution(workspaceId, requesterDevice)
    unexpired device grant? use its original read start
    otherwise join/start this workspace's authenticated ledger read
      own device credential -> fixed checkpoint pages -> runtime.ingest
    runtime.executionLedger -> current active device/member/role
    check original read age again -> Authorized | Denied
  caller still owns request validation, journal claim and dispatch
```

`requesterDevice` is a lowercase hex signing public key. The Effect result uses `_tag: Authorized | Denied`; denial reasons are `invalid-request`, `not-authorized`, `unavailable`, `closed`. The workspace facade exposes the native Effect unchanged except for its terminal close guard. The runtime exposes its current VerifiedLedger view under its existing serialization; signatures, history continuity and durable rollback pins stay with the existing core. Freshness timestamps and grants are never written to those stores.

The gate uses the machine's `CloudE2eePort.getHistory` credential and rejects an endpoint behind its initial local checkpoint or inconsistent page checkpoints. Core `contentPermissions` already expresses the same active personal/machine and Owner/Admin/Member policy. Every admission reevaluates it against the newest local verified view, so known revocation or downgrade immediately rejects a cached grant. A locally known revoked or removed target machine also rejects admission. Forwarded timestamps, certificates and connection state are absent from the interface.

## Ownership and containment

Each workspace/device-identity Scope owns one refresh fiber and at most 1024 requester grants. Concurrent misses share that fiber, including different devices; cached grants remain device-specific. Both wall time and monotonic elapsed time must remain below 15 minutes from read start; clock rollback invalidates a grant. Eviction requires an earlier reread, never a longer grant.

The refresh is bounded to 30 seconds. Cancelling a waiter leaves the producer for siblings. Scope close cancels it and clears grants; a late unabortable read reply cannot resume ingestion. The existing cloud read itself has a 30-second transport timeout. Reads have no remote write effects. A failure or timeout produces retryable `Denied/unavailable`; it does not set the workspace's background ledger fence, invoke its unavailable/removal callbacks, close replicas or stop execution owners. Verified ledger updates can still reveal real revocation, which existing owners process under their separate policy.

Persisting a grant, renewing at response receipt, or borrowing a content-token cache would weaken the restart/read-start bound. Reusing the background refresh would also couple admission failure to key reception and workspace cleanup. The dedicated native gate reuses the existing verifier and transport without those side effects. It introduces no backend or wire changes and does not migrate the larger Promise workspace facade.

## Evidence and limits

Deterministic tests extend `e2ee-runtime.test.ts` with real signed ledgers and SQLite, injected clocks and explicit concurrency signals. They cover the exact 15-minute boundary including read duration, offline restart against the same files, device/workspace isolation, shared success/failure and retry, waiter cancellation, known role changes/revocation/removal, recovery/unknown devices, rollback/corruption, expired reads, timeout/late replies and multi-page checkpoint consistency. The affected runtime/custody suites, CLI typecheck, scoped lint/Effect checks, format, documentation and public/platform boundary checks qualify local implementation only. Temporarily doubling the freshness limit made the 15-minute boundary test fail with an incorrect Authorized result; restoring the limit passed. RPC entrypoint integration, request integrity, journal claim ordering, deployed service behavior and real network/device acceptance remain separate; this gate alone enables no dispatch.

The [execution-claim follow-up](../../proposed/architecture/2026-10-28-encrypted-agent-execution-claim.md) records the proposed same-member machine restriction and terminal credential-revocation handling on top of this baseline; the authorization call signature stays unchanged.
