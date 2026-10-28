# Shared encrypted agent execution claim

Status: proposed
Translation: current

[中文](2026-10-28-encrypted-agent-execution-claim.zh.md)

## Abstract

The durable Meta/history dispatch path and a realtime offer can describe the same
user turn while carrying different transport requests. In-memory dispatch guards
cannot prevent another start after a daemon restart. Both entry paths now use the
existing SQLite execution journal with a stable `userTurnId` intent before creating
or restoring an agent or submitting its prompt. Unknown outcomes never permit a
retry; authorization remains an injected capability and denies starts when absent.
This proposal covers host admission, not delivered encrypted realtime transport or
end-to-end product acceptance.

## Boundary and authorization

This extends the [host journal boundary](2026-10-26-e2ee-realtime-journal.md) and
its [workspace-scoped recovery](../bug-fix/2026-10-27-e2ee-realtime-journal-recovery.md).
It does not change their schema, raw-frame receipts, clock floors, reset retirement,
or retention policy. No migration, timeout takeover, evidence pruning or plaintext
fallback is added.

```text
Meta/history -> dispatchPreparedSessionTurn --+
RPC offer -> watcher -> prepared dispatch ----+-> start/continue plan
                                                  authorize exact intent
                                                  journal claim(userTurnId)
                                                  agent creation/restore/prompt
                                                  retain settlement
```

`AuthorizeEncryptedExecution(intent)` returns
`Effect<Authorized | Denied, unknown>`, with no environment requirement:

```ts
type Intent = {
  workspaceId: string;
  sessionId: string;
  userTurnId: string;
  requesterUserId: string;
};
type Authorized = { state: 'authorized'; requesterDevice: string; expiresAt: number };
type Denied = { state: 'denied' };
```

The resolver must independently bind the exact intent to its verified original
requester device and original execution deadline, and check current authorization
immediately before returning. History authors and journal rows confer no authority.
Errors remain errors; cancellation belongs to the caller's Effect fiber. The public
composition seam is `LodyOptions.authorizeEncryptedExecution`. This change supplies
no production authorization implementation: absent injection returns denied. Wiring
a verified device/freshness implementation remains necessary for encrypted starts.

The execution key is `(genesis, workspaceId, targetMachineId,
agent-start:<userTurnId>)`. Its immutable bytes encode only the intent version,
session, turn and requester user. Transport request IDs and signed/encrypted frames
retain independent journal records; they must not become business execution IDs.
The first received execution deadline survives reauthorization and clock rollback;
a shorter replacement deadline is denied. An identical completed request does not
run again; already terminal history is preserved. Stale pending history receives a
visible refusal. A retained start without confirmed completion displays "Result
unknown" and is never taken over.

## Ownership, cancellation and failure containment

- Trigger/owner: each encrypted Lody workspace lazily owns one journal instance under
  its signing-key-scoped content directory. SessionExecutionService's existing turn
  fiber owns authorization, claim, raw ACP work and cleanup. Ordinary workspaces
  install no gate and open no execution database.
- Cancellation/handoff: cancellation before claim leaves no start evidence. After
  claim, even cancellation before prompt leaves conservative uncertainty. Existing
  ACP drain and session release ownership remain intact. A disconnected encrypted
  submission cannot use ordinary stale-connection replay: no output does not prove
  non-consumption. The ordinary recovery behavior remains covered by its suite.
- Failure/recovery: journal open/claim failure refuses only this workspace's turn;
  it does not block content startup, unrelated workspaces or ordinary dispatch.
  Each SQLite operation retains the existing zero busy timeout. Missing main files
  with retained control evidence are errors, never silently provisioned replacements.
  Explicit reset retains retired execution keys; a new user turn has a new key.
- Completion: after the turn body settles, a small fixed settlement marker is
  persisted. It is not an encrypted response or proof of business success. A failed
  finish write logs through the owning turn's observed warning boundary and leaves
  the start uncertain; it never reruns the business action or blocks independent
  release. Existing journal exact-outcome retries remain available.

The new gate composes native Effects in the existing turn fiber and adapts only
the synchronous SQLite leaf. It does not launch nested runtimes or introduce an
in-flight registry, timer, global failure cache, network wait, or dependency on a
realtime connection. Full Session/Repo/MessageHandler migration remains deferred
because those Promise dependencies are unchanged; this is not a migration-completion
claim. Local journal writes are required correctness work; this change does not
claim a measured end-to-end latency improvement.

## Evidence and limits

The execution-service regression was RED before consumer wiring: two independent
service instances submitted the same turn twice. It became GREEN after wiring the
shared SQLite gate. Synthetic tests cover overlapping RPC and prepared durable
execution, reopened completed and uncertain journals, denied/expired durable create,
disconnected submission without retry, corrupted-workspace isolation, ordinary and
healthy-workspace execution, exact intent binding, cancellation before admission,
backwards clocks, failed completion writes, missing used journals and explicit reset.
Composition tests verify lazy journal access, default deny and ordinary-path absence.
The existing journal and dispatch suites also remain part of local validation.

These tests use real SQLite, injected time and explicit synchronization signals;
they do not assert a throughput threshold or real encrypted network delivery.
Authorization provenance and freshness are independently supplied and are not proven
by the journal or these injected-authorizer tests.
