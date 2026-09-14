# Content snapshot host admission (independent-package port)

Status: implemented
Translation: current

[中文](./2026-09-14-e2ee-content-snapshot-admission.zh.md)

## Abstract

Publication permission for a content snapshot is host admission at submit time, not successful decryption, a transport offset, an old head, a self-declared timestamp, or `verified=true`. On 2026-09-14 Zixuan agreed: check current device document-write and bind the authenticated submitting device to the signing device; keep the worst 15-minute authorization window; preserve content identity so different bytes cannot occupy an admitted offset, while exact retries may be idempotent; clients still verify signatures and Org/document/epoch/purpose/offset, and legitimate history remains usable after later revoke. This trusts host enforcement, does not resist a malicious host colluding with a revoked device, and does not add a receipt. The independent package now ships `createContentSnapshotPublication` and a fail-closed test host. Production JWT/gateway wiring remains unimplemented.

## Decision and scope

Submit-time authorization is separate from read-time historical `open`. `mayWriteDocument` only constrains honest `seal`. In one local exclusive operation the host verifies the signature without decrypting, requires submitting device === signing device, checks current document-write, applies the original lease deadline on an injected clock, and stores exact `(offset → body)` bytes. Same offset and bytes are idempotent without moving the current pointer backward; same offset and different bytes are rejected; a numerically greater offset may become current; an earlier offset is rejected. No cross-stream transaction. The test peer returns 403 on snapshot PUT until an admission port is supplied.

This does not change ledger snapshot `7d8d553`, incremental update_batch encryption, permission-ledger endorsement, or production Convex/gateway wiring.

## Evidence and alternatives

Treating host-returned bytes plus offset as admission evidence was an unapproved implementer statement and is withdrawn. Re-checking current `deviceMayWriteDocument` on `open` would break legitimate history after revoke. A cryptographic receipt was not approved and is not required under host-honesty.

Tests: `test/snapshot-admission.test.ts` (guest/stranger/device mismatch/expired and delayed leases/replacement/idempotency/revoked new publication vs historical open/fail-closed without a port/verify failure does not advance the cursor) and C1 encrypted snapshot bootstrap with admission headers. Production JWT cutoff is not verified.
