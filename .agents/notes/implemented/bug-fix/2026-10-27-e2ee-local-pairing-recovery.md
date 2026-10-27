# Keep machine pairing recovery bound to its identity and pending session

Status: implemented
Translation: current
PR: [#1945](https://github.com/LodyAI/Lody/pull/1945)

[中文](2026-10-27-e2ee-local-pairing-recovery.zh.md)

## Abstract

Deleting a published machine device original left its access credential at a genesis-only path, so an explicitly approved replacement could not retain its own credential. A second desktop preparation also rotated staged unsigned material before approval. Credential locations now include the signing key, while pending unsigned sessions stay stable until verified admission or original-history settlement. Existing current-format credentials at the former location reopen read-only with strict authenticated binding; no protected format or network protocol changes.

## Decision and ownership

Core custody keeps the existing KEK, authenticated blob format and purpose/genesis/key binding. New credentials publish exclusively at `device-credential-${genesis}-${signingKey}.sealed`; exact retries reopen the winner. A missing keyed location may read the former genesis-only location, without copying or rewriting it. Its AEAD and complete expected AAD must match. During explicit preparation only, an authenticated current-format credential for a different key in the same genesis is retained as other-identity evidence, and a separate credential is generated. Corrupt keyed files never fall back; corrupt or foreign-genesis former files never authorize replacement credentials. This is filename compatibility within the current format, not migration or support for older protection formats.

The CLI journal permits replacement of a missing published identity only through a fresh explicit session. The old material, admission and runtime directories remain. Runtime journals and installed-key stores continue to use the signing key in their path, so the replacement does not reopen the previous identity's protected epoch blobs. Published credential paths are distinguished from the unfinished generation, so a transient custody/device-creation failure remains retryable without resetting ownership. A former genesis-only credential is ignored as published evidence only after exact AAD and credential-hash verification, without a keyed file shadowing that read. A creating generation with its own retained credential cannot replace its missing device; same-scope takeover and superseded-generation fencing remain. Missing KEK/selector, unsafe permissions and non-ENOENT device errors remain failures.

Desktop main owns pending approval material and exact signed request originals. Staged unsigned material without admission remains pending across windows, retries and restart. Current exact device state or an exact verified original admission settles unsigned material, including after later revocation. Settlement validates the credential binding and the possession proof for the current member/genesis/device kind/keys before matching current device state or original admission keys and proof; a used key or another member's admission is insufficient. An already admitted device may settle without a new signed request; signed uncertain requests still require their verified original or competing parent. The existing all-null superseded receipt/retirement contract is unchanged. Shared workspace serialization and native Scope release remain the owners; no network call or new cancellation policy is introduced.

## Evidence and limits

Real crypto, SQLite and file tests cover device-only loss through pairing-required, explicit preparation, admission, mailbox key installation and activation; old credential bytes and runtime evidence remain. Custody tests cover read-only filename compatibility, other-key isolation and corrupt keyed-file fallback rejection. Desktop tests exercise repeated preparation/staging before approval, exact request retry after reopen, genuine settlement and superseded retirement. Ordinary workspaces do not enter these modules. The full CI and desktop smoke gates remain required; synthetic protection does not establish real keychain, packaged app or remote-pairing acceptance.

This corrects the partial-custody rejection in the earlier [pairing note](../../proposed/architecture/2026-10-26-e2ee-machine-pairing-journal.md): rejection still protects unfinished generations, while a published identity can recover with a fresh session and a distinct credential location.
