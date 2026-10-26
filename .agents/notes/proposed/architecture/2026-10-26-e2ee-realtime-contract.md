# M5 realtime contract review

Status: proposed
Translation: current

[中文](2026-10-26-e2ee-realtime-contract.zh.md)

## Abstract

Encrypted RPC needs more than encryption: the caller must identify the intended
machine, and the machine must prevent a retry from starting a second operation.
The foundations draft now makes the candidate wire profile, response binding,
freshness acquisition and retained execution evidence reviewable. Existing
credential pairing does not sign machineId, and a verified ledger pin does not
prove freshness. Those decisions remain explicit proposals; this change opens
no product channel and grants no protocol approval.

## Decision and alternatives

Keep the existing content v0 algorithms and purposes 7/8/9, with both transports
carrying the same original frame. The [owning draft](../../../../specs/e2ee-foundations.md#realtime-rpc-and-presence-m5-review-draft)
contains the exact proposed encoding and limits rather than duplicating them here.
Fixed fields around existing method payload bytes avoid making an outer routing
JSON object authoritative or requiring a second generic RPC method system.

The machine identity alternatives are a ledger-key-derived target or a separate
signed pairing binding. The latter is recommended to retain product machine IDs
without changing ledger or credential-binding/v1. It still needs issuer,
distribution, sharing and replacement rules. For freshness, locally initiated
authenticated latest-ledger reads with restart invalidation avoid trusting sender
timestamps or inventing a persistent trusted clock. Cross-restart freshness reuse
would require a separate clock/proof design. Neither recommendation is approval.

Do not collect execution evidence at request expiry. Initially retain it; a later
bounded-retention design needs durable retired IDs and uncertainty handling.
The cost is disk growth and explicit admission refusal when capacity is exhausted.

## Source audit and integration boundary

Inspected public main `274d74a724de7bfb42c6ff0685c52c0abce7d487`:

- `packages/e2ee-core/src/internal/foundation/content-format.ts` and
  `crypto/content.ts` already separate the non-document key leaves and keep
  content v0's 143-byte overhead. `internal/content/index.ts` deliberately
  restricts `sealDocument` to document purposes; retain that restriction.
- `foundation/device-credential-binding.ts` signs genesis/session/key/credential
  hash, without machineId. `apps/electron/src/main/services/e2ee-local-pairing.mts`
  retains the machine response, but the credential proof does not authenticate
  that field for other devices. Ledger `AdmitDevice` has no machineId.
- `internal/ledger/verified-ledger.ts` proves continuity against observed history.
  CLI `lib/e2ee/runtime.ts` saves history/cache/pins, without a freshness clock.
- `apps/cli/src/session/session-dispatch-watcher.ts` stashes RPC turns by userTurnId;
  `session-dispatch-logic.ts` intentionally resumes processing turns after restart.
  A journal only around RPC reception cannot fence that durable dispatch route.
- `packages/loro-streams-rpc/src/machine-rpc-server.ts` deduplicates concurrent
  history tasks in memory; it removes them on completion. CLI
  `session-history-rpc-rejections.ts` persists selected refusals only until expiry.
  Neither is a complete execution journal.
- `session-execution-service.ts` already retains steer submission uncertainty;
  reuse that business evidence instead of replaying a submitted action. Its
  bounded in-memory terminal turn map is insufficient for persistent deduplication.

## Verification boundary

Source audit establishes the gaps above, not a shipped vulnerability in ordinary
RPC. No native iroh identity, SDK, relay/discovery configuration or platform
support choice is made. Documentation checks validate metadata and links only.
Fixed vectors, crash/I/O tests, actual authorized product execution, canary and
ordinary/encrypted latency comparisons remain separate evidence requirements.
The Spec stays draft pending explicit owner review of the relevant revision.
