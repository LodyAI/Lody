# Candidate M5 realtime body codecs

Status: proposed
Translation: current

[中文](2026-10-28-e2ee-realtime-body-codecs.zh.md)

## Abstract

The existing realtime encryption primitives and host execution journal do not
define application request or response bodies. This change implements the
candidate binary request, response, error and presence layouts as pure RPC-package
codecs, with independent Python vectors and bounded decoding. It selects no
resource encoding and opens no product channel or persisted format. Exact wire
revision approval and the shared actual-execution gate remain prerequisites for
product adoption; passing these tests does not establish working encrypted RPC.

## Responsibility and candidate decisions

Public main `76a4f28e8f22c0b405e57b731fb0a1e49c42d8a3` already supplies
purpose-specific content-v0 primitives, signed ledger machine binding and a
persistent execution journal. The
[primitives decision](2026-10-26-e2ee-realtime-content-primitives.md) deliberately
leaves application codecs to integration. The RPC package owns this pure body
codec rather than expanding `sealDocument` or adding product DTOs to the core.
No lifecycle, I/O or dependency changes are required, so no Effect migration is
introduced. Existing plain-workspace envelopes and startup remain unchanged.

The [M5 wire draft](https://github.com/LodyAI/Lody/pull/1894) supplies the field
order: version zero, fixed 16-byte IDs, safe u64 timestamps, text16 method/code,
bytes32 method payloads, and response digest/kind/u32 sequence. Response kinds
are progress, terminal success and terminal error; error payloads must satisfy
the nested code/detail codec. Method parameters, results and error details remain
exact opaque bytes for the authorized method codec. No JSON normalization occurs.

The candidate limit treats 1 MiB as the **whole sealed RPC frame**, reserving the
existing 143-byte overhead. This is stricter than the draft's 1 MiB plaintext
table and needs reconciliation in PR-25S. Presence keeps that draft's 64 KiB body
limit and positive TTL at most 60 seconds. Both encode and decode reject invalid
sizes, versions, integers, kinds and text. Advertised lengths are checked against
the remaining bounded view before copying, and returned bytes own their storage,
including for offset Node Buffer inputs. Diagnostics contain no input values.

Strict parsing is preferable to permissive JSON envelopes here: it preserves
the candidate signed bytes and rejects ambiguity before method dispatch. Changing
the core's generic content maximum would incorrectly restrict document content.
This module instead applies only the candidate realtime profile bounds.

## Remaining M5 work and independent delivery

```text
method DTO bytes -> body codec -> existing purpose-8/9 sealing
                -> retained original -> encrypted Streams (iroh later)
                -> verified authority -> shared actual-start claim
Meta/history -------------------------> same business intent and claim
```

- PR-25: these codecs finish only the body subset. Existing crypto vectors cover
  purpose/scope/signer isolation; target authority is still integration work.
- PR-25S can independently correct/review the draft. Remove obsolete old machine
  admissions without machineId and rotationRequired send/execution pauses; current
  records require machineId, and rotationRequired is advisory. Update the earlier
  code audit and preserve the durable fallback. The current latency target is at
  most one second slower than ordinary dispatch, not the plan's earlier 200 ms.
- PR-26a must connect the existing journal to the actual agent-start boundary and
  the durable Meta/history path using the same userTurnId/business intent. It
  must also enforce machine-initiated authenticated ledger freshness, memory only,
  at most 15 minutes from read start; no restart restoration or requester clock.
  Reception-only deduplication or a delivery ACK is insufficient.
- PR-26b adopts merged prerequisites from main: retained sender originals,
  encrypted Streams control/dispatch and durable fallback, including outcome
  lookup without replaying uncertain work. PR-27 then adds read/file/history
  methods with their own read permissions; PR-28 presence can proceed in parallel.
- PR-26c follows as acceleration: workspace-device Ed25519 identity reuse inside
  trusted native hosts, domain-separation review and connection fallback that
  does not delay usable Streams. No renderer private export or arbitrary signing.

Each implementation branches from main rather than a deep PR stack. Host
execution/freshness, presence and native feasibility work can proceed separately
while the draft is corrected. Private service changes and adoption remain separate
from public implementation; no backend or gitlink is changed here.

Before adoption, owner review must resolve exact bytes and the limit interpretation.
The draft's 1..128 printable-ASCII machineId also conflicts with the ledger's
1..256 strict UTF-8 bytes. Recommend a canonical lossless ASCII resource encoding
over the exact UTF-8 bytes; this module deliberately provides no scope helper.
No format is downgraded, migrated or written by this PR.

## Evidence and limits

`tests/fixtures/generate-e2ee-wire.py` uses Python's independent `struct` and
`hashlib` implementations to generate synthetic fixed vectors. The owning suite
checks exact bytes, all vector truncations, trailing bytes, unknown versions/kinds,
oversized/forged lengths, integer/text/identity bounds, exact frame-size limits,
presence TTL and buffer ownership. Temporarily accepting one extra byte makes the
frame-boundary test fail; the restored implementation passes all 24 codec tests.
The RPC package passes 181 tests with three real-gateway integration cases skipped;
the existing core realtime suite passes 19 tests. Affected package typecheck,
type-aware lint, public-boundary, formatting and docs checks pass. The full root
check is intentionally deferred in favor of affected checks.

There is no authenticated transport, sender outbox, machine freshness cache,
dispatch claim, result query, real gateway, native iroh, packaged-platform,
canary or latency acceptance in this change. This Note and the wire Spec remain
proposals, independent of code-test results.
