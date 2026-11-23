# Native encrypted machine sharing

The desktop and CLI hosts share one policy workflow. Cryptography belongs to
`e2ee-core`; device-authenticated DTOs belong to `cloud-api`; renderer methods
belong to `platform`. This package never constructs a cloud SDK client.

```text
Desktop owner intent → validate current personal ownership
  → authenticate latest ledger/head and its current owner signature
  → apply complete machine/project switches and independent read-only session grants
  → retain requestId + exact ciphertext + full expected head
  → reconcile request → commit exact original under CAS

RPC or durable input → verify original requester → resolve actual execution project
  → fresh ledger → same member, or fresh verified owner policy
  → synchronous current-policy fence → existing actual-start journal claim
```

`makeLazyMachineSharingHost` defers the SQLite owner until policy-dependent work.
A failed policy store does not block content reads or same-member execution.
The workspace Scope owns each admitted operation and joins it before closing its
store; cancelling a waiter leaves the retained operation with that owner.
Atomic SQLite comparisons fence concurrent results without holding a lock over
network or cryptographic work. Failed opens can retry.

Every binding, policy original, request lookup, rollback pin and RAM cache includes
`generation`, qualified by core from local ledger admission originals. Atomic key
replacement preserves the initial admission key; removal/readmission creates a
new resource with no inherited grants or pending intent and starts at revision one.
A compact ledger uses a full local replay at its authenticated endpoint when
checkpoints are missing. Missing originals deny sharing only; same-member execution
continues without opening policy storage. No remote generation hint is trusted.

The store retains immutable request originals and resource-bound accepted heads.
Credentials, keys, decrypted policy bodies and freshness timestamps are not
persisted. `intent` retains the narrow local switch change for retry comparison.
An unknown result returns `pending`; retry the same generation, requestId and change. A
confirmed conflict stays terminal for that request and never rebases. Reads expose
the pending requestId and narrow change so a new window can reconcile it, including
when a latest-policy read is unavailable. `saved`
acknowledges the original intent, which a later policy may already have replaced.

Execution caches exist only in RAM. Wall and monotonic clocks both enforce a
strictly shorter than 15-minute interval from before ledger/head I/O. A fresh read
clears the old policy before I/O; known withdrawal, rollback,
fork or removal cannot fall back to an older grant. At actual start the caller
also checks the returned synchronous fence and the current ledger generation.
Every new start checks its actual localProjectId; the RPC receipt alone never
starts an agent. Withdrawal leaves already-started work running.

A fresh cached grant is reused without head I/O. Before refusing a cached
`machine-not-shared` or `project-not-shared` decision, authorization forces an
authenticated latest read and verifies the resulting policy. Per binding (including
generation), concurrent denial refreshes share one workspace-owned producer, with
at most one attempt per five seconds from read start. During that cooldown, callers
reuse the verified result; a failed attempt retains only its retry timestamp and
falls back to the existing pinned denial or unavailable outcome, never permission.
Invalidation clears this coordination together with the policy cache. This short
window bounds request traffic and newly granted access delay without changing the
15-minute revocation trade-off or the actual-start fence.

Desktop ledger ingest retires RAM policies only when the genuine verified view's
`(length, head hash)` changes. An unchanged page, replay or transport cursor does
not renew the policy's original freshness stamp or clear it. The optional
workspace-scoped `LedgerFeedInvalidation` port synchronously retires grants in the
same non-yielding segment that publishes the durably appended verified view.
Member/device/role and epoch changes all change this signed prefix. Machine
generation derives only from its verified admission/replacement records, so a new
generation cannot escape the same invalidation. Independent policy revisions and
observed withdrawals retain their existing resource-specific invalidation.

Each latest-policy read captures a RAM invalidation generation. A read that was
already in flight when ledger invalidation occurred cannot republish its policy
or revive its issued fence; it reports `sharing_unavailable` and a later operation
may retry. No lock or new wait spans ledger, network or crypto work. A malformed
input grants no authority; rejected history retains the existing workspace-close
fence. This does not change withdrawal semantics, TTL or UI polling frequency.

Policies are current-only v3; no v2 reader, writer or migration exists. Encrypted
workspaces have no production data requiring an upgrade path. Read only the latest
original, including on cold open and before writes. Verify its historically admitted owner-personal
signature, binding and generation; reject revisions below the local pin and differing
digests at the same revision. Revision gaps and missing intermediate originals are
allowed. `previousDigest` still participates in server CAS, never client chain traversal.

A service-accepted policy remains effective when its personal signer is revoked.
Historical ledger admission must bind that signer to the current owner's membership;
Guest/recovery/machine signers still fail. `needsResign` is a nonblocking reminder.
Another active owner-personal device can review/edit and re-sign the entire current
machine/project/session list without dropping grants. Publication still requires a
current eligible owner device; clients trust that backend commit-time admission
and latest-head delivery rather than claiming cryptographic evidence of signing time.

The CLI's retained identity remains machine-only, so it can consume policy but
cannot impersonate a personal owner to publish a change. Its host write method
returns the ownership refusal for that identity. The desktop exposes only
`readMachineSharing` (returns generation) and `updateMachineSharing` (requires that
generation before requestId/change); stale window intents cannot enable a new
generation. Reads also return current personal-owner authority, the verified
signer and whether the policy needs re-signing. Invalidated
state grants nothing; only an active verified policy
can advance accepted pins. No signing or private-key IPC is introduced. Proxy
dispatch retains the existing two-actor access intersection;
entries without authenticated actor evidence remain closed.

Decision: [owner-signed policy](../../.agents/notes/proposed/architecture/2026-10-28-e2ee-machine-sharing.md).
Synthetic crypto/SQLite tests and production assembly regressions establish host
behavior, not a deployed backend or two-device product acceptance.

`inspectCache(machineId)` is passive RAM evidence for diagnostics. It counts
retained policies and team-enabled policy objects for that machine only, without
opening a lazy owner, reading a clock, touching storage/network or renewing any
stamp. Counts are not current authorization: an expired/removed-generation policy object may
still be retained until a real operation invalidates it. `authorize` remains the
only execution decision, with all existing freshness and ledger checks.

Native exact-session history admission returns a view with a synchronous policy
fence. The fence binds that view's head and machine binding to the retained cache
object and its freshness. Unchanged cached reads preserve it; invalidation, a new
head, expiry or shutdown retires it. The CLI combines it with the ledger generation
and checks it across waits, reads, encryption and sending. This enables no new
history storage backend.
