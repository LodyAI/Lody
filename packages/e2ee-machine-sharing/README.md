# Native encrypted machine sharing

The desktop and CLI hosts share one policy workflow. Cryptography belongs to
`e2ee-core`; device-authenticated DTOs belong to `cloud-api`; renderer methods
belong to `platform`. This package never constructs a cloud SDK client.

```text
Desktop owner intent → validate current personal ownership
  → authenticate latest ledger/head and consecutive history
  → apply complete machine/project switches
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
clears the old policy before I/O; known withdrawal, issuer revocation, rollback,
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

Owner re-signing may read an authenticated historical body after its signer was
revoked. It preserves the complete project list and signs a new explicit intent
with a current personal device; that historical body never supplies execution
evidence or advances an accepted pin. Policy history verification is bounded to
4096 consecutive versions per read and the same freshness interval. Purged gaps
without a retained original cannot be skipped; policy-dependent work fails closed.

The CLI's retained identity remains machine-only, so it can consume policy but
cannot impersonate a personal owner to publish a change. Its host write method
returns the ownership refusal for that identity. The desktop exposes only
`readMachineSharing` (returns generation) and `updateMachineSharing` (requires that
generation before requestId/change); stale window intents cannot enable a new
generation. Reads also return current personal-owner authority, the verified
signer and whether the complete historical policy needs re-signing. Historical
state remains separate from execution credentials; only an active verified policy
can advance accepted pins. No signing or private-key IPC is introduced. Proxy
dispatch retains the existing two-actor access intersection;
entries without authenticated actor evidence remain closed.

Decision: [owner-signed policy](../../.agents/notes/proposed/architecture/2026-10-28-e2ee-machine-sharing.md).
Synthetic crypto/SQLite tests and production assembly regressions establish host
behavior, not a deployed backend or two-device product acceptance.

`inspectCache(machineId)` is passive RAM evidence for diagnostics. It counts
retained policies and team-enabled policy objects for that machine only, without
opening a lazy owner, reading a clock, touching storage/network or renewing any
stamp. Counts are not current authorization: an expired/revoked policy object may
still be retained until a real operation invalidates it. `authorize` remains the
only execution decision, with all existing freshness and ledger checks.
