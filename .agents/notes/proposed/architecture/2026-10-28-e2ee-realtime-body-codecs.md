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
table and needs reconciliation in the public wire draft. Presence keeps that draft's 64 KiB body
limit and positive TTL at most 60 seconds. Both encode and decode reject invalid
sizes, versions, integers, kinds and text. Advertised lengths are checked against
the remaining bounded view before copying, and returned bytes own their storage,
including for offset Node Buffer inputs. Diagnostics contain no input values.

Strict parsing is preferable to permissive JSON envelopes here: it preserves
the candidate signed bytes and rejects ambiguity before method dispatch. Changing
the core's generic content maximum would incorrectly restrict document content.
This module instead applies only the candidate realtime profile bounds.

## Integration boundary and public evidence

```text
method DTO bytes -> body codec [this change] -> existing purpose-8/9 sealing
                -> authenticated integration [separate work]
```

The public [wire draft](https://github.com/LodyAI/Lody/pull/1894) already describes
retained originals, machine-bound responses, freshness, one actual-start claim
shared with Meta/history, and the distinction between a dispatch ACK and business
completion. These codecs implement none of those authority or execution gates.
The public [journal decision](2026-10-26-e2ee-realtime-journal.md) likewise requires
integration at actual execution rather than reception-only deduplication.

Before product adoption, the exact wire revision and limit interpretation need
owner review. Resource encoding is deliberately absent: the public draft's
1..128 printable-ASCII machineId conflicts with the current public ledger's
1..256 strict UTF-8 bytes. No format is downgraded, migrated or written here.

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
