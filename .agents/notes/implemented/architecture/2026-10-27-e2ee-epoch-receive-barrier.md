# Current-epoch sealing and retained ciphertext

Status: implemented
Translation: current
PR: https://github.com/LodyAI/Lody/pull/2131

[中文](2026-10-27-e2ee-epoch-receive-barrier.zh.md)

## Abstract

New content is sealed at the verified current epoch inside the native host. Retained ciphertext and historical reads remain available, but stale provider hints never authorize new old-epoch ciphertext.

This corrects the earlier reception/selection policy in [#1954](https://github.com/LodyAI/Lody/pull/1954).

## Authority and selection

The native host owns the verified ledger, installed keys and receive journal. Renderer/CLI transition providers retain stable callbacks and may temporarily retain an old epoch hint. That hint is not encryption authority: every new seal uses core's `writeEpoch: current` selection, captured inside the native operation. A missing current key fails the save for retry; it never substitutes an older key. The same rule covers document, Meta and Flock updates and snapshots. Opening a replica with retained history remains possible.

An operation that already captured its epoch before a later publication may finish its old-epoch frame, and already sealed queued ciphertext may still be transmitted. Neither case authorizes sealing newly authored content with an older key. Historical key reads and original ciphertext remain intact. Every operation retains core's current membership/device checks before encryption and after signing; revoked, removed, Guest and Recovery writers remain denied. Wire namespaces, commitments and frame formats are unchanged.

The previous availability-first MVP deliberately allowed new seals at a retained published epoch while receiving the current key. This is superseded by the security requirement above: a revoked device may retain its old key, so expiry of its server credentials cannot establish confidentiality of newly authored content. Another window/native operation can commit rotation without notifying an existing renderer; relying on its cached transition epoch can therefore keep leaking new content even after installation succeeds. Native per-operation selection also avoids a status-read/seal race and adds no network request to the save queue.

## Reception and failure containment

Staging locators come from genuine publication originals. KeyReceiver independently verifies signatures, publication, recipient, HPKE and commitment. Optional staging denial/I/O failure continues to independently verified mailbox/history reception; failed reads never count as installed keys. No automatic signing, replacement keys, plaintext fallback or destructive rollback is introduced.

The existing renderer/CLI owner starts reception on startup, verified advancement, reconnect or explicit retry. A ten-second waiter deadline retains ownership of unfinished native work; late, timed-out or superseded receipts cannot commit the UI/token selection. Close retires callbacks and joins admitted crypto and raw work. Independent workspaces remain independent. Current-key readback synchronously advances transition state and invalidates active tokens; future desktop token owners separate cache identity by epoch. `rotationRequired` remains a manual administrator hint, not a publication or permission verdict.

No Repo restart, transport replacement, queue deletion, SDK strong-close patch or SDK version change is required. A missing key or storage failure settles the SDK save as failure and leaves local data retryable; the save queue never waits for network key reception. Retained keys preserve historical reads, not authority for new old-epoch ciphertext.

## Evidence and limits

Deterministic tests cover a real stable desktop provider over the native SQLite/crypto host after revocation/rotation without renderer notification, updates and snapshots in document/Meta rooms, missing-current-key refusal, historical reads, and receipt/close ownership. Existing reception tests retain staging denial, temporary I/O, delayed mailbox delivery, late machine admission, restart and candidate recovery. These are local boundary checks, not installed-device, OS-keychain, gateway/WAN or cross-platform acceptance.

The earlier advisory permission change is independently reviewed in [#1956](https://github.com/LodyAI/Lody/pull/1956). The native Effect consumer migration remains separate in the [roadmap](../../proposed/architecture/2026-09-27-effect-lifecycle-migration-roadmap.md#unit-ledger).
