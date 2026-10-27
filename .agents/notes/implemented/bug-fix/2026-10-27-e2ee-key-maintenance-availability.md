# E2EE key maintenance availability

Status: implemented
Translation: current
PR: [#1976](https://github.com/LodyAI/Lody/pull/1976)

[中文](2026-10-27-e2ee-key-maintenance-availability.zh.md)

## Abstract

Unreadable installed keys prevented opening the desktop ledger needed for repair. Rejected envelopes, discarded pagination and unconsumed results could also starve delivery. The desktop now opens verified ledger state independently of key health, repairs deterministic envelope rejections, retains independent paging hints and acknowledges terminal business results. Signature, commitment, original-byte retry and native settlement rules remain intact; real platform/cloud acceptance remains separate.

## Decision and ownership

The existing workspace host owns maintenance, its in-memory queue cursors and coalescing. One pass performs at most four core rounds; coalesced follow-up is also bounded to four passes. Epoch changes reset cursors. Failed rounds never advance them. Close aborts this workspace's network, drains admitted work and then releases stores. No second writer or new recovery lifetime is introduced. This host already uses native Effect; no migration ledger boundary changes.

Ledger open still verifies history and independent pins. Unreadable key blobs give `hasCurrentKey: false`; only checked retained keys can populate `writeEpoch`. This preserves reader registration, ledger display and explicit refresh. Core alone replaces damaged blobs after authenticating the same committed key. Creation originals remain immutable. This narrows the M1/M2 key-health prerequisite, without weakening ledger authority or custody.

`MailboxInstallError.cryptographicRejection` is set only at envelope authentication/open boundaries. Report signing, SQLite, authority changes and unknown native failures cannot authorize rejection. HPKE AEAD authentication errors differ from ambiguous native setup/decapsulation errors. Deterministic rejection enqueues the stable epoch/digest repair and re-fetches the same page; hints grant no authority. A hostile page beyond the finite budget needs another maintenance event. Ambiguous decapsulation remains retryable, even if malicious bytes caused it: classifying native failure as remote corruption would destroy a valid delivery path.

The CLI also requires this core diagnosis before requesting digest repair, so a temporary local install failure cannot reject a good envelope.

The desktop observes and acknowledges terminal receive, repair and distribution results. This frees unconsumed capacity, retaining journal rows and exact outbox ciphertext. `Observed` remains mailbox readback, not recipient key possession. Each queue keeps its own cursor; pending early tasks cannot starve later tasks across finite calls.

## Evidence and limits

Real crypto/SQLite regressions cover damaged installed blobs, bad signature before a good envelope, more than 501 pending deliveries, terminal ACK without changed outbox originals, and storage recovery without remote rejection. The first three fail against the original runtime. Core tests cover signed HPKE rejection and native failure classification; existing host close, slow mailbox, pairing, epoch and historical-content tests remain. Exact checks are recorded in the PR.

Synthetic authenticated OS wrapping does not prove real keychains, installed desktops, physical devices, live repair or production enablement. CLI key-health recovery and explicit identity reset remain separate owners.
