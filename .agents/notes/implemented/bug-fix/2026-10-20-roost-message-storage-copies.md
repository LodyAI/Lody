# Roost message copies in state and batch receipts

Status: implemented
Type: bug-fix
Translation: current
Date: 2026-10-20

[中文](2026-10-20-roost-message-storage-copies.zh.md)

## Abstract

Post-seal corrections copied an entire message into state and SDK command
receipts. State now contains operations relative to its exact sealed primary;
the execution owner uses Roost's local batch recovery journal. A synthetic
432 KiB unchanged body with 32 corrections retained 4,113 update bytes instead of
889,477, preserving the sealed primary, logical reads, legacy state reads and
idempotent recovery. The consumer now uses published Roost 0.2.0 through the
dependency update in #1735; older SQLite containers are not migrated or reset.

## Decision and scope

- State records contain only changed fields/text/array membership, anchored to
  the primary Turn ID. Reads reconstruct the full application entry. Existing
  whole-entry states remain readable within a compatible container and become deltas on their next mutation;
  sealed records and retained updates are never rewritten or pruned.
  This adds no SQLite-container migration. Reopening delta state requires this
  adapter or newer; RPC readers still receive complete logical entries. State projection reuses the decoded
  primary, and incremental state generation converts operation offsets without
  serializing the accumulated text or unchanged body again.
- Local batch plans and compact pending receipts are prepared atomically by the
  SDK; effects, publication, final seal and plan retirement commit atomically.
  The CLI owns the full database. Turn exports synchronize committed history;
  moving unfinished local work requires that database, including the journal.
  The existing SDK replicated recovery default remains available to other hosts.
- This replaces part of the earlier
  [write-amplification decision](2026-10-16-roost-storage-write-amplification.md),
  not the guarded native streaming path, immutable human input or branch saga.
- Consume the coordinated Roost 0.2.0 release through the dependency update
  in [#1735](https://github.com/LodyAI/Lody/pull/1735), then merge #1737 after it.
  Native 0.2.0 requires SQLite container v4. Do not deploy, migrate/reset databases,
  clean history, truncate WAL, merge PRs or publish packages in this change.

## Acceptance and failure boundaries

Tests verify production SQLite projections through seal, post-seal correction, later
streaming, permission overlay, close/reopen and lost native replies. Keep a large
unchanged text fixture out of every state update and batch receipt, measuring
retained update bytes rather than WAL length. Test Unicode offsets, field
removal, nested arrays and invalid base/path data. A malformed state fails its
existing history read; it never selects a different backend or retries a write.
Journal preparation/apply failures remain SDK-owned, with no Lody recovery loop.

## Verification

The consumer implementation is [Lody #1737](https://github.com/LodyAI/Lody/pull/1737);
the SDK implementation is [Roost #16](https://github.com/loro-dev/roost/pull/16).
The branch is rebased on [#1735](https://github.com/LodyAI/Lody/pull/1735), using
published SDK and Native 0.2.0 with exact lockfile versions and no local override.
The earlier SDK 0.1.3 `TS2554` release gate is resolved by this dependency update.

- The two owning CLI test files pass **82 tests** on published Native SQLite v4.
  Cases cover legacy whole-message state reopen/conversion, a committed first-state
  reply lost before projection, continued output, permissions, branch/input
  contracts, Unicode, field removal, invalid bases/paths and own JSON keys.
- Earlier paired synthetic runs compare Lody `7d6695c` with SDK 0.1.3 against this
  change with the proposed SDK. Both retain **37 updates** after sealing a
  442,368-byte unchanged body and applying 32 corrections. Update value bytes fall
  **889,477 → 4,113 (99.54%)**; the largest update falls **443,344 → 488**. The initial
  primary, outbox copy, indexes, WAL and stream transport framing are excluded.
  Both preserve old frames, primary immutability, logical content and reopen after
  the lost reply. The current regression enforces bounded growth, not exact wire bytes.
- Complete `pnpm check` passes with the published packages, including all package
  typechecks, ordinary typed lint, Effect lint, repository tests, i18n and boundaries.
  The full CLI suite passes **4,435 tests with four existing skips**. Repository
  formatting and documentation checks pass with no documentation errors.
- The public CLI builds at a **2 GiB heap limit** and passes its published-bundle
  runtime/Worker probes. Desktop CLI staging succeeds; the actual Electron runtime
  writes, verifies and reopens signed SQLite history through the staged Native
  Worker. The four staging tests cover all six target selections with synthetic
  foreign bindings and execute the installed host binding. This is not a local GUI
  E2E run or execution of foreign-platform binaries; standard PR CI is rerun.

Merge #1735 before #1737. No application database, deployment or package publication
was changed during this acceptance.
