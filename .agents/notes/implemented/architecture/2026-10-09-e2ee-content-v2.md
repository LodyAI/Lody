# Compact content packets with independent trusted context

Status: implemented
Translation: current

[中文](./2026-10-09-e2ee-content-v2.zh.md)

## Abstract

The experimental content frame repeated JSON/hex context and claimed author fields in every encrypted batch. Zixuan authorized replacing it with binary v2: version, epoch, signing public key, nonce, sealed bytes and signature, with independent trusted context bound into derivation, AEAD and signing. Measured fixed inner overhead is 141 bytes; the synthetic single-update SDK request body shrank from 577 to 244 bytes (297 before the AAD optimization). Verified replay recovers original authors after revocation, while snapshot-only readers explicitly retain device-only attribution where history is missing. This is a breaking experimental content-format change, with no production activation or automatic old-data migration.

## Decision and responsibilities

The [bilingual content spec](../../../../specs/e2ee-content.md) owns the exact bytes, bounds, purpose codes and cryptographic domains. This decision partially replaces the frame/context descriptions behind the [content snapshot decision](../feature/2026-09-14-e2ee-content-snapshot.md) and [snapshot admission decision](./2026-09-14-e2ee-content-snapshot-admission.md); their offset, lease, persistence and publication contracts remain binding. The [Effect migration](./2026-10-09-e2ee-effect-v4.md) boundary remains unchanged.

The codec carries no Org/resource/purpose, user, member-instance or messageId. Nonce randomness remains; the old messageId had no durable replay store. Context uses raw genesis, u32be epoch, length-prefixed printable ASCII logical resource and a purpose byte. Separate versioned domains protect key derivation, AEAD AAD and signature input. The signer public key is a verified-Org lookup candidate, never authority by possession. Host authentication now requires explicit expected scope; the SDK passes original AAD externally to AEAD and signing, while retaining snapshot continuationOffset inside encrypted plaintext and returns the original payload bytes.

The historical identity index belongs to privately retained verified replay state. It is cloned with that state and survives member/device removal. Genesis and subsequent verified enrollments populate it; restoring full records rebuilds it. Snapshot import only recovers its active-device mappings. A historical admitted key without a mapping returns `device-only/missing-history-context`; it is never assigned to a later membership. No ledger or snapshot wire field was added. Current publication permission remains separate: Guest/R cannot write, rotation blocks honest new sealing, and async crypto still rechecks authority.

Derived keys now use Effect resource finalizers. A regression with typed signing failure showed that generator `finally` did not erase the key. Tests inspect owned buffers after success, failure/retry and explicit fiber interruption; per-execution epoch/plaintext copies are also cleared. Immutable captured input permits repetition/concurrency. Hidden runtime/WebCrypto copies are outside this erasure claim.

## Measured encoding

The [measurement program](../../../../packages/e2ee-core/bench/content-packet-size.ts) uses real Loro exports, a real SDK encoder/reader and real cryptography. It captures POST body bytes through an injected fetch and verifies the restored document. It also seals the same batch directly to separate inner overhead from SDK wrapping. These are encoded lengths, not observed network traffic.

| Updates in one batch | Raw updates | Encoded batch | v1 inner | v2 inner | v1 SDK body | v2 SDK body |
| -------------------- | ----------: | ------------: | -------: | -------: | ----------: | ----------: |
| 1                    |          84 |            88 |      509 |      229 |         577 |         297 |
| 5                    |         424 |           444 |      865 |      585 |         933 |         653 |

All sizes are bytes. The fixture uses a 64-hex-character user, 32-character member instance, 64-character device and `doc-1` resource. v1 overhead is 421B for this fixture; v2 is exactly 141B for both batches. SDK AAD is 51B here. No operation-level envelope was introduced.

Reproduce with the pnpm version in the root manifest. Create a pristine v1 package from tracked `35bfca7e` using `git archive` into a separate temporary directory; use its package dependencies without copying dirty source. Then run:

```sh
pnpm --filter @lody/e2ee-core exec node --import tsx bench/content-packet-size.ts /path/to/pristine-v1/packages/e2ee-core/src
```

Without the optional path, the program measures only v2. The old source is not a second implementation shipped with v2.

## External SDK AAD optimization

Zixuan retained the full public key and 64B Ed25519 signature and authorized removing
only the duplicate SDK AAD from encrypted plaintext. A 2B length and 51B AAD copy
were removed per batch. Nonempty external binding uses length-prefixed distinct
`aad-bound/v2` and `signature-bound/v2` domains; generic unbound v2 is unchanged.
Provider header 3/4 distinguishes this revision from the rejected former 1/2
without adding a byte. Snapshot offsets retain their original encrypted framing.
Hosts reconstruct exact SDK AAD from validated LSCE headers before independent
signature checking; the Lab insider reader also supplies that binding.

| Updates | Batch | SDK body before AAD optimization | SDK body after | Saved |
| ------- | ----: | -------------------------------: | -------------: | ----: |
| 1       |    88 |                              297 |            244 |    53 |
| 5       |   444 |                              653 |            600 |    53 |

These are real SDK/crypto roundtrip measurements of POST body lengths, excluding
HTTP/TLS. Total update-body overhead outside the batch falls from 209B to 156B;
inner overhead remains 141B. The previous table records the first v2 implementation.
The benchmark accepts an optional third argument to label a pre-optimization
source snapshot (default baseline label remains v1). Retained old v2 SDK streams
need their exact old reader; use new streams/directories for this binding revision.
No silent fallback, deviceRef, signature/nonce reduction or batching-policy change.

AAD follow-up acceptance: 68 core and 77 Lab tests passed, covering external AAD
mutation/missing-data rejection, a legitimate re-sign failing AEAD under replacement
AAD, mutable input capture and concurrent/repeated Effects, host AAD reconstruction,
old-provider rejection, real HTTP snapshots, and process crash recovery. Typechecks,
complete Effect-boundary and changed-file format/lint checks are recorded separately
from the earlier full-suite results below. This scoped follow-up did not rerun the
known failing full workspace or activate a production consumer.

## Compatibility choice

New readers reject v1 and unknown versions. A dual reader was not selected: this package is private/experimental, product content activation is absent, and no persisted content fixture was found in the inspected checkouts. That does not prove absence of external Lab `--data-dir` directories or repro packs. Retain those with a pinned old reader and start v2 work in a new directory. Explicit migration must verify/decrypt old bytes against independent scope, preserve signed originals, and publish a separate new snapshot as its actual producer. There is no silent downgrade or rewriting of another producer's signature meaning.

The optional legacy content-frame history helper follows v2. Ledger records, epoch envelopes, independent 72B history packets and delivery/receipt protocols are unchanged. Generic blob/presence/RPC purposes have codec and cross-purpose coverage; full product consumers and production gateway enforcement remain unimplemented.

## Verification and limits

- Core full suite: 548 passed, 7 failed, 1 skipped. Each remaining failure was reproduced at pristine `35bfca7e`: reflective construction of an unverified ledger view; 4096-envelope ingress bound; sender outbox cleanup; interrupted rotator recovery; injected signature-verifier authority; impossible endorsed snapshot state; journal endorser substitution. These are existing trust/recovery defects, not evidence of production readiness. The former revoked-device self-claimed-author test now derives original verified identity and passes.
- Lab full suite: 182 passed, 3 failed. Two failures also reproduce at `35bfca7e`: duplicate committed-record handling and cursor rollback. The third uses a real remote model and failed its assertion that an attack actually took effect; deterministic collaboration, exact replay, host lifecycle, content authority and persistence suites passed. This model-dependent run is not a deterministic acceptance proof and was not retried to obtain a green result.
- Behavior covered: all packet component tampering, cross-Org/document/purpose including re-signed ciphertext, wrong/missing keys, strict length/version/u32 bounds, Guest/R new-write rejection, revoked history, rejoining memberships, snapshot-only attribution, SDK update/snapshot roundtrips and offset substitution, repeat/concurrent/retry execution, interruption cleanup, and failed document persistence retaining its cursor.
- Core HTTP snapshots use the existing `LORO_STREAMS_CRDT` override to the sibling source SDK, because published 0.15.1 lacks continuationOffset. Lab retains its existing vendored SDK. No manifest/lockfile change or claim of published-SDK snapshot compatibility.
- Final focused acceptance: 71/71 passed, including real local HTTP snapshot/update checks after the purpose-binding change. Package typechecks, complete Effect-boundary check, changed-file format and type-aware lint passed (lint has warnings, no errors). Root public-boundary checking cannot resolve uninitialized ACP submodule workspace packages; docs check reports 20 links into the same missing submodules, with no errors in the changed documents. Their manifests and dependency edges were not changed. No protected topics were registered; no SHA review record or Spec approval is fabricated.

No PR, commit, production deployment, formal security proof or exhaustive external-data inventory was performed. The continuous implementation branch starts at `35bfca7e`; the source checkout's uncommitted work and other session's key-mailbox protocol remain untouched.
