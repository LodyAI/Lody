# E2EE foundations

Contract: [foundation Spec](../../specs/e2ee-foundations.md). Entry map: [README](README.md).

- This package has no production entrypoint, transport host, snapshot trust,
  private-key export or signing API. Keep the root export map explicit; ledger
  records/replay live only under the explicit `./ledger` subentry. Local submission
  workflow/storage live under `./submission` and `./submission/sqlite`; the root stays platform-neutral.
- Preserve candidate wire algorithms, domains and versions. Expected malformed
  input returns Effect 4 Result errors; never silently repair or downgrade bytes.
- Enforce CBOR limits before full expansion or copying: charge shared values by
  their expanded wire size and reject cycles without unbounded traversal.
- Trusted Org genesis, resource, epoch, purpose and signer come from the caller's
  independently verified context. Frame metadata is unverified. Signature success
  establishes neither current permission nor AEAD validity.
- Ed25519 requires canonical nonzero prime-subgroup A and canonical prime-subgroup
  R with `zip215: false`. No caller-supplied point cache or verifier bypass.
- Public byte wrappers own copies. Secret epoch keys have no public byte export;
  native private-key custody belongs to platform adapters, not this module.
- Tests use fixed synthetic vectors and negative cases. Record extraction changes
  and source SHA-256 fingerprints in provenance.json; never copy private designs,
  captured transcripts, Lab hosts or unrelated candidate modules.

- Content crypto lives in `src/crypto`; ledger work uses its own directory/entry.
  AEAD primitives do not authenticate authors or grant permissions. Use trusted
  caller scope/header and retain v0 key/AAD domains. New seals require host secure
  randomness; no nonce override, plaintext fallback or implicit retry encryption.
  Keep derived key material opaque, and validate size before copying large inputs.

- Ledger authority starts only at caller-pinned genesis plus an expected head/count,
  or a module-created verified view. No arbitrary-state constructor, injected verifier,
  snapshot placeholder, or journal-derived trust. Failed suffixes preserve the prior view.
- Reject legacy non-atomic member removal; its replacement belongs to P12.

- Submission persists original signed bytes before CAS, retries exact bytes, and
  reads back before reporting success. Conflicts never re-sign. Terminal result,
  pending removal and verified rollback pin save atomically; explicit consumption
  is required. Application Scope owns storage; closing never deletes pending.
- Journal bytes/checkpoints do not establish permissions. Reverify complete history
  from external trusted genesis, including stored terminal results. No legacy-state
  import, checkpoint restore, implicit repinning or bad-history skipping.

- HPKE is the fixed Base X25519/HKDF-SHA-256/ChaCha20-Poly1305 epoch
  primitive, not an authorized envelope workflow. Keep the existing info and
  canonical AAD; never accept an algorithm/info override. Caller-owned native
  device key handles stay external; no key generation, storage or delivery here.
  Await non-cancellable native work and temporary-buffer cleanup on interruption.
