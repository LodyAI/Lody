# Encrypted ephemeral workspace presence

Status: proposed
Translation: current

[中文](2026-10-28-encrypted-ephemeral-presence.zh.md)

## Abstract

Encrypted workspaces currently suppress cloud liveness because the ordinary presence
channel would expose machine and session state. This change protects the existing
small liveness DTOs with signed purpose-7 ciphertext on the same ephemeral SDK
channel, while leaving durable documents and ordinary workspaces independent.
The host checks current device membership, workspace/room, machine/viewer identity,
validity and bounded replay floors; invalid presence is discarded locally.
The body codec is adopted from merged [#1990](https://github.com/LodyAI/Lody/pull/1990)
(`c7b3c715`) through main. No deployed or installed-product acceptance is claimed;
real gateway and installed two-device checks remain outstanding. Implementation:
[draft #1994](https://github.com/LodyAI/Lody/pull/1994).

## Responsibilities and trade-offs

```text
local liveness -> bounded/coalesced crypto bridge -> host purpose-7 signing
              -> existing ephemeral POST/SSE -> host authentication/admission
              -> expiring presence projection
protected documents -------------------------> independent durable SDK transport
```

- Core's `makePresenceContentBinding` delegates authority to a genuine continuing
  ledger, checks current non-Guest personal/machine permission around crypto,
  verifies signatures before key lookup, checks epoch commitments and disposes
  owned keys/plaintext. The open callback cannot retain borrowed plaintext.
- The server materializes a Loro `EphemeralStore`, so a bare purpose-7 frame is
  not a transport update. A stable random 128-bit outer key carries a binary
  ciphertext value in `EphemeralStore.encode(key)`. No machine/session key or
  plaintext DTO appears in the outer wrapper. Readers decode materialized
  bootstrap/live updates and authenticate every candidate ciphertext separately;
  outer values and deletions never establish author or removal authority.
- The RPC host entry consumes the body codec rather than copying its format.
  It independently pins `presence:<workspaceId>` and genesis. Machine/session state
  must match a current machine device; personal viewing derives the crypto user ID
  from the verified member, not the caller's cloud user label. These IDs are display
  references, not a new identity directory.
- A body retains its original issue time and expires no later than 60 seconds after
  it. Future, expired, malformed, wrong-purpose/scope, forged and unauthorized
  frames fail closed. A newer sequence/issue floor prevents tombstone resurrection,
  including a retired incarnation. Floors are in memory, scoped to the live receiver;
  a genuinely new receiver can bootstrap still-valid ephemeral state. There is no
  persistent presence history or execution/deduplication journal.
- Each receiver retains at most 4096 logical-key floors until their authenticated
  expiry; capacity drops new keys rather than evicting live replay protection.
  Native windows use independent weak contexts supplied by main, never renderer IDs.
- The crypto bridge has at most 128 distinct pending keys, coalesces same-key state,
  prioritizes heartbeats and emits at most four frames/second. Liveness JSON is at
  most 4096 bytes, plus 41 body bytes and 143 content bytes. Expired queued state is
  dropped. Crypto failure retries only at a later heartbeat/transition. The existing
  SDK remains the sole POST/SSE queue, retaining original ciphertext for its retries.
- Authenticated expiry reaches existing freshness readers and a store timer. Verified
  ledger changes clear cached remote receipts and fence late projections, while
  preserving local-origin state. Ordinary presence retains its original transport,
  room, auth, 90-second TTL and payloads. Native capability status gates the UI notice.
  A renderer retains only unexpired authenticated receipts across store replacement,
  so a host's correct replay rejection cannot erase the receiver's last known state.
  Signed clear, verified invalidation, expiry and terminal runtime disposal remove
  those receipts; a terminal dispose also releases its invalidation subscription.

## Failure containment and Effect boundary

Malformed outer/inner frames, bad signatures and unauthorized senders are discarded
without poisoning remote intake. Local key/retained-publication/ledger unavailability
is a distinct outcome: SDK `joined` remains network status, while native readiness
and UI liveness stay unknown. Missing machines then cannot trigger `MACHINE_OFFLINE`.
The bridge retains at most 4096 unavailable originals within the workspace lifetime,
retries on key/ledger invalidation or fresh updates of the same outer key, and
restores availability only after authenticated state succeeds with no unresolved
failures. Key availability alone preserves already authenticated receipts; only
ledger invalidation retires their authority. Bad frames cannot clear a prior
unavailable-key marker. Document crypto
remains independent. Desktop presence borrows
the workspace under the short admission lock, then performs crypto outside that lock;
a paused presence key read cannot hold document admission. Encrypted ephemeral
attach failure is observed as a bounded warning and cannot roll back durable
attachment. No workspace readiness gate or global retry loop is added.

The existing native CLI workspace/generation owns the SDK and tokens. Its Legacy
facade acquires the shared Promise adaptor bridge and registers actual cleanup in
that generation Scope. Retirement fences publication/import synchronously, cancels
timers, then joins admitted raw crypto before store destruction. Native failed
release owners remain retained by the existing registry. Renderer transports use
the same retirement order. Core crypto and its admission/drain remain native Effect.
A separate full native rewrite of the cross-runtime SDK callback bridge is deferred;
the current Promise SDK/renderer callbacks remain its consumers. This does not
reclassify the native presence owner or claim a completed upper-runtime migration.

Keeping presence disabled was safe but withheld current liveness. Sending encrypted
state through durable documents would mix disposable status with persistence and
recovery. Reusing the ephemeral channel preserves those separate failure budgets.
This partially supersedes only the presence restriction in the
[document integration note](2026-10-22-e2ee-m2-product-integration.md).

## Evidence and limits

Deterministic tests use synthetic real ledgers/signatures/keys, injected time and
fake timers. They cover ciphertext-only publication, expiry boundaries, cross-scope
and forged frames, revocation during signing, sequence/incarnation replay, bounded
publication, no remote echo, late crypto retirement, ledger invalidation and an
independently usable document after bad presence. The native desktop fixture uses
synthetic authenticated custody with real crypto/SQLite, not a user's keychain.
Temporarily removing expiry and replay gates makes three boundary cases fail;
restoring them passes. A held native key read also proves document seal/open can
complete while presence remains pending. Real Loro server-style `apply` → `encodeAll` and real SDK bootstrap tests cover
late readers, store-replacing reconnects and unknown/recovery with unavailable keys.
Both original defects had failing tests before their fixes. Affected checks and
final revision are recorded in the draft PR. Real gateway
bootstrap/fanout, installed two-device operation, all-platform custody/packaging and
production delivery remain unverified. The public body profile remains reviewable separately; this note does not approve
a Spec or claim server deployment.
