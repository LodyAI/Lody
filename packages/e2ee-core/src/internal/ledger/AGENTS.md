# Public ledger workflows

Follow the package [boundary](../../../AGENTS.md) and [record/replay contract](README.md).

- Keep record domains, supported v1 operations and explicit snapshot qualification.
  No arbitrary-state authority, injected verifier or unknown-prefix skipping.
- Admission/genesis lives only in `admission.ts`; use fixed borrowed-signer
  verification and existing genuine-view proof/permission gates. Proof is consent,
  not account identity or admission. Producer genesis bytes do not prove publication,
  endpoint freshness, key durability or recovery backup.
- Preserve nullable join expiry; no new strict deadline claim or ordinary tolerance
  change. Reject obsolete RemoveMember/tag2; current tag8 removes a non-Owner member
  and activates its next epoch atomically under Owner personal authority.
- Creation borrows already retained key/identity, never generates or stores secrets.
  Capture public fields/capabilities before async work. Do not add secret byte export
  or protection callbacks without the explicitly discussed host trust boundary.
- Prepared ordinary records remain parent-relative; no implicit rebase/re-sign.
  Application Scope owns storage/network/native handles, cancellation and await.

- `LedgerFeed` retains original v1 frames and opaque offsets. Only the exact
  origin can be bound once, then explicitly rebased only after VerifiedLedger advances its pin; never skip known records or unknown snapshot
  prefixes. A separately trusted endpoint is required, not inferred from remote
  position. Persist records and cursor atomically; no progress on failure.
  Local retention budgets fail closed, without deleting committed history.
- Borrowed SDK reads propagate abort and are retained/awaited until settlement.
  Close this Scope before destroying the SDK owner. ACK/CAS and snapshot bootstrap
  remain separate contracts; no fallback append or new snapshot header.

- Ledger v1 freezes at the first production creation (see the foundations Spec);
  before that, format changes need owner approval and a regenerated vector.
  New operations need a prior tag9 capability declaration; an unsupported genuine
  declaration is `upgrade-required`, never corruption or a skipped record. No legacy-ledger
  adapters, old-state import, schema conversion or version downgrade. Current-format
  historical replay and rollback protection remain mandatory.

- I/O owners use cooperative fixed-native verification; the same pure replay owns
  authority. Persisted suffix bytes are reverified on open; a caller-owned retained v2 origin restores without replay. SQL is not authority;
  compare the verified head/count pin and current metadata point without scanning
  old rows or SQLite schema/write counters on every operation. Local OS/database
  tampering is outside the whitepaper threat model. Shared SQLite helpers own file
  creation, application/version, WAL/FULL and binding checks; unchanged pins are read-only.

- A snapshot-origin `LedgerFeed` begins only at independently qualified signed
  snapshot bytes and an explicit transport locator. Requalify on every open;
  persist exact snapshot/suffix/position together. No SQL-chosen endorser, unknown
  prefix skipping or implied snapshot-only submission authorization.
- Retained state (`exportVerifiedState`/`restoreVerifiedState`) restores only the
  caller's own export: no signature or curve-point recheck, no acceptance from
  another party, no unretained fact invented. A supplied `stateDigest` is
  recomputed from the bytes after decoding. Restore results equal full replay.
- State formats (retained envelope, snapshot body, digest body and domain) are
  versioned and current-only; changing `S` or an envelope bumps them together.
- `VerifiedLedger` is the single rollback guard: genuine view, same workspace,
  continuation of the newest observed view, containment of the durable pin.
  Unchanged pins are not rewritten; failed pin writes keep the in-memory view.

Retained origins include their source locator. A pin ahead of the restored view
must be proved by the suffix; a cache ahead of the pin is rebuildable. Equal
positions require equal heads. Rebase CAS compares the full tail and removes
covered records atomically. Verification provenance is never upgraded.
