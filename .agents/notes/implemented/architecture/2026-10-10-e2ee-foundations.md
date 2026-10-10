# Extract the E2EE byte and verification foundation

Date: 2026-10-10
Status: implemented
Translation: current

[中文](2026-10-10-e2ee-foundations.zh.md)

## Abstract

The candidate core couples byte formats and cryptography to experimental ledger
and host code. This change extracts a standalone public package for strict bytes,
canonical CBOR, content v0 context and signature verification. It has no production
consumer, private-key operations or authority construction. Encryption, derivation,
ledger policy and platform custody still need separate implementation and acceptance.

## Decision and source

Start from public main `249661be340af5a20b8d0b7334d2e923fe5b5a99` and reuse its
Effect 4.0.2 catalog. No Streams/repo dependency; main retains repo 0.21.2 and
CRDT 0.16.2. Pin candidate crypto libraries rather than changing algorithms.
[Provenance](../../../../packages/e2ee-core/provenance.json) records candidate
`bd5a9c1ec71ed7fa8085e51faec4f1e8dbe985b8`, exact source hashes and extraction changes.
The candidate had staged work; the selected sources all matched that commit and
were read only.

Moving the whole candidate would import unrelated ledger/host responsibilities.
Instead, keep one entrypoint and Effect Result values. Retain strict point checks
without caches or injected executors. Return fresh HKDF salt bytes to prevent
mutation of a shared domain. P14 may consume public key/signature types and
validators from `@lody/e2ee-core`; private keys and platform handles stay with it.
The [Spec](../../../../specs/e2ee-foundations.md) remains draft.

This adds foundations below the existing
[transport contract](2026-10-10-workspace-streams-content.md), without changing it
or activating consumers. No persisted data or ordinary workspace behavior changes.
Before consumers exist, rollback removes this package and its lock entries.

## Candidate failure ownership

Original failing suites ran in a disposable copy using candidate dependencies;
no candidate source/index mutation. Core: 5 passed, 7 failed across four suites.
Lab review2-b-sync: 12 passed, 2 failed (requires loopback socket permission).
These are ownership evidence, not accepted failures:

| Candidate suite | Failures | Owner |
| --- | --- | --- |
| review2-a | Forged LedgerView (1) | Verified ledger authority |
| review2-c-delivery | Read limit, 4096-envelope outbox (2) | Key delivery |
| review2-c-rotation | Lost rotator (1) | Rotation/recovery |
| review2-e-api-boundary | Injected verifier, impossible Owner snapshot, substituted persisted trust (3) | Ledger/snapshot trust |
| Lab review2-b-sync | Duplicate committed record, rollback page (2) | Control sync/cursor recovery |

None of those constructors, services or policies is imported. No verified ledger
view or injected signature verdict exists here. Mixed-torsion A/R regressions
exercise the strict verifier even when the library's cofactored equation accepts
the constructed signature.

## Verification and limits

Tests use fixed RFC 8032 bytes, independently native-signed v0 frames, CBOR vectors
and negative cases: wrong Org/document/purpose, unknown version/generation,
binding mismatch, tampering, byte ownership and Effect composition. Source content
domains remain unchanged. The focused suite passes 42/42, typecheck and scoped
lint pass, and a browser-target ESM bundle executes the fixed vector in Node.
Format, docs (zero errors), frozen install and boundary checks pass. Full
`pnpm check` reaches a baseline CLI Git fixture failure (`context_unreadable`):
CLI 3707 pass / 1 fail / 4 skip. The exact main source fixture reproduces 5 pass /
1 fail in a disposable directory. Earlier sandbox socket failures disappear with
loopback permission: shared 1365/1365 pass. Components pass 5033/5033. This is not
a full-green repository result; remaining checks and CI are recorded in the PR.

This is not production, platform custody, browser/mobile device, AEAD, snapshot
recovery or full security acceptance. Historical failures remain open in their
owners. No release, deployment, feature opening or all-platform Beta is enabled.
