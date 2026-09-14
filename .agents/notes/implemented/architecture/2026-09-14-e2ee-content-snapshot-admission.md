# Content snapshot host admission (independent-package port)

Status: implemented
Translation: current

[中文](./2026-09-14-e2ee-content-snapshot-admission.zh.md)

## Abstract

Publication permission for a content snapshot is host admission at submit time, not successful decryption, a transport offset, an old head, a self-declared timestamp, or `verified=true`. On 2026-09-14 Zixuan agreed: check current device document-write and bind the authenticated submitting device to the signing device; keep the worst 15-minute authorization window; preserve content identity so different bytes cannot occupy an admitted offset, while exact retries may be idempotent; clients still verify signatures and Org/document/epoch/purpose/offset, and legitimate history remains usable after later revoke. This trusts host enforcement, does not resist a malicious host colluding with a revoked device, and does not add a receipt. The independent package now ships `createContentSnapshotPublication` and a fail-closed test host. Production JWT/gateway wiring remains unimplemented.

## Decision and scope

Submit-time authorization is separate from read-time historical `open`. `mayWriteDocument` only constrains honest `seal`. In one local exclusive operation the host verifies the signature without decrypting, requires submitting device === signing device, checks current document-write, applies the original lease deadline on an injected clock, and stores exact `(offset → body)` bytes. The original lease is copied before any await and rechecked after async verify and the current-write check, immediately before store; it is not restarted. `now == expires` is expired. Same offset and bytes are idempotent without moving the current pointer backward; same offset and different bytes are rejected; a numerically greater offset may become current; an earlier offset is rejected. No cross-stream transaction. The test peer returns 403 on snapshot PUT until an admission port is supplied.

This does not change ledger snapshot `7d8d553`, incremental update_batch encryption, permission-ledger endorsement, or production Convex/gateway wiring.

## Evidence and alternatives

Treating host-returned bytes plus offset as admission evidence was an unapproved implementer statement and is withdrawn. Re-checking current `deviceMayWriteDocument` on `open` would break legitimate history after revoke. A cryptographic receipt was not approved and is not required under host-honesty.

Tests: `test/snapshot-admission.test.ts` (guest/stranger/device mismatch/expired and delayed leases/lease expiring during real verify must not publish/revoke during verify/queued mutation cannot extend the original deadline/replacement/idempotency/revoked new publication vs historical open/fail-closed without a port/verify failure does not advance the cursor) and C1 encrypted snapshot bootstrap with admission headers. Production JWT cutoff is not verified. Independent review of `baea079` showed a P1: advancing the clock to `expires` inside `authenticate` still accepted; the lease must not be checked only before `authenticate`.

## Recovery-device correction (2026-09-14)

Whitepaper comparison exposed that `deviceMayWriteDocument` accepted recovery devices of non-Guest members. It now explicitly allows only personal/machine kinds. A real signed ledger enrolls R; the regression bypasses honest-client seal policy and checks that host admission rejects R without storing a snapshot. This restores existing intent, not a new trust protocol. Stage regression: 93 tests passed; package typecheck passed. Production integration and independent review of this working-tree fix remain separate.

## Durable storage follow-up (2026-09-15)

Stage 2 replaces the original process-local map authority with an injected synchronous transaction port and Node-only SQLite backend. Unlike the initial implementation above, async signature verification occurs outside the database lock. Admission re-reads persisted identity/current and checks current write plus the unchanged lease after acquiring the lock; insertion of ciphertext/identity and advancement of current commit together. Explicit create/open prevents missing or foreign storage being silently treated as fresh. Exact retries survive restart and do not regress current. Tests exercise real process death before/after commit, process competition, an injected SQL failure between identity and pointer, rollback and expired handles, historical decryption after revoke, and lease expiry at transaction acquisition. This is not production Streams/JWT wiring or a distributed storage protocol.

## Main-branch merge (2026-09-15)

Merged public main `99e63b0694d5f67eab62bd1dc7df7d548f074b27` into the E2EE line based on `2dd3307d`. The core package source is unchanged. Conflicts preserve E2EE recovery operations/copy alongside main's prompt-shortcut and sharing operations/copy; Electron runs both existing E2EE tests and main's new window-runtime/notification tests. pnpm regenerated the lock with the shared SDK catalog kept at 1.3.0. Combined Electron instructions exceeded the size gate, so service rules moved intact to a scoped AGENTS file with caller routing. Merged dependency validation: whole-repository typecheck passed, core 382 tests and Electron 119 main + 4 renderer tests passed; docs and public boundary passed. Full `pnpm check` stops at 9 pre-existing lint errors in unchanged core benchmark/model test files; uncommitted fixes from the source workspace were deliberately excluded. This merge does not enable E2EE or remove the unpublished streams-crdt continuation-offset dependency.
