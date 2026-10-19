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
- `stateDigest = sha256("lody-e2ee/snapshot-digest/v1\0" ‖ body)` and comparison notes for cross-party fork detection.
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
audit: off-path full replay from genesis, compare digest; mismatch blocks writes
```

## Alternatives considered

- **Recompute the digest on every restore.** Rejected: the bytes and the digest live in the same trusted store, so whoever can alter one can alter both. It only catches bugs or corruption, which the background audit already covers off the hot path.
- **Keep full replay and raise limits.** Rejected: cost stays linear per request.
- **Server-endorsed snapshots.** Not possible: endorsement requires an Owner/Admin personal device signature.
- **MAC the retained bytes with a server key.** Rejected for the same reason as recomputation: same trust domain.

## Open questions

- Whether retained state includes historical content attribution and original epoch publication records, or a restored view reports them unavailable.
- Size: core bounds snapshots at 2 MiB, while a Convex document is limited to 1 MiB, so large organizations need chunked storage.
- Whether the client local stores adopt restore-on-open, which changes the "revalidates stored ledger records on open" rule in the foundations Spec.

## Verification limits

The timings come from one local benchmark with synthetic records and Node's native Ed25519 signing; production action runtimes may differ. No code, cache table or audit job exists yet.
