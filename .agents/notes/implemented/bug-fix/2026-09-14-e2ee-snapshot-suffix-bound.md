# Snapshot suffix must fail closed on every non-extending record

Status: implemented
Translation: current

[中文](./2026-09-14-e2ee-snapshot-suffix-bound.zh.md)

## Abstract

Snapshot refresh may skip stream prefix until the attested head is observed. After that bound, the suffix is a hash chain: a record that does not extend the attested head must fail closed without advancing the journal cursor. `64aff08` closed ordinary wrong-parent skips. A later genesis `continue` still skipped a foreign Org genesis after a valid snapshot read and then advanced the cursor. Refresh now rejects foreign genesis and duplicate already-known hashes after the bound; prefix skip and empty final pages stay authorized.

## Decision and scope

The bound is in-memory during a page and persisted as journal `snapshotBound` only after a successful page that located the head or applied a suffix. Failure does not save that page: offset, records, and pending bytes stay as they were. Genesis-from-zero clients still skip hashes they already verified. v1 journals without the optional eighth `true` remain readable.

This does not change snapshot trust (DEC-001), Passkey/phone acceptance (DEC-002), production CAS, or content-snapshot provenance.

## Evidence and alternatives

Independent input: valid `openFromSnapshot`/`read`, append another Org genesis, `read` again. On `64aff08` the second read resolved and the cursor moved past the foreign record. Expected: `wrong-parent`, cursor unchanged. Ordinary wrong-parent regressions still passed.

Dropping every `continue` would reject the honest prefix on the first snapshot page. Keeping an unconditional genesis skip reopens the hole. Distinguishing `wasBound` keeps prefix skip and fails closed afterward.

Regressions: `test/ledger-snapshot-client.test.ts` (same-page, cross-page, restart, missing boundary, empty final pages, bad record then valid suffix, duplicate known hash) and sqlite v1 7-tuple compatibility in `test/ledger-node-store.test.ts`. Lost ACK and exact-byte CAS remain in `test/ledger-submit.test.ts`.
