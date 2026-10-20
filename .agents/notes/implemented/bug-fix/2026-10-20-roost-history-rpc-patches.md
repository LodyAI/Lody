# Roost history RPC content patches

Status: implemented
Type: bug-fix
Translation: current
Date: 2026-10-20

[中文](2026-10-20-roost-history-rpc-patches.zh.md)

## Abstract

Roost history watches identify changed turns but repeatedly return their complete accumulated bodies. Add an independently negotiated read capability that reuses verified native update intervals for ordinary streaming edits. The renderer applies patches to the exact cached checkpoint and commits repaired bodies and the next checkpoint atomically. Structural changes, sealed/state/permission changes, unavailable evidence and older peers keep the existing complete-body read path. The database format, signed history, receipt retention and Roost package remain unchanged.

## Decision and boundaries

- Derive bounded logical content operations from the existing native event/update journals only after the renderer checkpoint chain is verified. Do not introduce another persisted patch journal or a server-side history replica.
- Optimize non-structural edits whose complete interval belongs to current unsealed primary messages without state/permission overlays. Creation, seal, generation changes and other physical records retain complete logical projection. An incomplete native interval never produces a patch.
- Negotiate `sessionHistoryPatches` separately. Old requests receive their existing response shape; new clients omit the request flag for old daemons. Preserve owner encryption, readiness, existing supersession checks and read permits.
- Patches name their base checkpoint. Prepare them on detached cached bodies before the existing atomic membership/body/checkpoint cache transaction. Missing or unusable bases recover through checkpoint-protected complete reads.
- Preserve scalar Unicode offsets, field removal, array splices and unknown stored fields. Keep immutable logical identity and reject malformed paths without partially changing the cache.
- Reuse the existing `readStable`/Worker ownership and read queues. This is read-only computation over an existing owner, not a lifecycle migration; no new Effect runtime, task owner or storage writer is needed.

```mermaid
flowchart LR
  Journal[Native events and updates] --> Verified[Verified checkpoint interval]
  Verified --> Patches[Logical content patches]
  Patches --> RPC[Owner-encrypted history RPC]
  RPC --> Cache[Atomic cached bodies and checkpoint]
  Verified --> Full[Complete-body read when ineligible]
  Full --> RPC
```

## Verification and limits

The production Native SQLite and owner RPC test keeps a 352 KiB synthetic tool result unchanged while editing text 32 times. Every patched result equals the complete-body response, including Unicode scalar edits; total response JSON stays below 2% of the complete-body path. This measures streaming transfer, not database size or end-to-end latency.

Production encrypted RPC tests run patch-capable and legacy readers against the same owner and verify identical text/tool output, checkpoint watches, lost-native-reply recovery and durable reopen. The frontend bridge uses the real IndexedDB cache to verify exact-base application, stale-base and invalid-path protected repair, failed repair without checkpoint advancement, and reopen. Coalesced native edits survive reopen; seals, state corrections and removal of the projection-defaulted `fileDiff` field use complete reads. Shared tests cover safe JSON keys, detached failure, immutable identity and negotiation.

The fast path requires a complete, contiguous interval of at most 256 native edits and 4 MiB of exported frames, with one unsealed primary and no successor segments or state/permission overlays for each changed message. It intentionally retains complete reads for other intervals; it does not reduce persisted history or receipt storage.

Repository-wide checks are recorded in the PR. This complements [checkpoint recovery](2026-10-16-roost-incremental-history.md) without changing its consistency contract.
