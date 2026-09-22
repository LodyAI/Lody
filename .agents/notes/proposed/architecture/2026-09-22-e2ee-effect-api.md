# E2EE Effect API migration and acceptance

Status: proposed
Translation: current

[中文](2026-09-22-e2ee-effect-api.zh.md)

## Abstract

This work follows the confirmed plan to separate active E2EE modules into pure
computation, Effect workflows, and platform implementations. It aims to prevent
argument confusion, expose expected failures, and let the client own persistence
and retry ordering, not promise infallible networking. Protocol bytes, disk formats,
and authorization rules stay unchanged. Incomplete stages are not accepted or
production E2EE enablement.

## Scope and constraints

- Baseline: `d7d3b7c6c0e150678eb8d4d0a1f1bd675655dc69`; Effect 3.18.4.
- Experimental API changes are allowed; migrate active consumers. Isolate the
  JSON/hex prototype rather than implement the protocol twice.
- Validated opaque keys/signatures/hashes/records own copies at boundaries.
- Pure functions return values or Either; workflows expose specific Effect errors;
  platform implementations own effects.
- Every active non-recovery device may forward the current epoch key. Forwarding
  does not grant management, content-write, or snapshot-endorsement authority.
- Preserve exact pending-before-CAS, no conflict re-signing, epoch-candidate recovery,
  original snapshot leases, and valid historical snapshots.
- No cross-stream transactions, snapshot trust changes, or production enablement.

This replaces the public Promise compatibility constraint of the
[historical Lab plan](../testing/2026-09-16-e2ee-adversarial-lab.md), not its attack
scenarios or protocol acceptance requirements.

## Stage tracker

| Stage                     | Status      | Deliverable and gate                                                                       |
| ------------------------- | ----------- | ------------------------------------------------------------------------------------------ |
| P0 Contracts and baseline | In progress | Exports/consumers, old data, acceptance; unchanged protocol                                |
| P1 Pure computation       | Partial     | Opaque types and Either CBOR landed; schema/policy/snapshot still use the legacy validator |
| P2 Ledger workflows       | Partial     | One intent/compatibility engine; remaining API and storage lifecycle gates are open        |
| P3 Other active modules   | Not started | Delivery, rotation, content, snapshots, backup and persistence lifecycle                   |
| P4 Migration and closure  | Not started | Consumers, docs, remove bridges, full checks and performance comparison                    |

## Acceptance

- Reject wrong key types, unverified records, invalid device-management shapes,
  and non-exhaustive outcomes at compile time.
- Ordinary consumers do not assemble signatures, parents, nonces or CAS offsets;
  public error channels are not unknown.
- Bind evidence to actual views; reject equal-head/different-state, cross-Org and
  stale authorization reuse.
- Mutating input/output arrays cannot change internal state. Constructing an
  Effect performs no I/O.
- Faults at persistence/CAS/readback boundaries preserve pending bytes, signatures,
  and epoch candidates.
- Read existing records, journals, envelopes and backups; retain real cryptography
  and the existing Lab judge.
- Compare 1000 records on the same machine, 10 runs after warmup; fix median
  regressions over 20%.
- Run typechecks, core/Lab tests, docs/import-boundary checks before completion.
  The withdrawn 10k/100ms target is not reinstated.

## Work log (append only)

### 2026-09-22 — Start

- HEAD matches the plan. Preserve unrelated untracked research and Agent configs.
- Documentation status has no errors (37 existing size warnings).
- Active export closure includes ledger, content, streams-content, snapshot-admission,
  recovery-file/device, user-identity and their Node stores. Consumers include core
  tests/benchmarks, Lab and Electron device/user services.
- Incomplete stages are not verified guarantees; append actual commands, results
  and commits as work progresses.

### 2026-09-22 — P0 baseline execution

- Core `node node_modules/vitest/vitest.mjs run`: 35 files, 405/405 passed,
  including the real 10k journal persistence/restart test (about 137 seconds).
- `pnpm check`: repository typechecks passed; lint stopped at 9 existing errors
  in Lab minimize, driver, repro-pack and attack-lab. Later tests/boundary checks
  in that command did not run.
- P1 opaque bytes, specific errors and Either CBOR started; active entrypoints
  remain unchanged and P1 is not accepted yet.

### 2026-09-22 — P1 foundation slice

- Private constructors and defensive byte copies distinguish signing/encryption keys,
  signatures, genesis/record hashes, member/request/user IDs and epoch numbers.
  A brand does not skip parsing. Verified records/views have private state.
- Moved CBOR to one Either implementation. `ledger/cbor.ts` temporarily unwraps
  it for existing protocol callers; it is not a second codec. Shared compatibility
  errors no longer require platform code to import the JSON/hex protocol.
- Type-negative cases reject swapped keys, raw bytes, fabricated verification,
  and machine/recovery management flags. State inspection is a defensive copy.
- The foundation is not the complete P1: schema, crypto, policy and snapshot
  validators still need their total-function migration. New workflows use an
  explicitly temporary typed-error bridge, not a claim that old throws vanished.
- Same 1000-record fixture, baseline replay median 1233.40 ms, first post-CBOR
  replay median 1260.15 ms (+2.2%, 3 warmups/10 measurements). This does not
  satisfy the remaining increment/snapshot/recovery performance gates.
