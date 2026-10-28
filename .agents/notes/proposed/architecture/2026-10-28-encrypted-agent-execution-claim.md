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
retry; production authorization uses the same workspace host, with an optional
injected override and fail-closed behavior when the capability is absent.
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
                                                  verify original turn signer
                                                  authorize(workspace, device)
                                                  journal claim(userTurnId)
                                                  agent creation/restore/prompt
                                                  retain settlement
```

`LodyOptions.authorizeEncryptedExecution` now has the same call/result shape as
`host.authorizeExecution` in [#1991](https://github.com/LodyAI/Lody/pull/1991):

```ts
type AuthorizeEncryptedExecution = (
  workspaceId: string,
  requesterDevice: string // verified signing public key, lowercase hex
) => Effect.Effect<
  { readonly _tag: 'Authorized' } | { readonly _tag: 'Denied'; readonly reason: string },
  unknown
>;
```

The production turn origin resolver is supplied by the encrypted workspace host,
not by history author fields. The Streams binding exposes `openAuthenticated`,
returning historical device/member identity only after signature and AEAD checks;
its SDK-facing `open` still returns plaintext alone. For Loro updates, the host
retains original ciphertext/AAD and signed operation ranges in a workspace-local
`execution-origins.sqlite`. At dispatch it reopens and verifies that original,
forks the local document at the update's dependencies, imports the **exact signed
update bytes**, and matches the selected turn's creation operation, timestamp,
input configuration and items. It also matches the frozen invocation configuration
and checks the live projection again after asynchronous verification. An operation
number alone is not proof: another valid frame can reuse its peer/counter with
different operations, so inspecting the live document at matching counters is unsafe.

Execution identity is the verified signing device and its ledger actor, returned
as `requesterCryptoUserId`. The native `host.authorizeExecution` resolves that
device in the current verified ledger and checks its membership, role and
revocation state. The original signature and current authority remain separate
checks. UI `requesterUserId`/turn account IDs are display metadata and are never
compared with the crypto actor, used to select authority, or bound into new
execution claim evidence. Display-field edits do not change execution input.
Older execution evidence containing an account field still matches by session and
turn without rewriting its exact bytes or permitting another start. The machine
adds no account directory query or inferred account-to-crypto mapping. Encrypted
watcher dispatch bypasses ordinary account visibility/catalog admission and does
not read or publish account-based authority snapshots; it still must pass the
execution service's verified-device gate. Ordinary workspace admission is unchanged.
Thus revoking one device denies its pending turns even while its user and another
device stay active. Missing originals, conflicting signer attestations and modified execution input
prevent a new start. A snapshot signer never becomes the origin of every old turn
inside that snapshot. A snapshot-only turn triggers a backward read of retained
Streams updates using
this workspace's device credential. The host decodes released update framing,
reconstructs exact logical-room AAD, reopens the original signature/AEAD and retains
its ciphertext before resolving the turn. The snapshot signer never supplies the
turn's origin. Local receipt hits do no backfill I/O.

Missing originals remain pending without a journal start, failure marker, handled
pointer or completed Inbox input. The watcher reuses its per-session admission
retry owner, with a one-second delay; stop, unwatch and ownership changes cancel
that owner. Each backfill attempt is limited to eight backward pages and three
seconds of cooperative I/O, retaining only its scan continuation in memory.
Another attempt resumes an incomplete scan; a retained-start miss is not cached.
Expired snapshot turns stop retrying at their timestamp's original window, and a
recovered signature must still prove its own unchanged deadline before claiming.

For durable history, the original window ends 15 minutes after the authenticated
turn timestamp. Reopening proofs and refreshing the authorization cache do not
change it; the host's 15-minute ledger-read cache is independent. A fresh realtime
entry must supply equally verified origin/intent evidence through the same execution
boundary. Errors remain errors; cancellation belongs to the caller's Effect fiber.
Production `Lody.create` defaults to the same owned host's `authorizeExecution`;
`LodyOptions.authorizeEncryptedExecution` remains an optional compatible override.
A missing capability denies new starts; omitting the override uses native host
authorization rather than denying every encrypted turn.

The execution key is `(genesis, workspaceId, targetMachineId,
agent-start:<userTurnId>)`. Its immutable bytes encode only the intent version,
session and turn. Transport request IDs and signed/encrypted frames
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
  Origin receipt writes never block content sync on failure; a bounded diagnostic
  reports the episode, while missing/unreadable receipts refuse affected starts.
  Both stores use zero SQLite busy timeout. Missing main files
  with retained control evidence are errors, never silently provisioned replacements.
  Explicit reset retains retired execution keys; a new user turn has a new key.
- Completion: after the turn body settles, a small fixed settlement marker is
  persisted. It is not an encrypted response or proof of business success. A failed
  finish write logs through the owning turn's observed warning boundary and leaves
  the start uncertain; it never reruns the business action or blocks independent
  release. Existing journal exact-outcome retries remain available.

Origin receipts contain ciphertext and public operation ranges, never decrypted
prompts. They are authentication evidence, not another execution claim or authority
cache; the realtime journal remains the only durable execution gate. Each lookup
closes its SQLite handle; decrypted buffers and temporary Loro documents are released
before the turn can proceed. No proof pruning or snapshot-author substitution occurs.

The new gate composes native Effects in the existing turn fiber and adapts only
the synchronous SQLite leaf. It does not launch nested runtimes or introduce an
global failure cache or dependency on a realtime connection. Cold origin recovery
uses bounded network reads; normal retained-origin dispatch does not. The existing
watcher owns delayed admission retries. Full Session/Repo/MessageHandler migration remains deferred
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
Composition tests verify lazy journal access, missing-capability denial and ordinary-path absence.
The existing journal and dispatch suites also remain part of local validation.

These tests use real SQLite, injected time and explicit synchronization signals;
they do not assert a throughput threshold or real encrypted network delivery.
Real signed-ledger/content and SQLite tests additionally prove device attribution
through origin-store reopen, same-user device revocation, independent display accounts, payload
changes, signature rejection and same-peer/counter payload substitution. The device admission regression was RED under temporary removal of that check;
restoring it is GREEN. The real UI account and display-independent journal tests
were RED under the former account/crypto comparison and are now GREEN. The exact-payload provenance test also failed before the
signed update was imported into its dependency snapshot. A production-construction regression uses real custody, signed ledger/content,
SQLite, native authorization and the actual `Lody.create` composition without an
authorization callback or mock host. Synthetic cloud I/O supplies the signed
records; the ACP harness records prompt submission. It was RED with the absent
production adapter and GREEN after defaulting to the owned host. Native production regressions also reject updates signed before device revocation,
member downgrade to Guest or member removal, despite an otherwise valid display
account. Additional RED → GREEN regressions cover native construction from a verified
snapshot signed by another device, delayed original availability without terminal
writes, original expiry, the actual Streams HTTP backward parser, bounded aborted
reads and watcher stop cancellation. These tests do not claim deployment acceptance.
