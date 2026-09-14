# Content snapshots are distinct from ledger snapshot endorsement

Status: implemented
Translation: current

[中文](./2026-09-14-e2ee-content-snapshot.zh.md)

## Abstract

Document content snapshots reuse streams-crdt `PayloadProtectionProvider.seal/open` for both `update_batch` and `snapshot`. Any device with document-write permission (including machines) may sign them; guests may not. This is not permission-ledger endorsement. The host-admitted bootstrap continuation offset is the publication evidence under the existing 15-minute backend-trust cutoff; a later author revoke does not invalidate that admitted snapshot. No cross-stream transaction and no automatic ledger-history trimming.

## Decision and scope

streams-crdt passes an opaque `continuationOffset` only on snapshot seal/open. Update-batch context and envelope AAD are unchanged. Lody binds Org/genesis, resource, kind/model, epoch, and that offset inside the existing content frame. Open of an admitted snapshot does not require current write permission. Production gateway JWT cutoff remains unverified.

## Evidence and alternatives

Provider tests cover writer/guest, offset mismatch, tampering, missing epoch key, and device write lookup. C1 HTTP bootstrap roundtrip plus suffix uses a sibling `@loro-dev/streams-crdt` source when present (`LORO_STREAMS_CRDT` or `../../../loro-streams/packages/streams-crdt`). Catalog 0.15.1 does not pass the offset into snapshot encode/decode.
