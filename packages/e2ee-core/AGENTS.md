# E2EE foundations

Contract: [foundation Spec](../../specs/e2ee-foundations.md). Entry map: [README](README.md).

- This package has no production entrypoint, transport, storage, snapshot trust,
  private-key export or signing API. Keep the root export map explicit; ledger
  records/replay live only under the explicit `./ledger` subentry.
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
