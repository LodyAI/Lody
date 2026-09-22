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

### Remaining implementation (not a request for new product decisions)

- [ ] Finish P1: migrate schema, crypto, policy and snapshot validation to total
      functions; keep owned internal replay updates efficient rather than cloning per record.
- [ ] Finish P2: explicit native persistent-store create/restore, full native
      snapshot bootstrap coverage and complete operation construction. `create` currently
      accepts a pre-signed genesis; this is not the final self-contained Org creation API.
- [ ] P3: bound recipient/key delivery and exact outbox; move recoverable epoch
      candidates from Lab into core; migrate content/snapshot admission and recovery.
- [ ] P4: migrate Lab `platform/{session,backup,persist,content-session,host}.ts`
      and Electron `src/main/services/e2ee-{device,user}-service.ts`; retain deliberate
      raw attack inputs only at audit/test boundaries. Remove compatibility runtimes
      and the 9 protocol bridges once no active consumer needs them.
- [ ] Complete performance gates for incremental submit, snapshot startup and
      recovery, not only full replay. Resolve baseline lint failures before claiming
      the full repository check passes. No protocol or product enablement decision is blocked.

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

### 2026-09-22 — P2 ledger vertical slice

- Foundation commit: `2ee49a54`; baseline/plan commit: `8279a396`.
- `./effect` exposes an intent client bound to Org, signer and journal, with typed
  Committed/Conflict/Pending/Unsupported/Idle outcomes. Proof/policy checks precede
  signing. `resume` refuses another signer's pending bytes. Old Promise methods
  delegate to the single `workflows/ledger-engine.ts` implementation.
- The platform lock adapter leases the existing callback transaction without a
  nested Effect runtime. Saves and lock release survive interruption. No SQLite
  synchronous transaction was changed into an async transaction.
- Cache identity is the exact persisted prefix plus snapshot/trust bytes; an
  observed prefix cannot be replaced, even at the same head. The cache extends
  only new records. Opaque verification stages bind application to the exact view.
- Core full check: 38 files / 426 tests passed, including persisted 10k, real
  signatures, old formats, snapshot attacks and cross-process recovery. Later
  signer-binding/input-capture changes: typecheck and 18 native-client + 11
  snapshot-client tests passed. The full suite preceded those last two additions.
- Lab full check: 18 files / 135 tests passed. Initial rerun exposed lost Streams
  error codes; fixed the adapter instead of changing the judge. Malformed pages
  now fail as StreamProtocolError, not Pending; programming defects remain defects.
- Four deterministic cancellation cuts surround pending save/clear. Tests reopen
  storage and confirm exactly one original record, without a new signature.
- Repeated same-machine 1000-record replay: baseline 1214.85 ms, current 1235.57 ms
  median (+1.7%, 3 warmups/10 samples each). Other performance gates remain open.
- `pnpm check` again passed all repository typechecks, then stopped at the same
  9 pre-existing Lab lint errors. Its remaining stages did not run. Scoped new-code
  lint has no errors. Formatting is scoped to this task's files.
- `check:effect-boundaries` uses the TypeScript AST to check the migrated layer
  imports, explicit throws, implicit environment calls and runtime starts. It
  reports 9 explicit legacy protocol bridges; `--complete` rejects that state.
- P0–P4 is **not complete**. Native content/keys/recovery and consumer migration
  are unimplemented work, not a human-approval blocker. Product E2EE remains off.
