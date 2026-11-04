# Ledger verification code on the encrypted workspace page

Status: proposed
Translation: current

[中文](2026-10-20-e2ee-ledger-verification-code.zh.md)

PRs: [LodyAI/Lody#1625](https://github.com/LodyAI/Lody/pull/1625)

## Abstract

Members of an encrypted workspace had no way to check that the Lody server shows every one of them the same permission ledger, so a server that swapped a public key or forked the ledger would go unnoticed. The control page now shows a safety-number style verification code with a QR code that members compare out of band, by copying, reading aloud or scanning. The code is core's comparison digest, which binds protocol, genesis, version, head and the actual permission state, because the whitepaper rules out comparing a bare head hash. A match proves only that both people hold the same ledger at that version. Who a member really is still needs the people to confirm it themselves, and results are not yet persisted.

## Decisions

- **What the code is.** `ledgerStateDigest(view)` in core returns the digest that `comparisonNote` already computes, `sha256("snapshot-digest/v2" ‖ CBOR[2, genesis, length, head, authorization state])`, without requiring a ledger device as note signer. The control page holds no device key, so it could not call `comparisonNote`. The [whitepaper](../../../../specs/e2ee/whitepaper.md) requires safety codes to bind the actual state: a head alone can accompany a wrong state, for example on a snapshot-bootstrapped client.
- **Version** is the number of verified records. The QR payload is `lody-ledger:1:<version>:<head>:<digest>`. The copied text is a header with the version, then the digest in sixteen groups of four.
- **Comparison** (`e2ee-ledger-verification.ts`):
  - same version and digest (and head, when present): match;
  - same version, different digest or head: mismatch;
  - an earlier version whose head equals this ledger's record at that position: same history, the other side is behind;
  - an earlier version with a different head: mismatch;
  - a later version: refresh first;
  - a pasted digest without a version that differs: undecided.
  
  Different positions are never reported as an attack, as the whitepaper asks.
- **Scanning** uses `getUserMedia` plus `jsqr` (Apache-2.0), only after the person presses the camera button, and releases the camera on the first decoded frame. Pasting always works. The macOS build adds the camera entitlement and `NSCameraUsageDescription`.
- **Names and avatars** are display data, not ledger facts. The ledger's user ID is random, and no member-profile API exists yet. The page accepts `you` and `memberProfiles`. The route supplies only `you`, attached to the genesis member and only when this device holds the creation pin; others show "Member N". The hint text tells people to confirm in person which member they are.

## Alternatives

- **Head hash only**: simpler and enough for full-replay clients, but the whitepaper forbids it, and it would silently weaken once snapshot bootstrap ships.
- **Numeric safety number (WhatsApp style)**: friendlier to read aloud. Deferred, because hex groups match the existing note digest and are easy to copy; changing the rendering does not change the digest.
- **`BarcodeDetector`**: unavailable on Windows and Linux Chromium, so a pure-JS decoder is needed anyway.

## Verification and limits

- Core test: the signer-free digest equals the comparison-note digest, both for full and snapshot-verified views, and a counterfeit view is refused.
- Unit tests cover parsing, including a copied header with a version, and every comparison outcome.
- Page tests check that the shown code equals the digest and that the profile only attaches with the pin.
- In headless Chromium, a fake camera feed of generated QR codes produced match, older-copy and fork (right head, wrong state) verdicts, and copy-then-paste matched.
- Not verified:
  - real macOS signing with the new entitlement;
  - iOS/Android shells, which need their own camera permission strings in the private app.
- Comparison results are not stored. The whitepaper's "independently compared at this position" state and `confirmIndependentComparison` are not wired up.
- Other members' names need a backend profile directory keyed by membership. That data stays display-only.
