# E2EE ledger records and deterministic replay

Status: implemented
Translation: current

PR: [#1418](https://github.com/LodyAI/Lody/pull/1418)

[中文](2026-10-11-e2ee-ledger-records.zh.md)

## Abstract

The candidate ledger accepted fabricated authority through a reflected view constructor or a caller-provided permissive verifier. This extraction uses the merged foundation verifier and private, closure-backed views for strict record parsing, chain checking and deterministic permission replay. Trust comes from caller-pinned genesis and expected chain endpoint, never a URL, snapshot or journal. Snapshot endorsement/restoration and obsolete non-atomic member removal remain unavailable; product integration is later work.

## Scope and evidence

Base: public main `2e9482723e869fca7bea52fd5f036a37c53787e1`, including merged P07-a #1405. Open PR inventory checked before implementation; no competing ledger slice was present. No P07-b crypto, private workspace dependency, CAS, journal, recovery store, service or production switch is copied. This extends the [foundation extraction](2026-10-10-e2ee-foundations.md) through a separate subentry, leaving root crypto files/exports untouched.

The read-only candidate's original core source/tests were copied to isolated scratch storage with an independent Vitest cache; installed dependencies were only referenced for reproduction. `node node_modules/vitest/vitest.mjs run test/review2-e-api-boundary.test.ts test/review2-a.test.ts --reporter=verbose` reproduced **4 failures / 3 passes**:

| Candidate failure | This slice |
| --- | --- |
| Reflected LedgerView constructor accepts fake state | Null-prototype frozen view with private WeakMap state; clones fail extension |
| Injected SignatureVerifier accepts zero-signature epoch record | Fixed P07-a strict verifier; no verifier parameter/service |
| Admin snapshot admits Owner with no personal/recovery device | No snapshot import/endorsement entrypoint |
| Plain journal substitutes trusted snapshot endorser | No journal restoration entrypoint |

These reproduce the ledger/trust subset of the recorded seven core failures. Delivery ingress/outbox lifetime and interrupted-rotator recovery remain outside this slice and unresolved. The candidate's whole suite is not green. No candidate failure becomes an accepted public API behavior.

## Contracts and trade-offs

Parsing/signing-byte/hash helpers return unverified data; full verification and atomic suffix extension publish authority only after all checks. Operation proofs bind caller-pinned genesis and the actor's preceding membership; policy reads current role and device kind. Required head/count checkpoints detect missing suffixes without claiming global freshness. Inspection maps are detached; frozen rows use copy-owning public byte wrappers. Structural clones and reflected constructors cannot create authority.

Supported candidate arrays/domains are preserved. Legacy tag 2 is rejected because two-step removal violates adopted D12; P12 owns its atomic replacement. Snapshot extraction is deferred instead of exposing incomplete trust machinery. Returning detached state alone would lose safe incremental authority; retaining injectable verification would preserve the reproduced bypass. No new operation format or protocol-policy choice is introduced.

Signed history packets remain opaque 72-byte values: decryption and commitment preimages are not verified. Nullable join expiry remains a signed field; historical replay does not consult today's clock. Product workspace binding, freshness, online admission, full audit after future atomic removal, snapshots and native key custody remain separate obligations.

## Validation

Native Node Ed25519 signs fixed synthetic keys independently of the production verifier. Public-subentry tests cover malformed/truncated/noncanonical records, wrong signatures/predecessors/Org and membership proofs, duplicate/reused identities, role/device escalation, Owner survivability, non-cascading revocation and deterministic full/incremental replay. Failed batches/checkpoints preserve the preceding view. Package tests/typecheck and repository checks, including environment/baseline failures, are reported separately in the PR.

Final package: 67/67 tests and typecheck pass. Full `env -u GIT_EXEC_PATH pnpm check`, format/format check, docs and public-boundary checks pass on the pinned base. The sandbox IPC failure passed unchanged with local sockets allowed; the injected Git exec-path failure reproduced at pristine main and passed with native Git. Only the test process environment changed. Default skipped integration/Keychain tests remain unverified.

This core slice is not product security acceptance, all-platform Beta, snapshot recovery, deployment or release approval.


## Integration with content crypto

The #1417/#1418 integration resolves only overlapping package instructions, README
and draft Spec wording. It retains both content HKDF/AEAD and the separate ledger
subentry, with no protocol or source/dependency revision. Reviewed ledger source
remains byte-identical to `b273f844`; crypto remains byte-identical to `53c9e985`.
The combined package has 85 passing tests, plus passing type and format checks.
The existing independent reviews remain evidence for those source commits, not
a new-head review; integration and final-main CI are separate acceptance.
