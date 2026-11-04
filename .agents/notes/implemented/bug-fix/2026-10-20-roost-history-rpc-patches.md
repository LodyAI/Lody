# Roost history RPC content patches

Status: implemented
Type: bug-fix
PR: https://github.com/LodyAI/Lody/pull/1765
Translation: current
Date: 2026-10-20

[中文](2026-10-20-roost-history-rpc-patches.zh.md)

## Abstract

Roost history watches identify changed turns but repeatedly return their complete accumulated bodies. Add an independently negotiated read capability that reuses verified native update intervals for ordinary streaming edits. The renderer applies patches to the exact cached checkpoint and commits repaired bodies and the next checkpoint atomically. Structural changes, sealed/state/permission changes, unavailable evidence and older peers keep the existing complete-body read path. The database format, signed history, receipt retention and Roost package remain unchanged.

## Decision and boundaries

- Derive bounded logical content operations from the existing native event/update journals only after the renderer checkpoint chain is verified. Do not introduce another persisted patch journal or a server-side history replica.
- Optimize non-structural edits whose complete interval belongs to current unsealed primary messages without state/permission overlays. Creation, seal, generation changes and other physical records retain complete logical projection. An incomplete native interval never produces a patch.
- Negotiate `sessionHistoryPatches` separately. Old requests receive their existing response shape; new clients omit the request flag for old daemons. Preserve owner encryption, readiness, existing supersession checks and read permits.
- Patches name their base checkpoint. [Cache binding and old-tab isolation](2026-10-21-roost-cache-checkpoint-body-binding.md) ensure it certifies the retained bodies. Prepare them on detached cached bodies before the existing atomic membership/body/checkpoint cache transaction. Missing or unusable bases recover through checkpoint-protected complete reads.
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

Test correction (2026-10-22): a lost native reply can leave an already parked
watch without a wakeup, so recovery uses its bounded timeout. The two-replica
fixture explicitly fires both parked watch timeout callbacks after the injected
reply loss. Freezing those callbacks while advancing only refresh timers made
the test depend on whether native I/O had already released a watch. This keeps
production timing unchanged and avoids expiring unrelated RPC deadlines.

Test correction (2026-10-23, [PR #1812](https://github.com/LodyAI/Lody/pull/1812)):
the two-replica fixture now drives live recovery callbacks directly, removing
them when canceled or fired. Vitest can place a nested zero-delay timer at fake
`now + 1`; advancing by its requested delay of zero can consume the wake signal
without running the callback. The fixture uses explicit completion signals for
both initial parked watches and final replica contents, without advancing global
time or expiring unrelated RPC deadlines. Parked watch timeout callbacks retain
the same cancellation and once-only guards. This replaces the delay queue while
preserving real Native SQLite, encrypted RPC, lost-reply injection and reopen
assertions; production timers and test timeout limits are unchanged. Watch readiness is asserted
before the write; afterward only still-live watches need expiry because native
recovery may already have awakened them. A temporary controlled experiment that
placed zero-delay timers one fake millisecond later timed out with the old driver
and passed with the new driver; this isolates the scheduling defect, not the
exact interleaving of the original CI failure.

Test correction (2026-10-24): the recovery driver also runs the 1,000 ms second retry. A deterministic case drops two consecutive watch-read replies for each renderer after the lost native commit reply, then checks identical contents and durable reopen. The old driver freezes at the second retry and times out; the corrected driver completes. Keep the driven delay set limited to this scenario: longer delays overlap RPC deadlines. Production timing and test timeout limits remain unchanged. This reproduces the missing retry-driver coverage, not the exact interleaving of the intermittent full-suite timeout.

The production Native SQLite and owner RPC test keeps a 352 KiB synthetic tool result unchanged while editing text 32 times. Every patched result equals the complete-body response, including Unicode scalar edits; total response JSON stays below 2% of the complete-body path. This measures streaming transfer, not database size or end-to-end latency.

Production encrypted RPC tests run patch-capable and legacy readers against the same owner and verify identical text/tool output, checkpoint watches, lost-native-reply recovery and durable reopen. The frontend bridge uses the real IndexedDB cache to verify exact-base application, stale-base and invalid-path protected repair, failed repair without checkpoint advancement, and reopen. Coalesced native edits survive reopen; seals, state corrections and removal of the projection-defaulted `fileDiff` field use complete reads. Shared tests cover safe JSON keys, detached failure, immutable identity and negotiation.

The fast path requires a complete, contiguous interval of at most 256 native edits and 4 MiB of exported frames, with one unsealed primary and no successor segments or state/permission overlays for each changed message. It intentionally retains complete reads for other intervals; it does not reduce persisted history or receipt storage.

Repository-wide checks are recorded in the PR. This complements [checkpoint recovery](2026-10-16-roost-incremental-history.md) without changing its consistency contract.
