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
idempotent recovery. SQLite 3/4 targeted tests pass; the new SDK option still
requires the coordinated release and dependency update before this consumer merges.

## Decision and scope

- State records contain only changed fields/text/array membership, anchored to
  the primary Turn ID. Reads reconstruct the full application entry. Existing
  whole-entry states remain readable within a compatible container and become deltas on their next mutation;
  sealed records and retained updates are never rewritten or pruned.
  This adds no SQLite-container migration. State projection reuses the decoded
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
- Do not change deployment, clean history, truncate WAL, merge PRs or publish
  packages. Collect the Roost fixes into one later release, update Lody's shared
  dependency catalog once, then rebase and repeat checks for dependent PRs.

## Acceptance and failure boundaries

Tests verify production SQLite projections through seal, post-seal correction, later
streaming, permission overlay, close/reopen and lost native replies. Keep a large
unchanged text fixture out of every state update and batch receipt, measuring
retained update bytes rather than WAL length. Test Unicode offsets, field
removal, nested arrays and invalid base/path data. A malformed state fails its
existing history read; it never selects a different backend or retries a write.
Journal preparation/apply failures remain SDK-owned, with no Lody recovery loop.

## Verification

The SDK implementation is [Roost #16](https://github.com/loro-dev/roost/pull/16).
Package pins remain unchanged until the consolidated release; checks below use
its locally packed build, not the currently published API.

- The two changed CLI test files pass **82 tests** on published native SQLite 3
  and **82** on native SQLite 4 with the separate
  [namespace companion #1735](https://github.com/LodyAI/Lody/pull/1735) SQL test patch.
  Cases cover legacy-state reopen/conversion, a committed first-state reply lost
  before projection, continued output, permissions, branch/input contracts,
  Unicode, field removal, invalid bases/paths and own JSON keys.
- Paired synthetic runs use Lody `7d6695c` with published SDK 0.1.3 versus this
  change with the proposed SDK. Both retain **37 updates** after sealing a
  442,368-byte unchanged body and applying 32 corrections. Update value bytes
  fall **889,477 → 4,113 (99.54%)**; the largest update falls **443,344 → 488**.
  The initial primary, outbox copy, indexes, WAL and stream transport framing are
  outside this measurement. Both runs preserve old frames, primary immutability,
  logical content and reopen after the lost reply. The checked-in regression
  enforces bounded growth, not exact protocol byte counts.
- Formatting, all package typechecks, ordinary typed lint, Effect lint, i18n
  and all eight repository boundary checks pass. The root `test:ci` run is still
  in progress at initial draft submission; its outcome is recorded before handoff.
  These checks use the proposed SDK artifact. No deployment or package publication occurred.
