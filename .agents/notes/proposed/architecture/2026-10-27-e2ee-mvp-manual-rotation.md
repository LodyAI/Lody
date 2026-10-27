# MVP manual rotation preserves sending

Status: proposed
Translation: current

[中文](2026-10-27-e2ee-mvp-manual-rotation.zh.md)

## Abstract

The owner explicitly replaced mandatory rotation blocking with availability-first MVP behavior. A verified rotationRequired flag stays in the ledger as a manual administrator action hint, while active non-Guest personal/machine devices retain seal permission. Revoked devices, removed members, Guest and Recovery devices remain unable to write. This accepts that a revoked device retaining the current key can decrypt ciphertext it obtains; server credential/token authorization and absolute expiry must bound access.

## Scope and evidence

Only the derived content permission changes. Ledger originals, retained state, snapshots, commitments, domains and wire formats do not change. The existing real replay test covers pending and completed rotation plus the revoked device; real Streams crypto/admission verifies usable new frames while pending. Both changed behaviors fail on the prior implementation. Current membership and signing-time rechecks are retained.

The document binding's fixed epoch handoff is a separate PR20-C responsibility. No automatic signing, device revocation UI, settings badge or release is added here. Real gateway expiry and installed-device acceptance remain unverified. This owner decision supersedes the blocking interpretation in earlier E2EE design documents; it does not roll back a saved format.
