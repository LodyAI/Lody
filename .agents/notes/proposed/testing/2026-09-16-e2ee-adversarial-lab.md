# Replace the E2EE tutorial with a deterministic adversarial lab

Status: proposed
Translation: current

[中文](2026-09-16-e2ee-adversarial-lab.zh.md)

## Abstract

The visual tutorial adds interaction work without providing sufficiently reproducible security evidence. Replace it with deterministic honest collaborators and one attacking Agent controlling backend mutations at explicit scheduling boundaries. Keep real local Riverrun and public cryptographic/sync APIs; record attacks for LLM-free replay. This is a design proposal, not an implemented lab or proof that malicious servers cannot disrupt service.

## Decision and scope

The [specification](../../../../specs/e2ee-adversarial-lab.md) owns contracts; this note owns the single implementation tracker and append-only log. This partially replaces the [independent demo proposal](../architecture/2026-09-16-e2ee-independent-demo.md): retain backend/public-API boundaries and useful regressions, replace browser/game delivery. Honest programs are deterministic; only the attacker uses an Agent. Total-order scheduling is a testing technique, not a new protocol guarantee. Use ordinary TS pure computation, explicit capabilities and localized Effect workflows, not rewritten cryptography or a Rust controller.

## Implementation plan and single task tracker

Current state: P0–P3 accepted; P4 Agent and P5 handoff are unaccepted. Work in the existing `lody-e2ee-core` checkout on `feat-e2ee-core`. No new permanent workspace, product integration, push or merge. Any later push needs an explicit destination rather than defaulting to public origin. Detailed design stays draft; selecting a direction does not accept every implementation detail.

| Done | Stage                       | Deliverable                                             | Required gate                                                    |
| ---- | --------------------------- | ------------------------------------------------------- | ---------------------------------------------------------------- |
| [x]  | P0 Baseline                 | Versions, backup, migration inventory, baseline results | Recoverable user work and regression migration map               |
| [x]  | C1 Explicit dependencies    | Pure boundary, ports, compatibility sketch              | E1–E3; real verification parity; complete entropy/time inventory |
| [x]  | C2 Effect pilot             | Single submit/resume implementation                     | E4–E7; CAS/lost ACK/interruption/restart                         |
| [x]  | C3 Remaining workflows      | Delivery, recovery, admission, resources                | E3–E6; live authority and original expiry preserved              |
| [x]  | P1 Persistent collaboration | Lab package, real backend, three replicas               | Offline/restart durability, not one-shot read/write              |
| [x]  | P2 Determinism              | Scheduler, recording, replay                            | Three fresh-directory replays; first-divergence detection        |
| [x]  | P3 Fixed attacks            | Scenario matrix and effective judge                     | Real database mutation; known injected defects fail judging      |
| [ ]  | P4 Agent                    | Restricted API and exploration trace                    | Isolation checks; at least one real replayable Agent run         |
| [ ]  | P5 Handoff                  | Clean-checkout acceptance and old-demo removal          | Complete done criteria below; explicit unpassed items            |

### P0: Freeze the baseline without destroying evidence

1. Record HEAD, dirty files, Node/pnpm/Effect versions, lockfile and streams-crdt tarball hashes. Keep Effect 3.18.4 and Riverrun 0.3.0; upgrades need separate rationale/verification.
2. Preserve recoverable tracked/untracked demo/game work and record restore locations. Never commit real keys or run secrets. Exclude unrelated core benchmarks/tests and Electron changes from cleanup.
3. Run current core/demo typechecking and behavioral tests, recording results, skips and environment failures. Do not relabel existing failures as passes. Map each old test to its replacement, retained location or deletion rationale.
4. Inventory each effect's entrypoint, actual dependency, control mechanism and residual nondeterminism. Cover public paths and dependencies, not a wholesale legacy rewrite.

### C1: Establish small, controllable capability ports

Add tests before refactoring. Targets are `ledger/ledger.ts`, `ledger/crypto.ts`, `content.ts`, `ledger/keys.ts`, recovery/identity paths and actual `streams-fetch.ts` dependencies.

- Preserve public usage. Produce a one-page type sketch for pure/Effect entrypoints, capability ownership and live defaults. Defaults provide secure entropy and real clocks; tests explicitly replace them. Do not require ordinary callers to choose nonces.
- Move Node Worker/environment selection outside pure verification. Retained parallel adapters must match sequential outcomes/error positions for valid, invalid and nested-proof inputs, without a public verification bypass.
- Bound caches, isolate instances and allow disabling. Check result/error determinism and unchanged caller bytes/old states. Clearing owned temporary secret buffers is not an effect to remove for cosmetic purity.
- Unify clock reads and timer scheduling/cancellation. Test before/at/after expiry and clock rollback without resetting credential windows.
- Audit WebCrypto keygen, nonces, HPKE encapsulation and Loro/Flock peer IDs/clocks separately. Generated private key material may be recorded for replay, but verification/decryption still execute; never replay recorded verification verdicts instead of computation. Document unavailable injection hooks; global monkey patches do not establish a closed boundary.

Gate: public API type tests, existing crypto/ledger regressions and new boundary tests pass. Every E1–E3 source has evidence. Unresolved HPKE/Wasm entropy permits independent work but prevents checking its replay gate.

### C2: Migrate ledger submission/recovery first

Center work on `ledger/submit.ts`, `LedgerStore` and `LedgerStream`. Extract independently decidable transitions; Effect orchestrates actual operations, with thin Promise wrappers. Use controllable ports, then validate against real Riverrun.

Required cases:

1. Pending save fails: no backend append. Restart before send: resume original bytes.
2. Backend commits, ACK is lost/request interrupted: retain unknown outcome, restart/read back exactly one commit, never re-sign.
3. Two clients read one old head: actual competing CAS has one winner from that head; loser does not automatically invent a new operation.
4. Invalid record: explicit failure, no authenticated-state update or durable cursor past it.
5. Orderly cancellation releases resources; force-kill/reopen actual SQLite without finalizers repairing state.
6. Public Promise and Effect entrypoints produce identical protocol bytes, states and error semantics on the same fixtures.

Separate failure, conflict, unknown outcome, interruption and harness defects; no blanket catch-and-retry. Do not bulk-migrate the package before C2 passes.

### C3: Expand effectful workflows

- Connect used key-delivery outbox, recovery orchestration and snapshot admission to the same capabilities. Keep pure codecs/policy plain. Node filesystem/SQLite and network adapters remain real.
- Verify identical persisted key-delivery retries and historical commitments. Recovery creates a new ordinary device rather than copying an old device private key; do not expand recovery product promises.
- Revoke authority/advance time during async verification and verify final checks. Storage busy does not steal locks, lose data or renew leases. No new experimental pause between final checking and synchronous commit.
- Inject acquire/operation/release failures and cancellation; verify connection/lock/Worker cleanup and no secrets in logs. Network waits remain interruptible; short commit regions and pending recovery are treated separately.

### P1: Migrate useful demo behavior into persistent clients

Create minimal `packages/e2ee-lab` modules: `scheduler` (pure reducer), `runtime` (Effect composition), `actors`, `backend`, `attacks`, `judge`, `trace`, `scenarios`, `cli`. Do not create a separate package for each.

Each client owns persistent Loro/Flock instances, device state, storage and cursor. Separate Loro/Flock streams and peer identities for simultaneous writers. Persist documents before cursors; unresolved imports block cursor advancement/snapshot publication. Use actual Node Riverrun with honest authorization and malicious-data modes.

First run three continuous editors, reconnects and restarts; then invitations, key delivery and revocation/rotation. README defines start, scripted run and later replay commands; root commands require no UI build.

### P2: Pause, record and replay

- Register stable actor/operation/phase events. Obtain permission before starting effects; completion notifications do not establish global order. A paused actor does not prevent another from progressing; unrequested operations cannot silently write.
- Build a finite TS model of two actors, pre-commit/committed/acknowledged states and interruption/restart interleavings. Check permission-before-execution, single event consumption and no duplicate creation after unknown commits. Declare bounds and compare with C2 real behavior; this is not a crypto proof.
- Control virtual time, delivery, SDK retries and storage boundaries while executing real backend operations. Do not split existing atomic persistence into fake test transactions.
- Separate private entropy from public scenario seeds. Match random request labels/lengths, events and protocol bytes during replay; fail at first divergence. Keep client-state digests private too, avoiding dictionary attacks against low-entropy plaintext.
- Replay CAS competition, lost ACK and real ciphertext mutation in three fresh directories each. Deliberately alter one schedule/random request to prove detection is not just final-text comparison.

### P3–P5: Coverage, real Agent and handoff

P3 covers all of Spec §7 with a normal control, attack input, expected boundary and actual verdict. Test-only known defects prove the judge catches leakage, unauthorized admission and cursor overrun. Server 403 responses do not substitute for malicious-server client checks. Separately report different-head catch-up, same-position state conflict, valid historical snapshots and forks lacking independent evidence.

Before P4, verify that the Agent can access only attack APIs/restricted backend data, cannot read honest clients/private bundles and cannot modify the judge. External model unavailability blocks P4 only, not fixed attacks/replay. Budget exhaustion is neither an exploit nor a security proof. At least one actual Agent attack trace must replay without an LLM. Minimize genuine findings; otherwise report no finding in that run rather than manufacturing success.

P5 runs README and all core/lab checks from a clean checkout. Follow the P0 mapping to remove old demo/game package, exclusive dependencies, assets, commands and obsolete specs; repair links and preserve required backend/artifact provenance. Close cleanup only after behavioral coverage migration. Update scoped AGENTS/README without claiming OS isolation from Effect or total package purity.

### Commands, evidence and done criteria

Existing P0 commands: `pnpm --filter @lody/e2ee-core check`, `pnpm --filter @lody/e2ee-demo check`; run the latter before deleting the old package. Planned additions are `pnpm --filter @lody/e2ee-lab check` and README run/replay commands, not yet shipped. Also run public-entry compatibility tests, dependency-boundary checks, formatting and `pnpm run docs check`; follow root AGENTS checks before commits.

Record one concise stage summary: revision/tree identity, commands, exit codes, evidence paths, satisfied contracts and unpassed items. Raw logs live in controlled run directories, not pasted here with secrets. Distinguish environment problems, model limits and implementation defects.

Done requires E1–E8, honest collaboration/full attack matrix, at least one actual Agent run and three deterministic replays, isolation checks, public API compatibility, completed old UI/game cleanup, clean-checkout reproduction and no unresolved P0/P1. Documentation formatting is not acceptance; no mathematical security or product integration claim.

Implementers choose filenames, service names and test organization without repeated human approval. Protocol/policy/trust changes, public compatibility breaks, secret exposure or weakened gates require confirmation. Repair review findings against the same contracts rather than inventing unrelated gates. After recording blockers, complete unaffected work; push/merge or an additional human signature are not local-handoff completion requirements.

## Execution log — append entries here

### 2026-09-16 — Design recorded

- Added bilingual scope, threat boundaries, event/replay contract, interface sketch, and staged acceptance.
- Existing worktree contains uncommitted game changes and unrelated core/Electron work. No deletion, migration, implementation, commit, or push in this step.
- Confirmed old demo manifest: Riverrun 0.3.0 and file-pinned streams-crdt. Deterministic hooks and actual isolation remain to be implemented and verified.
- No finite model or security scenario executed. Documentation checks do not establish security.
- Future entries: stage, exact revision/command, discovery, constraints, plan amendments, blockers/decisions, result. Never append private keys, secret replay bundles, or captured Agent transcripts.

### 2026-09-16 — Core side-effect inventory for Effect discussion

- Source inspection, not executed security validation: `ledger/ledger.ts` automatically selects Node workers for batches of at least 32 jobs using process/environment detection; this is not a strictly pure execution boundary despite the stated pure-ledger intent. `extend` clones state and applies deterministic verification/policy locally. `ledger/crypto.ts` also has a module-global point cache and assigns the noble hash implementation.
- `content.ts` injects part of its crypto platform but invokes live authorization before/after asynchronous work. `ledger/keys.ts`, recovery-file/device and user-identity functions still use ambient randomness/native key generation; HPKE encapsulation needs its own dependency audit. A generic Effect wrapper does not capture these internals.
- `LedgerClient` already receives storage and stream ports. Snapshot admission receives clock, authority and storage. `streams-fetch.ts` injects `now` and fetch but still uses global timers. Node stores own real SQLite/filesystem effects.
- Proposed direction: keep encoding/hash/policy as ordinary deterministic functions; make worker selection/cache ownership explicit; centralize crypto entropy, clock/timers and live authority dependencies; consider Effect for submission, delivery, admission and resource lifecycle. Preserve commit-unknown recovery, pending-before-send, final permission checks and synchronous check/commit boundaries. Do not insert an asynchronous scheduling point between a final authorization check and the operation it guards.
- No Effect migration or API change performed. Agreement on the scope/public API precedes implementation; no protocol changes or production-default deterministic randomness are implied.

### 2026-09-16 — Effect direction selected and plan expanded

- Recorded ordinary TS pure computation, explicit capabilities and localized Effect orchestration as Spec E1–E8 without changing protocol/trust guarantees.
- Added C1–C3 core stages within the existing P0–P5 sequence and moved the single tracker here. Validate submit/resume before expansion. Earlier logs remain historical; this entry supersedes the old allocation of task tracking to the spec.
- Documentation changes only; all implementation boxes remain unchecked. Finite-model, behavioral and replay validation belongs to those stages and has not been claimed as passed.

### 2026-09-17 — Preserve useful leftovers and clean the worktree

- Backed up the entire dirty tree, including untracked files, in local Git stash `5d04e3d42f173c7631afdcbe5f2426979ffdd31a` (`backup/e2ee-workspace-cleanup-2026-09-17`). Removed unfinished game changes, unrelated Electron formatting and incidental lockfile changes from the working tree; the stash remains recoverable. The committed demo baseline stays until its behavioral coverage is migrated in P5.
- Retained the public LedgerClient 10k persistence/capacity regression, policy-model correspondence corrections, and benchmark sources/Wasm fixtures already referenced by the README and package command. Removed source-string assertions while retaining behavioral checks. Corrected the probe's SIMD claim: runtime support/build markers do not prove SIMD execution or core-verifier equivalence. The withdrawn 100ms gate stays withdrawn.
- Validation: core `check` passed (34 files, 372 tests; 10k test about 130 seconds). After cleanup edits, the correspondence test passed again and the backend probe ran with `--n=32`, including workers. Core package formatting passed. Root `pnpm check` passed typechecking but stopped at an existing unused `Server` import in `packages/e2ee-demo/src/host.ts`; the subsequent repository-wide tests were not run by that command. No product enablement, Effect migration, lab implementation, push or stage acceptance is implied.

### 2026-09-17 — P0 baseline freeze

- HEAD `5bd0e60ebf9770316f27587d68726c25915b8fec`, design baseline `0bf0fc24`, branch `feat-e2ee-core`. Working tree was clean at the start of this stage. Node v24.21.0, pnpm 10.20.0, Effect catalog 3.18.4, demo Riverrun 0.3.0. lockfile SHA-256 `eb169cb2ef2fcc13de10e18c43938fa11456c1993e2fee529870c14060503f1c`; `packages/e2ee-demo/vendor/streams-crdt.tgz` SHA-256 `a1314d8fbfaed381505001342d563993ae1f32c0682d9db8252c6f6eb97a391e`.
- Recoverable backup remains stash `5d04e3d42f173c7631afdcbe5f2426979ffdd31a` (`backup/e2ee-workspace-cleanup-2026-09-17`). Raw command output lives in `.agents/runs/e2ee-lab/p0/` (gitignored).
- Baseline commands: `pnpm --filter @lody/e2ee-core check` exit 0 (34 files / 372 tests). `pnpm --filter @lody/e2ee-demo typecheck` exit 0; `pnpm --filter @lody/e2ee-demo test` exit 0 (41 passed, 2 skipped: `d2-browser` needs `LODY_E2EE_DEMO_BROWSER=1`). Existing failures were not relabeled as passes. Root `pnpm check` still hits the unused `Server` import in `host.ts` and the `Inspector.tsx` shadowing lint; this stage does not change unrelated UI.
- Old-test map: keep `d0-start` / `d1-control` / `d2-invite` / `d3-content` / `d4-revoke` / `d5-matrix` / `browser-persist` until P1/P3 lab coverage; delete `d2-browser` / `ui-session` with the UI in P5; migrate `pin` into the lab if it still constrains the host, otherwise delete with rationale; move real Riverrun/host helpers from `helpers.ts` into `packages/e2ee-lab/backend`. Unrelated Electron/core benches stay out of cleanup.
- Effect inventory (public paths): `Ledger.verify` used to auto-parallelize via `process.env` / `worker_threads`; `crypto.ts` had a module-level point cache; `keys.ts` / `recovery-file.ts` used `crypto.getRandomValues`; `user-identity` / `recovery-device` used WebCrypto `generateKey`; `streams-fetch.ts` used global `setTimeout`; `content.ts` and snapshot admission already inject platform/clock. HPKE `@hpke/core` 1.9.0 DHKEM ephemeral keys are not injectable; Loro/Flock peer/Wasm clocks are library-internal and wait for P1. noble `hashes.sha512` module init is not a public verification bypass.

### 2026-09-17 — C1 explicit capability ports

- Type sketch: `packages/e2ee-core/src/capabilities.ts`. Pure entrypoints: `Ledger.verify` / `extend` / `prepare`, codecs, hashes, policy. Capabilities: Entropy, Clock, TimerSchedule, CryptoPlatform, SignatureVerifyExecutor, SigningPointCache. Defaults: `liveEntropy` / `liveClock` / `liveTimerSchedule` / `sequentialSignatureVerify`. Node parallelism: `createNodeSignatureVerifyExecutor` (`./ledger-node`). Effect entrypoints are reserved for C2 submit/resume. Callers do not pick nonces.
- Behavior: `Ledger.verify` is sequential by default and no longer reads `LODY_E2EE_VERIFY_WORKERS`. Caches are per-instance, disableable and bounded. `sealHistoryPacket` / `createRecoveryFile` / `sealRecoveryBackup` take Entropy; `createBoundedStreamsFetch` takes `scheduleTimer`; identity/recovery-device generation takes CryptoPlatform.
- Evidence: `test/capabilities-boundary.test.ts`; `pnpm --filter @lody/e2ee-core exec vitest run --exclude test/ledger-long-chain.test.ts` exit 0 (34 files / 377 tests). Public consumer plus existing keys/streams/freshness/ledger tests passed. Unresolved: HPKE encapsulation entropy and Loro/Flock Wasm entropy/clocks; those replay gates stay unchecked. Product E2EE is not enabled; no push/PR. `test/ledger-long-chain.test.ts` later exited 0 after C1 (~110s).

### 2026-09-17 — C2 submit/resume Effect loop

- Kept Effect 3.18.4 from the catalog and added it to `@lody/e2ee-core`. Pure decisions live in `submit-decision.ts`. `LedgerClient.submit` / `resume` are `runPromise` wrappers over the same `submitSteps`. Pending persist is `Effect.uninterruptible`; the CAS wait is interruptible. The Promise `LedgerStore.exclusive` adapter still uses one inner `runPromise`; that is not a per-request runtime and not a second submit path.
- Required cases: pending save failure does not CAS; a post-persist save fault keeps the original bytes and resume commits them; a false ACK keeps pending without re-signing; only one of two CAS clients wins; a bad page does not advance the cursor; SQLite kill-and-reopen keeps pending/releases the lock (existing node-store tests); Promise and Effect submit of the same record share status and protocol bytes.
- Evidence: `pnpm --filter @lody/e2ee-core exec vitest run --exclude test/ledger-long-chain.test.ts` exit 0 (381 tests); `pnpm --filter @lody/e2ee-demo test` exit 0 (real local Riverrun, 41 passed / 2 skipped browser).
- Limits: interrupting the outer Fiber does not abort an `appendCas` Promise already inside `exclusive` (E6: interrupt is not withdraw). HPKE/Wasm entropy remains uninjected. No lab scheduler yet. Product E2EE is not enabled.

### 2026-09-17 — C3 delivery/admission on the same capability ports

- `LedgerKeyDelivery.send` and `sendEffect` share one implementation. The Promise entry uses `runPromiseThrow` so callers still see `LedgerError` rather than FiberFailure. Exact-ciphertext retry, second-authorize refusal, and post-revoke non-delivery: existing delivery tests plus Promise/Effect parity.
- Snapshot admission already injects `now`; clock advance during verify does not extend the original lease: `test/snapshot-admission.test.ts`. Recovery file/device use C1 CryptoPlatform/Entropy; two-process restore: `test/ledger-recovery-process.test.ts`. SQLite busy/kill: existing publication/node-store tests.
- Evidence: `pnpm --filter @lody/e2ee-core exec vitest run test/ledger-delivery.test.ts test/ledger-submit.test.ts` exit 0. Recovery remains a thin Effect wrapper over the Promise adapter, not a second simulated path. No cross-stream transactions.

### 2026-09-17 — P1 lab package and persistent three-client collab

- Added `packages/e2ee-lab`. The first backend/actors reuse `@lody/e2ee-demo/host` and `DemoSession` (real sqlite Riverrun). The scheduler currently records events and does not perform I/O; pause/permit is P2.
- `test/collab-baseline.test.ts`: Alice creates a space, Bob/Carol join the ledger, Alice/Bob edit a real Loro document, Bob reconnects with the same clientDir/device, the host restarts on the same dataDir, Alice/Carol reread membership and the document. `pnpm --filter @lody/e2ee-lab check` exit 0 (2 files / 2 tests).
- Limits: Carol does not yet receive epoch keys/content writes (multi-envelope page splitting is later). The lab still depends on the demo host until P5. No replay, no attack Agent, product E2EE not enabled.

### 2026-09-17 — P2 permit scheduling and event-shape replay (unchecked)

- Scheduler is now `request → permit → complete`. Unpermitted events cannot run; only one event may be permitted; each event is consumed once. Bounded two-actor submit exploration `exploreSubmitInterleavings` passes. `firstDivergence` reports index 0 when the actor is changed.
- `test/replay-cas.test.ts` runs a real Riverrun CAS race in three fresh data directories; event shape matches and a mutated schedule is the first divergence. `pnpm --filter @lody/e2ee-lab check` includes this test in the pending commit.
- P2 stays unchecked: honest client keygen still uses live entropy, so protocol bytes cannot replay from a public seed alone. Lost-ACK and ciphertext-tamper three-directory byte replay are not done. DemoSession does not yet take lab Entropy.

### 2026-09-17 — P3 judge and live control tamper start (unchecked)

- `judgeImport` reports `violation` when a defective importer accepts an invalid record. `appendControlRecord` posts a tampered signature to the real host; the backend refuses and ledger length stays 1. `pnpm --filter @lody/e2ee-lab exec vitest run test/attacks.test.ts` exit 0.
- P3 stays unchecked: Spec §7 full matrix, offline Riverrun mutation, injecting a defect into the verify path, and malicious-server fork reporting are not done.

### 2026-09-17 — P2 protocol-byte replay accepted

- DemoSession gained optional `entropy` / `fetch`; production still defaults to live entropy and global fetch. `LabRuntime` gates `append-cas` and uses explicit permits for CAS order; a paused actor does not block permitting the other.
- Private replay material: exported device PKCS8, labeled entropy fills, protocol request bytes. The public scenario seed is not mixed into keys. Replay imports devices and replays entropy; verification/decryption still execute.
- Evidence: `pnpm --filter @lody/e2ee-lab test` exit 0 (7 files / 14 tests). `test/replay-bytes.test.ts` replays CAS (same winner head and frames), lost-ACK resume, and stopped-host Riverrun sqlite XOR in three fresh directories; changing actor/request bytes/entropy reports `firstReplayDivergence`. `test/runtime-permit.test.ts`: Alice is permitted first, Twin conflicts. Finite model vs C2: after unknown CAS the next step is ack/resume, not a new pending.
- Limits: HPKE encapsulation entropy is still uninjected, so HPKE envelopes are outside this replay set. In-process tests do not use `kill-after-commit` (it would kill the test process); that path remains covered by demo D5 spawn. Product E2EE is not enabled.

### 2026-09-17 — P3 Spec §7 matrix and real DB mutation accepted

- `test/matrix.test.ts` records control, attack, expected boundary and verdict: known defective importer → `violation`; host signature reject; malicious-server direct Riverrun write (not a 403 stand-in); unauthorized device; lost ACK; plaintext scan; revoke; recovery-backup tamper; snapshot identity conflict; forged compare note; fork without independent evidence → `outside-model`; stopped-host sqlite XOR.
- Evidence: same lab test exit 0; `pnpm --filter @lody/e2ee-demo test` exit 0 (41 passed / 2 skipped browser).
- P4 real Agent is not done. The lab still depends on the demo host until P5.
