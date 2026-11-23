# Retained verified ledger state for E2EE hosts and clients

Status: proposed
Translation: current

[中文](2026-10-19-e2ee-retained-ledger-state.zh.md)

PRs: [LodyAI/Lody#1625](https://github.com/LodyAI/Lody/pull/1625) (Spec), [loro-dev/lody#3794](https://github.com/loro-dev/lody/pull/3794) (first host consumer)

## Abstract

The private E2EE backend reads the whole permission ledger from Loro Streams and replays it from genesis on every history page, append, recovery and diagnosis. Measured full replay costs about 5.4 ms per record, so a 4,096-record ledger takes 22 s per call, and the backend caps ledgers at 4,096 records only to keep that replay inside one action. This note proposes a core entry that lets each party resume from its own previously verified state and verify only new records, plus a host cache that uses it. The retained state is trusted only by the party that produced it, so restoring it neither re-verifies signatures nor recomputes its digest; Streams rollback is still detected by requiring new records to chain from the retained head. Nothing here is implemented yet, and the size and completeness questions below remain open.

## Problem and evidence

- Measured on an idle 8-core host with `verifyLedger` from `packages/e2ee-core` over synthetic publish-epoch records: 1,024 records in 5.8 s, 4,096 in 22.1 s (about 5.4 ms each). `extendLedger` of one record on a held view: about 5.3 ms. The cost is signature verification plus permission replay, so it grows linearly.
- `loro-dev/lody#3794` calls `storage.read()` (full read plus full verification) in `history`, `appendRecord`, creation retries, `recoverWrite`, erasure and rescue diagnosis. Paging through 4,096 records means 64 full replays.
- `MAX_RECORDS = 4096` in the backend storage adapter is an audit budget, not a protocol limit. Real workspaces accumulate member, device and epoch records over years.
- Clients have the same shape: the control page re-verifies from genesis on each open, and the core SQLite stores revalidate all records on open.

## What core already provides

- A canonical, sorted CBOR encoding of the complete authorization state (`authState`, used by snapshot bodies), so one state has one byte form.
- `stateDigest = sha256("lody-e2ee/snapshot-digest/v2\0" ‖ body)` and comparison notes for cross-party fork detection.
- Incremental `extendLedger` on a held view.
- `verifyLedgerSnapshot`, which starts a view from a snapshot endorsed by an Owner/Admin personal device plus an externally confirmed position. It is designed for device joining.

What is missing is an entry for a party to persist and restore **its own** verified view. Core deliberately refuses to mint views from arbitrary bytes, and a server cannot endorse a snapshot because it is not a device.

## Proposal

See the Spec section [Retained verified state](../../../../specs/e2ee-foundations.md#retained-verified-state-proposed) for the contract. In short: `exportVerifiedState`/`restoreVerifiedState`; the digest is computed once at export and used for comparison and background audits; restore only decodes; continuation requires the first new record to reference the retained head.

Host shape for the backend:

```text
write: load retained state (+ Streams tail offset) → restore → read only records after
       the retained length → first must chain from the retained head → extendLedger
       → existing single-writer CAS + readback → save new state and digest with the
       checkpoint in one transaction
read:  serve pages by offset from Streams without host verification; clients verify
audit: deferred; may run outside Convex (e.g. a separate worker)
```

## Real-data measurements (2026-10-19)

Fresh Ed25519 key pairs per member and device, real join and possession signatures, SHA-256 epoch commitments and random 72-byte packets:

| Ledger | Records | Ledger | State | gzip | brotli | Pure-JS verify | Web Crypto path |
|---|---|---|---|---|---|---|---|
| 4,096 rotations | 4,097 | 1.0 MB | 448 KB | 446 KB | 437 KB | 7.2 ms/record | 3.2 ms/record |
| 1,000 members + 1,000 devices + 2,000 rotations | 4,001 | 1.1 MB | 641 KB | 624 KB | 424 KB | 10.3 ms/record | 7.9 ms/record |
| 4,000 members + 4,000 devices | 8,001 | 2.4 MB | 1.69 MB | 1.64 MB | 851 KB | 31.9 → **13.5** ms/record after the fix below | — |

- Synthetic filled-byte data compressed 20–40× and was misleading. Real state is mostly high-entropy, so gzip saves ~1–3%; brotli saves ~⅓–½ on member-heavy states because each key and membership ID recurs in several state sets beyond gzip's window. Compression was later dropped (see below).
- Member admission was quadratic: each admit scanned every current member for a duplicate user. A derived index of current member user IDs (rebuilt on snapshot import, never encoded) fixed it; per-record cost is now constant across ledger sizes.
- The remaining cost is noble curve arithmetic (~70% of the profile). Member and device records carry two signatures. The native Web Crypto path only halves the cost because the strict prime-subgroup check on each signature's R still runs in pure JS.
- Core snapshots are capped at 2 MiB; a state of about 5,000 members plus devices would exceed it, which needs a core encoding change regardless of the host.

## Convex platform limits

From the Convex limits documentation: queries and mutations have 1 s of user-code time, so verification stays in actions; Convex-runtime actions get 30 min and 64 MiB; Node actions 10 min and 512 MiB; documents are at most 1 MiB; arrays at most 8,192 elements; actions share a deployment-wide concurrency pool (64 on Free/Starter, 512 on Pro).

- Full replay per request fits the time limit but holds an action slot for about 22 s at 4,096 records, so a few concurrent history readers can saturate the pool for unrelated features. Its memory peak (up to 8 MiB of raw records plus copies and state) is unmeasured against 64 MiB.
- `finishWrite` and `observeHistory` receive every record hash as an array argument, which the platform rejects beyond 8,192 elements regardless of the backend's own cap. Pass length and head instead.
- Retained state is stored as bytes; state above 1 MiB needs chunking (core snapshots are bounded at 2 MiB).
- Per-record cost inside the Convex runtime is assumed similar to Node (both V8, pure-JS noble Ed25519) but has not been measured there.

## Core implementation (2026-10-19)

> **Update (2026-10-20):** the state encoding and the restore rules below are replaced by the [compact ledger state](2026-10-20-e2ee-compact-ledger-state.md): fixed-width tables with full membership and device history, so restored and snapshot-imported views keep every author.

`exportVerifiedState`/`restoreVerifiedState` are in `@lody/e2ee-core/protocol`. The retained bytes are the comparison-note state array plus the view's verification origin, so the export digest is the comparison-note digest without a second encoding. They share the snapshot decoder, with a 16 MiB budget instead of the 2 MiB snapshot cap. Restore skips the per-key Ed25519 curve check (about 7 ms per key) that dominated a first version; export sorts hex keys directly instead of re-parsing them per comparison.

Same real-data ledgers as above (one Node process, idle host):

| Ledger | Export | Restore | Extend by one | brotli q6 | brotli q11 | Decompress |
|---|---|---|---|---|---|---|
| 4,096 rotations | 32 ms | 68 ms | 5 ms | 438 KB, 20 ms | 432 KB, 1.6 s | 5 ms |
| 1k members + 1k devices + 2k rotations | 53 ms | 165 ms | 5 ms | 427 KB, 21 ms | 428 KB, 1.8 s | 6 ms |
| 4k members + 4k devices | 177 ms | 576 ms | 6 ms | 863 KB, 77 ms | 853 KB, 3.7 s | 7 ms |

The first version's restore took 14.5 s and 58 s for the last two rows. Compression is not used (owner decision): quality 11 costs seconds, and even quality 6 adds 20–80 ms per rewrite to save space only on member-heavy states. Retained state is stored uncompressed. Restore's remaining cost is per-element generator overhead in the shared decoder; a write-path restore under 0.6 s at 8,000 records is accepted for now.

## Capacity of one 900 KiB chunk

> **Update (2026-10-20):** these row costs are for the previous encoding. With the [compact ledger state](2026-10-20-e2ee-compact-ledger-state.md) a member with one device costs 138 bytes, each further device 69 and each rotation 104, and one chunk holds about 6,600 single-device members.

The host needs more than the current membership: verifying the next record also needs every replay fact, which never shrinks (all signing and encryption keys, membership IDs and join requests ever used, and every epoch commitment). Retained state is exactly the comparison-note state, so its size follows from the CBOR rows:

| Fact | Bytes, permanent part | Bytes, removed later |
|---|---|---|
| Member admitted with one personal device | 137 (keys, membership ID, closed join) | 140 (member and device rows) |
| Additional device | 68 (both keys) | 87 (device row) |
| Epoch rotation (also every removal or revocation) | 112 (commitment and 72-byte history packet) | — |

One uncompressed 900 KiB chunk (921,600 bytes) therefore holds about 3,300 current members with one device each, 2,100 with two, 1,570 with three, or 8,200 rotations. A workspace with 100 current members on two devices, 50 departed members and 1,000 rotations uses about 165 KB, under a fifth of one chunk. Rotations dominate long-term growth: ten a week for ten years add about 580 KB. These sizes match the benchmark states within 0.1%.

A host-only encoding could omit the 72-byte history packets, which only clients use, cutting each rotation to 38 bytes. It would no longer be the comparison-note state, so its digest would not match, and it would be a second format; it is not proposed.

## Platform review (2026-10-19)

- **Convex** (docs.convex.dev limits and pricing): the plan fits. Cost is dominated by database I/O, the bytes moved between functions and the database: each write reads and rewrites the state. At 10 writes/day per workspace and 0.5 MiB state, Pro overage is about $53/month for 1,000 workspaces and $620 for 10,000; rewriting the snapshot only every 64 appends roughly halves it. Storage and function calls stay within included amounts. The current full-replay code breaks Starter's 64-action concurrency near 10,000 workspaces.
- **Loro Streams** (repo code and specs): reading from a saved offset seeks directly. Full-stream reads are risky: rare writes leave many small cold segments that are never compacted, and a forward page can exceed the gateway's 5 s read timeout. Ledger tokens should list only `stream-read`, `stream-head` and `stream-append-cas` (delete only for erasure), and be cached per stream for their 15-minute lifetime. No prices exist in the repo.
- **Cloudflare** (for a later audit): Workers Paid with Workflows fits, chunked with state in R2; about $11/month for 1,000 and $82 for 10,000 daily audits at 2,000 records each.

## Alternatives considered

- **Recompute the digest on every restore.** Rejected: the bytes and the digest live in the same trusted store, so whoever can alter one can alter both. It only catches bugs or corruption, which belongs to an optional, deferred background audit off the hot path. Superseded in part: restore now checks a digest the caller chooses to supply (one SHA-256), still as a corruption check rather than a security boundary; see the [compact state note](2026-10-20-e2ee-compact-ledger-state.md#restore-digest-check).
- **Keep full replay and raise limits.** Rejected: cost stays linear per request.
- **Server-endorsed snapshots.** Not possible: endorsement requires an Owner/Admin personal device signature.
- **MAC the retained bytes with a server key.** Rejected for the same reason as recomputation: same trust domain.

## Open questions

- Size: a Convex document is limited to 1 MiB, so large organizations need chunked storage (planned: uncompressed chunks under 900 KiB, switched by generation; see capacity above).
- Whether the client local stores adopt restore-on-open, which changes the "revalidates stored ledger records on open" rule in the foundations Spec.

## Verification limits

The timings come from local Node benchmarks (the first with synthetic records, the real-data tables with freshly generated keys and signatures), verified through core's noble path; the Convex runtime may differ. The core export/restore exists with tests (restore at every position then extend equals full replay; every replay fact survives; mismatched position, version and fork fail closed). The host cache tables and the audit job do not exist yet.
