# Extract the fixed epoch HPKE primitive (P07-c)

Date: 2026-10-11
Status: implemented
Translation: current
PR: [#1432](https://github.com/LodyAI/Lody/pull/1432)

[中文](2026-10-11-e2ee-hpke-primitive.zh.md)

## Abstract

Main has format/signature and content crypto foundations but no HPKE primitive.
This slice preserves the existing epoch-envelope Base suite and exact context,
adding bounded-input seal/open operations without ledger, delivery or installation.
It uses caller-owned native device handles and host secure randomness; interruption
waits for native completion and cleanup. This neither authenticates a sender nor
proves authority, production custody, full memory erasure or platform acceptance.

## Decision and source

Final main base: `26726a46b11a9b8ae9f1f7f8a0e89ef7d430b760`, after #1417/#1418 merged.
Initial inspection used `978fb404cd2ef0de6c6e35322c226103704167b2`.
#1418 was still open at initial inventory; no unmerged implementation was used.
The independent clone and pnpm store are task-owned. No candidate, coordination
plan or other author's checkout is modified.

Candidate `bd5a9c1ec71ed7fa8085e51faec4f1e8dbe985b8` retains both a legacy
JSON prototype and the current ledger envelope. The current ledger Spec §8.5 fixes
Base 0x0020/0x0001/0x0003, info `lody-e2ee/hpke-epoch/v1\0`, canonical CBOR
`[genesis32, epoch, senderSign32, recipientSign32]`, plaintext32 and
`AAD || enc32 || ct48 || signature64`. The outer signing domain stays
`lody-e2ee/epoch-env/v1\0`. Whitepaper v0.16 retains epoch envelopes; the legacy
`lody-epoch-key-hpke/v1` JSON format is excluded. No new protocol fields or
recovery format are selected. Source/destination fingerprints are in
[provenance](../../../../packages/e2ee-core/provenance.json).

The exact candidate dependency closure adds core 1.9.0, chacha20poly1305 1.8.0
and common 1.10.1. Effect stays 4.0.2. Incidental lockfile reordering/transitive
updates from pnpm add were removed; frozen installation validates the minimal lock.

## Ownership and trust

```text
trusted caller context + opaque epoch key + recipient public key
  -> fixed Base seal -> unsigned enc32/ct48
trusted caller context + external device handle + expected public key
  -> fixed Base open -> opaque EpochKey
caller: outer signature, current eligibility, commitment, recheck, durable install
```

No public suite/info/entropy override, identity generator, private-key export,
ledger authority, publisher, store, runtime or background fiber is introduced.
Returned cryptographic success deliberately carries no authorized-envelope brand.
The caller owns native device custody; per-call suite state is discarded after use.
Temporary plaintext/random buffers are wiped in ordinary try/finally, outside
Result.gen short-circuit regions. Caller secrets and handles remain usable.
WebCrypto/HPKE cannot accept AbortSignal, so only this finite native operation is
uninterruptible; interruption awaits settlement and cleanup in the existing owner.
A stuck native host remains a shutdown limitation. JS/native/library internal copies
and derived CryptoKeys cannot be guaranteed erased by these buffer wipes.

## Evidence and remaining limits

Public package tests and typecheck cover RFC 9180 A.2.1, independent Python
HMAC/X25519/ChaCha20Poly1305 bytes, exact AAD, trusted-context substitution,
strict lengths, low-order DH rejection, old-info rejection, secure-random failure,
non-extractable native keys and scope interruption with explicit signals.
The checked-in Python generator reproduces RFC bytes before creating the Lody
vector; tests do not depend on Python or the network.

Actual candidate-driver comparison and browser evidence are recorded at PR
handoff. Candidate's seven core/two Lab historical failures retain the boundaries
in [P07-a](2026-10-10-e2ee-foundations.md) and
[P07-b](2026-10-11-e2ee-content-crypto.md); their ledger/recovery/delivery modules
are excluded, and no historical failure is declared fixed here. Independent
high-risk review belongs to coordination. Production stores, full envelope workflows,
platform support matrix and deployed clients remain unverified.

Author validation on the final base: package **113/113** (28 HPKE, 46 foundation,
18 content crypto, 21 ledger) and package typecheck pass. Actual read-only candidate
driver matches the independent vector and interoperates in both directions. Public
entry bundles and runs in Chromium 145.0.7632.6 with host secure randomness, a
non-extractable native X25519 private key, round trip and tamper rejection. Frozen
install, root format, docs (zero errors, 65 existing warnings, no protected topic
changes), i18n and all public/platform/process/import guards pass.

Full pnpm check passes repository typecheck/lint but stops at unchanged CLI native
Git credential recursion: context_unreadable, 3720 passed / 1 failed / 4 skipped.
The six-test suite on isolated main 26726a46 reproduces 5 passed / 1 failed; removing
only the test process's inherited GIT_EXEC_PATH produces 6/6. No global setting or
source is changed. Other queued full-check suites are not declared complete.
Initial clone preparation missed acp-extension-core's generated build; building its
locked source resolved that preparation error. An initial interruption test used
a nonexistent v4 Fiber.poll API and timed out while its gate was unreleased; the
corrected explicit gate/pollUnsafe test passes without changing runtime behavior.
