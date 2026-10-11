# Extract scoped content crypto (P07-b)

Date: 2026-10-11
Status: implemented
Translation: current
PR: [#1417](https://github.com/LodyAI/Lody/pull/1417)

[中文](2026-10-11-e2ee-content-crypto.zh.md)

## Abstract

Main can encode content v0 and verify signatures but cannot derive keys or check
ciphertext tags. This slice adds scoped HKDF-SHA-256 and XChaCha20-Poly1305
primitives through the public entry. Candidate algorithms and protocol bytes
remain unchanged, with explicit input limits and random-source failure.
Production consumers, signing private keys, ledger, storage and full content
workflows remain separate, as do independent review and product acceptance.

## Scope and source

Based on merged P07-a #1405 and main
`c52e5d26b5260cc94191cbae62d4fe11cfa2bb04`. Effect stays 4.0.2 and hashes 2.2.0;
ciphers 2.1.1 matches the candidate and already exists in the root lockfile.
Only the importer is added. Existing E2EE PRs were checked for duplicate work.

[Provenance](../../../../packages/e2ee-core/provenance.json) extends the
[P07-a record](2026-10-10-e2ee-foundations.md) with selected content-frame and
platform-content fingerprints. Both match candidate commit
`bd5a9c1ec71ed7fa8085e51faec4f1e8dbe985b8`; staged SDK fixes are excluded.
The current protocol and candidate agree on salt/info, document purpose sharing,
external binding, header, algorithm, nonce and tag lengths. The candidate stays
read only; tests run from a disposable copy.

This stops below ContentCipher/DocumentKey import-export and signed workflows.
Opaque ContentKey owns a context-bound secret; four document purposes share a
leaf while other purposes remain isolated. Synchronous noble HKDF uses the locked
hash dependency instead of introducing an async WebCrypto service/runtime;
actual candidate WebCrypto comparisons verify identical bytes. HPKE stays separate.

## Responsibilities

```text
caller supplies trusted header/context + EpochKey
  deriveContentKey -> opaque scoped leaf (HKDF-SHA-256)
  sealContentAead -> secure random nonce + ciphertext/tag
  openContentAead -> check lengths/context + tag -> plaintext
caller separately verifies signature, author authority and current permission
```

This selects no production authority or platform custody policy. No cursor,
snapshot recovery or storage is introduced. Existing single-document failure,
client recovery and all-platform Beta decisions remain unchanged.

New seals require host crypto.getRandomValues; absent/throwing randomness returns
only a fixed code. Inputs are captured before the host call. No nonce/random
override or plaintext fallback is exposed. Retries retain exact sealed bytes.
Size limits apply before large copies. Length failures are distinct from tag
failures. Temporary epoch/key/PRK/plaintext copies are wiped; leaf lifetime follows
object reachability. JavaScript cleanup does not guarantee runtime memory erasure.

## Evidence and limits

- Public entry: 64/64 tests, 46 inherited and 18 crypto; typecheck passes. Eight
  independently encoded Python HMAC/libsodium fixed vectors, native HKDF, nine
  purposes, wrong context/key/header/binding, tampering, exact 16 MiB/1024-byte
  limits, randomness failure and input ownership are covered. Generator is checked in.
- Actual candidate content suite: 25/25 pass in a disposable copy. Additional
  actual candidate WebCrypto/AEAD comparison covers nine purposes × two bindings.
- Public browser bundle builds and executes in Chromium with real secure randomness,
  round trip and tamper rejection. Supported browser versions, native/mobile key
  custody, production wiring and full security acceptance remain unverified.
- Initial new-test failures: deep comparison of 16 MiB exhausted a worker heap;
  length plus Buffer.compare now checks every byte without enumeration. A wrong
  purpose test passed its original context; the corrected context tests rejection.
- Seven core/two Lab historical candidate failures remain in ledger trust,
  delivery, rotation/recovery and control sync as recorded in P07-a. None of those
  modules is imported, and this slice does not close those failures.

Repository typecheck/lint, format/format:check, docs (zero errors/no protected
topics), i18n and all boundary guards pass. Full pnpm check stops at the unchanged
CLI recursive Git credential fixture: context_unreadable, 3708 passed / 1 failed /
4 skipped. The same six-test suite on fixed main sources in a disposable directory
reproduces 5 passed / 1 failed. Initial sandbox loopback EPERM is separate; the
full rerun permits local sockets. Other queued suites are not declared complete.
One CI round is recorded in the PR. No real keys, global
settings, design directory or other agent workspace changed. No release,
deployment, Ready transition or merge is included.

## Correction: temporary copies on typed failure

Installed Effect 4.0.2 Result.gen returns Failure without closing the iterator.
Yielding a failed Result inside generator try/finally therefore bypassed cleanup
on randomness/tag failure in the initial commit. Cleanup now completes inside
an ordinary call before its Result is yielded, without changing wire bytes/codes.
The regression retains actual copied-buffer references and checks wiped key/plaintext
after randomness failure, wiped key after authentication failure and a reusable leaf.
It fails against a disposable 9abee347f source copy. It asserts resulting buffer
state, not mock-call counts.
