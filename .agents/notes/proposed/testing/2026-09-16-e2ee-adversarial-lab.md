# Replace the E2EE tutorial with a deterministic adversarial lab

Status: proposed
Translation: current

[中文](2026-09-16-e2ee-adversarial-lab.zh.md)

## Abstract

The visual tutorial added interaction work without providing sufficiently reproducible security evidence. The replacement is implemented in `packages/e2ee-lab`: deterministic honest collaborators, one attacking Agent on a capability-only AttackLab, real local Riverrun, and LLM-free replay. This note remains proposed until review. It is not a proof that malicious servers cannot disrupt service, and product E2EE is not enabled.

## Decision and scope

The [specification](../../../../specs/e2ee-adversarial-lab.md) owns contracts; this note owns the single implementation tracker and append-only log. This partially replaces the [independent demo proposal](../architecture/2026-09-16-e2ee-independent-demo.md): retain backend/public-API boundaries and useful regressions, replace browser/game delivery. Honest programs are deterministic; only the attacker uses an Agent. Total-order scheduling is a testing technique, not a new protocol guarantee. Use ordinary TS pure computation, explicit capabilities and localized Effect workflows, not rewritten cryptography or a Rust controller.

## Implementation plan and single task tracker

Current state: HEAD `02b3f473`. This increment: second security review. Do not re-implement D1–D8. No Lody product integration, no push/PR/merge. Protocol/wire changes stay proposals.

| Done | Stage | Gate |
| ---- | ----- | ---- |
| [x] | S1 compareNotes same-head conflict | Same genesis+head with different length/digest is conflict; catch-up stays pending-sync; real signed snapshots |
| [x] | S2 independent evidence | independent requires out-of-band confirmed signers; not a different key or snapshot member list |
| [x] | S3 epoch candidate before CAS | Persist candidate+exact record before CAS; resume/restart without regenerating; losing candidate is not current |
| [x] | S4 possession binding | Reproduce mis-binding; proposal only; no v1 wire change |
| [x] | S5 epoch u32 / snapshot resources / verify-before-import | Reject truncating epochs; bound snapshot length; signature before expensive import |
| [x] | S6 classify remaining | Admin history-packet, canManage, openJournal, Convex, HKDF/X25519/legacy, Lean/product |

The D1–D8 table below is the previous round; checkmarks stay as historical evidence.

Current state: HEAD `04b90b58` plus this round's helper/expiry/judge-test follow-up. Targeted fixes for design-probe defects 1–6 and 8. Atomic guest admission (item 2 protocol) and stale-epoch upload (item 7) stay pending decisions; do not change wire. No Lody product integration, no push/PR/merge.

| Done | Stage | Gate |
| ---- | ----- | ---- |
| [x] | D1 Ordinary vs harness plane | `/readyz` has no Riverrun/path; NOW_HEADER and unauthenticated failpoints cannot move the host; harness token/DI still can |
| [x] | D2 approveJoin partial success | Second-step failure is not reported as Guest/Admin complete; pending preserved; not atomic guest admission |
| [x] | D3 Join expiry at host admit | Non-null `expiresAt` rejected at trusted admit; lost-ACK retry of a pre-expiry commit still identifies; verify stays timeless |
| [x] | D4/D5 Historical judge | Demoted authors keep legal history; Loro+Flock; imported facts not backend-decrypt; unknown is unmeasured |
| [x] | D6 Unauth existence | Unauthenticated known vs unknown space do not 401/404-split |
| [x] | D8 Admin ∩ canManage | Helper does not imply join device can manage; explicit manage device can; machines cannot |
| [x] | D2/D7 decisions | Written proposals only; no wire change |

The R0–R7 table below is the previous round; checkmarks stay as historical evidence.

Current state: HEAD `4989fad8` plus preserved dirty tree (host gateway, judge, design probes). Previous unique goal: independent reproduction packs. No Lody product integration, no protocol redesign, no push/PR/merge. The lab spec stays draft.

| Done | Stage | Gate |
| ---- | ----- | ---- |
| [x] | R0 Baseline | HEAD/dirty tree recorded; existing gateway/judge work kept; this unique table |
| [x] | R1 Event-driven execution | Every permit is logged; auto-advance is oldest-runnable FIFO; identity `ScheduleDriver` controls explicit concurrent choice; leftover requested events report `schedule.extra` |
| [x] | R2 Independent pack | `e2ee-lab-repro/v1` binds dirty-tree hash, vendor/lock hashes, private 0700 bundle; new-process CLI replay; missing private/unsupported format fail closed; entropy `remaining()` must be empty |
| [x] | R3 Precise compare | Multipart normalizes delimiter tokens only; fingerprints include rule ids; mutating order/payload/entropy tail/verdict each locates a field |
| [x] | R4 Real backend | SIGKILL crash matrix retained; power-loss of unflushed SQLite pages is not modeled |
| [x] | R5 Independent judge | Lab reference model does not import SUT policy functions; skip-verify, cursor-before-document, and wrong-context journal are real-path defects |
| [x] | R6 Minimize | Bounded ddmin drops noise, keeps the same security fingerprint, rejects harness-error shrinks |
| [x] | R7 Real-model hit | Destructive hit is intercept or mutateBackend only; observe/readBackend/submitClaim/finish do not count |

The S1–S4 table below is the previous round; checkmarks stay as historical evidence.

| Done | Stage | Gate |
| ---- | ----- | ---- |
| [x] | S1 Ongoing-collab control | Create/invite/key-delivery/alternating Loro+Flock edits/Bob offline-edit reconnect/Carol mid-join reads history/revoke+epoch rotation/snapshot bootstrap/lost-response recovery/process crash+restart/host restart convergence — all fixed-script, no attack |
| [x] | S2 Boundary fixed attacks | Attacker intercepts/reads/mutates/claims at recorded event boundaries while collaboration is in flight; checkable hit evidence (frame status, receipts, affected outcomes) |
| [x] | S3 Three-directory replay | The same attack record replays model-free in three fresh dataDir/clientDir sets under identical private material; first divergence across events/frames/client digests/verdicts is located |
| [x] | S4 Real-model intervention | At least one real model run launches an actual attack during collaboration (not only observe/finish) that lands; the same record replays model-free consistently |

The tables below are earlier stage records; checkmarks are backed by per-stage log evidence.

| Done | Stage | Gate |
| ---- | ----- | ---- |
| [x] | A Judge observations | Legal admitDevice is not a violation; backend extra + client reject is not client integrity loss; missing client facts → harness-error; guest content under malicious Riverrun → outside-model |
| [ ] | B Real persist | document-persisted writes doc bytes; cursor-persisted writes cursor after doc; crash/restart does not skip unread data |
| [ ] | C Same-attack replay | Successful xor needle hits again under restored private material; mutated receipt/bytes report first divergence |
| [ ] | Effect compose | One submit/delivery Effect; Promise wrap only; cancel does not drop pending |
| [ ] | Schedule delivery | Reads/writes/persist/result delivery wait for permits; waiters cleared on pause/cancel |
| [ ] | Cache/env | Per-instance SigningPointCache; undocumented clocks/Wasm listed as replay limits |

| Done | Stage                       | Deliverable                                             | Required gate                                                    |
| ---- | --------------------------- | ------------------------------------------------------- | ---------------------------------------------------------------- |
| [x]  | P0 Baseline                 | Versions, backup, migration inventory, baseline results | Recoverable user work and regression migration map               |
| [ ]  | C1 Explicit dependencies    | Pure boundary, ports, compatibility sketch              | E1–E3; real verification parity; complete entropy/time inventory |
| [ ]  | C2 Effect pilot             | Single submit/resume implementation                     | E4–E7; CAS/lost ACK/interruption/restart                         |
| [x]  | C3 Remaining workflows      | Delivery, recovery, admission, resources                | E3–E6; live authority and original expiry preserved              |
| [ ]  | P1 Persistent collaboration | Lab package, real backend, three replicas               | Offline/restart durability, not one-shot read/write              |
| [ ]  | P2 Determinism              | Scheduler, recording, replay                            | Three fresh-directory replays; first-divergence detection        |
| [x]  | P3 Fixed attacks            | Scenario matrix and effective judge                     | Real database mutation; known injected defects fail judging; guest content → outside-model |
| [x]  | P4 Agent                    | Restricted API and exploration trace                    | Isolation checks; at least one real replayable Agent run         |
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

Shipped commands: `pnpm --filter @lody/e2ee-core check`, `pnpm --filter @lody/e2ee-lab check`, plus README `scenario:collab` / `replay` / CLI. Root aliases: `pnpm test:e2ee-lab`, `pnpm lab:e2ee`. The old `@lody/e2ee-demo` package is removed. Also run public-entry compatibility tests, dependency-boundary checks, formatting and `pnpm run docs check`; follow root AGENTS checks before commits.

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

### 2026-09-17 — P4 restricted AttackLab and replayable Agent run accepted

- `createAttackLab` is the Agent/CLI Promise boundary over one Effect implementation. Expected plaintext and client directories live in a WeakMap; `observe` returns public events, genesis hex, backend size and error categories only. Isolation is this capability handle, not two processes, directory prefixes, prompts, or an OS container. Effect is not a sandbox.
- Isolation self-test: `JSON.stringify(lab)` is `{}`; enumerable own names are the eight methods plus `actions`; observe JSON contains neither expected plaintext nor `clientDir`; unknown `eventId` throws `invalid-event`; a missing xor needle returns `{ok:false}`.
- Real Agent run: this session used only AttackLab. `exploreAttackLab` observes, reads Riverrun, scans ASCII, xors 16 bytes after the sqlite header if no leak, then submits a wrong plaintext claim. This round found none (`confidentiality: pass`). `replayAttackActions` replays the recorded log without an LLM and matches the public verdict. `XAI_API_KEY`/`GROK_API_KEY` were unset; no external model was called.
- Evidence: `test/attack-lab.test.ts`. `pnpm --filter @lody/e2ee-lab check` later recorded with P5.

### 2026-09-17 — P5 handoff, old-demo removal, README reproduce accepted

- Host/session/device/persist/backup moved to `packages/e2ee-lab/src/platform/`. Vendor tarball SHA-256 `a1314d8fbfaed381505001342d563993ae1f32c0682d9db8252c6f6eb97a391e`. `git rm -r packages/e2ee-demo`; leftover UI file serving removed from the host. Root scripts `lab:e2ee` / `test:e2ee-lab`. Wire/compat strings `x-e2ee-demo-*` and `e2ee-demo-backup/v2` stay as protocol constants.
- P0 test map: `pin` → `test/host-lifecycle.test.ts` tarball pin; `d0-start` → healthz/restart/CLI SIGTERM/kill-after-commit; `d1-control` → unjoined POST/DELETE plus collab genesis and matrix unauthorized; `d2-invite` → `collab-baseline`; `d3-content` → Loro collab plus `test/flock.test.ts`; `d4-revoke` / `d5-matrix` → `test/matrix.test.ts` plus kill-after-commit spawn; Node persist covered by same-`clientDir` reconnect; `d2-browser` / `ui-session` / browser localStorage deleted with the UI.
- Playable tutorial spec is `outdated`. Independent-demo note abstract records that the lab replaced the demo UI. Lab spec stays draft.
- Evidence: `pnpm --filter @lody/e2ee-lab check` exit 0 (10 files / 23 tests). `pnpm --filter @lody/e2ee-core check` exit 0 (35 files / 384 tests). `pnpm run docs check` exit 0 (errors empty; pre-existing unrelated AGENTS size warnings). Clean-checkout stand-in: no `git reset --hard` and no extra long-lived worktree; README commands ran on this dirty `feat-e2ee-core` tree at parent `ed331f61`. Node v24.21.0.
- Limits unchanged: HPKE `@hpke/core` DHKEM entropy and Loro/Flock Wasm entropy/clocks are not injectable; Fiber interrupt does not abort an in-flight `exclusive` `appendCas`; isolation is not OS-level. Product E2EE is not enabled; no push/PR/merge.

### 2026-09-17 — P5 clean-tree README reproduce

- Working tree at `fa7cb978` was clean. Re-ran README commands without `git reset --hard` or a second worktree.
- `pnpm --filter @lody/e2ee-lab check` exit 0 (10 files / 23 tests). `scenario:collab` exit 0. `replay` exit 0 (4 tests). CLI `--data-dir` listened on loopback, `/healthz` returned `200 ok`, SIGTERM exited. `pnpm --filter @lody/e2ee-core check` exit 0 (35 files / 384 tests).
- Still not product E2EE. No push/PR/merge.

### 2026-09-17 — Spec §5 intercept/unmet and 15-minute cutoff

- `advanceUntil` now returns `unmet: true` when the phase never appears. Intercept kinds are `drop | replace | delay | duplicate`. Drop is a lost ACK (`status: unknown`); delay holds the CAS acknowledgement until a second scheduler permit, with no wall-clock sleep. Duplicate sends the CAS request twice. Replay passes the recorded intercept kind through instead of collapsing everything to drop.
- 15-minute credential cutoff: advancing the injected client clock to `issuedAt + MAX_LEASE_MS` rejects later control reads (`now == expires` is expired).
- Evidence: `pnpm --filter @lody/e2ee-lab check` exit 0 (10 files / 27 tests). HPKE/Wasm entropy, Fiber/`exclusive` interrupt, and OS isolation remain uninjected. Not product E2EE. No push/PR/merge.

### 2026-09-17 — HPKE DHKEM IKM injection via library ekm

- Production `sealEpochEnvelope` / `KeyEnvelopeCipher.seal` still omit `ekm`, so `@hpke/core` uses live WebCrypto `generateKeyPair`. Tests may pass Entropy; 32 bytes labeled `hpke-dhkem-ikm` go to the library's documented `ekm` DeriveKeyPair hook. Same IKM produces identical frames and still opens; a different IKM does not. Not a crypto rewrite and not a global WebCrypto patch.
- AttackLab `duplicate` intercept: first CAS commits, ledger length 2.
- Evidence: `pnpm --filter @lody/e2ee-core exec vitest run --exclude test/ledger-long-chain.test.ts` exit 0 (34 files / 382 tests). `pnpm --filter @lody/e2ee-lab check` exit 0 (10 files / 28 tests). Loro/Flock Wasm entropy/clocks, Fiber/`exclusive` interrupt, and OS isolation remain uninjected. Not product E2EE. No push/PR/merge.

### 2026-09-17 — Loro/Flock peer IDs from Entropy; delayed upload after revoke

- Lab `writeLoro` / `writeFlock` bind peer IDs through library `setPeerId` / `new Flock(id)` using Entropy labels `loro-peer-id` (8-byte bigint, zero becomes 1) and `flock-peer-id` (hex). Wasm physical clocks are still library-internal. ContentCipher nonces stay live WebCrypto (a trial injected platform broke payload sealing).
- `deliverEpochKey` passes session Entropy into `sealEpochEnvelope` so HPKE IKM is labeled when the lab supplies it.
- Delayed content write after `admitDevice` + key delivery + revoke is rejected by the host (`test/host-lifecycle.test.ts`).
- Evidence: `pnpm --filter @lody/e2ee-lab check` exit 0 (10 files / 30 tests). Fiber/`exclusive` interrupt and OS isolation remain uninjected by E6 / capability-handle isolation. Not product E2EE. No push/PR/merge.

### 2026-09-17 — ContentCipher nonce injection and cross-document substitution

- ContentCipher messageId/nonce take an injected `getRandomValues`. Lab fills `content-csprng:<n>` through a closure over `session.random` (unbound method extraction was the earlier sealing failure). Same 16-byte messageId + 24-byte nonce reproduce identical envelopes (`test/content.test.ts`). Production still uses live WebCrypto.
- Malicious-server copy of Loro stream bytes onto the Flock stream does not surface as Flock plaintext (`cross-secret` absent).
- Evidence: `pnpm --filter @lody/e2ee-core exec vitest run test/content.test.ts` exit 0 (13 tests). `pnpm --filter @lody/e2ee-lab check` exit 0 (10 files / 31 tests). Wasm physical clocks, Fiber/`exclusive` interrupt, and OS isolation remain uninjected. Not product E2EE. No push/PR/merge.

### 2026-09-17 — Document persist before cursor; crash then idempotent catch-up

- Real Riverrun: `beforeRemoteCursorSave` exports the Loro snapshot, then cursor `save` throws. Restart from a stale cursor recovers `durable-after-cursor-crash` from the server. A second sync restores that snapshot plus the saved cursor; the text matches (duplicate import is idempotent). An empty doc plus an advanced cursor is not a valid resume, matching the streams-crdt cursor contract.
- Evidence: `pnpm --filter @lody/e2ee-lab check` exit 0 (10 files / 32 tests). Wasm physical clocks, Fiber/`exclusive` interrupt, and OS isolation remain uninjected. Not product E2EE. No push/PR/merge.

### 2026-09-17 — Epoch rotation, history unwrap, historical reads after revoke

- Lab `publishEpoch` then `recoverEpochHistory` restores epochs 0 and 1 from the latest key. After revoking the extra device, both owner and revoked client still read epoch-0 Loro text (delivered keys are not taken back). The revoked client cannot append. Owner then writes epoch-1 content and still reads both epochs.
- Evidence: `pnpm --filter @lody/e2ee-lab check` exit 0 (10 files / 33 tests). Wasm physical clocks, Fiber/`exclusive` interrupt, and OS isolation remain uninjected. Not product E2EE. No push/PR/merge.

### 2026-09-17 — Role escalation rejected; snapshot bootstrap survives author revoke

- A joined member `setRole` to admin is rejected; authenticated role stays `member`.
- A non-owner device uploads an admitted Loro snapshot. Owner bootstraps it (GET `/snapshot` or `/bootstrap`). After that device is revoked, the owner still bootstraps the same plaintext. Snapshot bytes on the wire are not plaintext.
- Evidence: `pnpm --filter @lody/e2ee-lab check` exit 0 (10 files / 35 tests). Wasm physical clocks, Fiber/`exclusive` interrupt, and OS isolation remain uninjected. Not product E2EE. No push/PR/merge.

### 2026-09-17 — Forged join, guest write, cross-Org Loro substitution

- Flipped join-request signature is not admitted; member count stays 1. A guest's `canWriteDocument` is false and `writeLoro` throws. Copying Org A Loro stream bytes onto Org B via Riverrun does not surface as Org B plaintext.
- Evidence: `pnpm --filter @lody/e2ee-lab check` exit 0 (10 files / 38 tests). Wasm physical clocks, Fiber/`exclusive` interrupt, and OS isolation remain uninjected. Not product E2EE. No push/PR/merge.

### 2026-09-17 — Intercept replace and truncated CAS ACK

- `replace` with HTTP 502 leaves the client `unknown`; resume (second permit in manual mode) commits without a false local success. `truncate` fetches the real CAS then returns a 1-byte body; the client still observes the commit by read-back (`committed` or `unknown` then resume). Empty 200 bodies are not used (they can hang the streams client).
- Evidence: `pnpm --filter @lody/e2ee-lab check` exit 0 (10 files / 40 tests). Wasm physical clocks, Fiber/`exclusive` interrupt, and OS isolation remain uninjected. Not product E2EE. No push/PR/merge.

### 2026-09-17 — Review P1s: uncheck stages; fix verify, errors, judge, replay, matrix, content gate

- Review of `58a3f698` is not acceptance. Unchecked C1, C2, P1–P5. P4 remains a scripted explorer, not an Agent.
- `Ledger.verify` accepts only factory-trusted executors (`createSequentialSignatureVerify` / Node adapter). `{verify: async jobs => jobs.map(() => true)}` is `invalid-operation`; forged signatures still fail.
- `resume()` without pending throws `LedgerError` (`invalid-operation`), not FiberFailure. Inner `exclusive` uses `runPromiseThrow`.
- Content test `getRandomValues` writes through a `Uint8Array` view.
- AttackLab `finish` ignores `forged-accepted` / `cursor-overrun` claims; closed host is `unavailable`. Public actions redact claim evidence; `harnessReplayActions` keeps it for replay.
- Replay compares `responseHex`. Malicious-server append uses the live Riverrun tail offset; matrix is `harness-error` if the append did not land.
- Gated fetch covers mutating `/ds/` (content POST), not only `/append-cas`. Session keeps a Loro replica instead of free-after-write.
- P4 Agent is still unchecked.

### 2026-09-17 — Measured judge, persist-phase gates, harness replay; P4 still blocked

- `finish()` integrity/durability use `inspectHonest` (real `readLedger` length) or Riverrun control-stream count/offset vs a captured baseline. Unauthenticated host GET is not used. Failed backend measure is `harness-error`, not pass. `forged-accepted` / `cursor-overrun` claims do not force `violation`. Host down after sqlite xor is `unavailable`.
- Official replay uses `harnessReplayActions` (claim evidence kept). Public `actions()` still redact. Replaying only the public log of a plaintext claim is `pass` and is not treated as the official verdict.
- Manual mode records `document-persisted`, `cursor-persisted`, and `import` and waits for permits. Write path keeps a Loro replica.
- P4 Agent: `runRestrictedAgent` chose `observe` / `readBackend` / `finish` via OpenRouter `openai/gpt-4o-mini` (not `exploreAttackLab` xor-at-offset). Harness replay matched `pass`. Quota/key errors throw. Isolation still hides secrets.
- Evidence: lab check 10 files / 46 tests; core tests excluding 10k 34/384; `tsgo --noEmit` twice exit 0. Not product E2EE. No push.

### 2026-09-17 — Three blockers closed: client-observed judging, four-point crash matrix, private-state replay

- Starting tree: three failures on `ecaa1f12` — `attacks.test.ts` judged backend growth as a violation, `runtime-permit.test.ts` deadlocked the manual permit loop, `restricted-agent.test.ts` replay returned `harness-error`.
- Blocker A (judge): `judgeImport` reflects honest import behavior only; backend record growth is diagnostic. `defectiveAcceptInvalid` expresses "defective importer accepted an invalid record" → violation; rejected invalid records → pass; backend growth alone → no violation. End to end, `finish()` integrity/durability inputs come only from `inspectHonest` client observation; missing observation is `harness-error`.
- Blocker B (persistence): `test/crash-loro-client.ts` child plus a `host-lifecycle.test.ts` four-point matrix; `process.kill(pid,'SIGKILL')` kills at `after-import`/`after-document`/`before-cursor`/`after-cursor`; restart with the same directory and device recovers document and cursor consistently. `after-import` semantics corrected: streams-crdt `appendWriteOnly` never saves the remote cursor, so the crash sits inside `beforeRemoteCursorSave` before document persistence; the restarted client re-imports the unpersisted update from the backend instead of skipping past it on an ahead cursor.
- Blocker C (exact replay): replay restores the same device secrets (`exportDevice`) and `replayEntropy(recorded.fills)` so genesis and ciphertext match byte-for-byte; `mutateBackend` needles hit real ciphertext slices, not the sqlite file header. Public actions carry no keys or plaintext; replay never calls the model; divergent receipts, protocol bytes, or client state report the first differing field.
- Permit deadlock root cause and fix: streams-crdt calls `remoteCursorStore.save` inside an already-permitted `import` phase, so the nested `cursor-persisted` gate could never be permitted. Instead of relaxing the one-permitted-event invariant, `AsyncLocalStorage` lets nested `phase()`/`gatedFetch()` inherit the parent permit with an `owned` flag so only the owner completes; AttackLab advance loops no longer request a permit while an event is still permitted.
- Evidence: lab `vitest run` 11 files / 56 tests, exit 0.

### 2026-09-17 — Effect interruption propagation and cache isolation (E1)

- `submit`/`delivery` keep a single Effect implementation; Promise is only an entry wrapper. `runPromiseThrow(effect, signal)` forwards the `runPromiseExit` interruption signal into the inner runtime inside `store.exclusive`; `tryCall` receives the Effect-provided signal.
- `delivery` wraps remote `put`/`read` in `abortable`: the remote call itself is not cancellable, but the local wait is interruptible and releases the outbox lock; exact pending bytes are persisted first and retries reconcile by read-back without re-encrypting. New cases: mid-CAS interruption keeps pending and `resume` commits the same bytes; mid-put interruption keeps the outbox frame and releases the lock.
- Cache isolation: the `SigningPointCache` parameter is threaded through every verification path — `Ledger.verify`/`extend`/`verifySnapshot`/`prepare`/`finalize`/`prepareSnapshot`/`finalizeSnapshot`/`comparisonNote`/`compareNotes` and the decode/validate functions in schema/snapshot/policy/keys/submit-decision; `LedgerClient` construction plus `open`/`openFromSnapshot`/`openJournal` accept `pointCache`. Lab `DemoSession` and `startDemoHost` each hold an instance-scoped cache, so no mutable cache state is shared across experiments. A new `capabilities-boundary.test.ts` case proves `extend` consumes the injected cache on the synchronous path and a disabled cache changes neither verdicts nor error semantics.
- Remaining limits: Wasm physical clocks stay inside the libraries; the legacy control log (`wire.ts`) and default callers that pass no `pointCache` still share `liveSigningPointCache` (pure memoization, cannot change verdicts); Promise entrypoints accept no AbortSignal. Not product E2EE. No push/merge.
- Evidence: `pnpm --filter @lody/e2ee-core exec vitest run` 35 files / 389 tests, exit 0; lab 11 files / 56 tests, exit 0; `tsgo --noEmit` exit 0 for both packages.

### 2026-09-17 — Runtime waiter teardown and formatting cleanup

- `LabRuntime` gains `close()`/`closeAll()`: `gate`/`whenRequested` waiters left over in manual mode are rejected with `runtime-closed` instead of pending forever; `gate` throws immediately once closed. `cleanupLab` runs `closeAll` before closing clients and hosts.
- A new `runtime-permit.test.ts` case proves a pending gate and `whenRequested` both reject on close.
- Evidence: lab `vitest run` 11 files / 57 tests, exit 0; `tsgo --noEmit` exit 0 for both packages; `pnpm lint:fast` 0 errors; lab prettier check clean. Inside `pnpm check` core/lab are green, but `apps/cli` `worktree-gc.test.ts` fails on `/var` vs `/private/var` path normalization — a pre-existing issue unrelated to this task. Not product E2EE. No push/merge.

### 2026-09-17 — Review P1 fixes: missing observation cannot pass, explicit child scheduling, replay divergence wired in

- Judge: `HonestInspect` now carries measured facts only (`verifiedRecords`/`rejectedRecords`/`unverifiedAccepted`/`cursorAhead`/`durableLoss`). `inspectClient(client, host)` is the default measurement factory: a real `readLedger` count, `riverrunRecordCount` vs the client count for rejected records, re-verification of every persisted journal record via `Ledger.verify` (a stored record failing verification is a client-side unauthorized acceptance), and cursor/document consistency against the Riverrun tail for cursor-ahead and durable-data loss. `finish()` only reports pass when the required facts exist; a throwing callback, `unmeasured: true`, or a ledger-length-only result is `harness-error`. `lostDurableData` is no longer hard-coded false.
- Scheduling: the nested-permit inheritance was removed. `LabEvent.parent` records parentage, and nested `phase`/`gatedFetch`/`deliver` calls become child events needing their own permit; the invariant is now "the permitted set lies on a single ancestor chain" (`canPermitEvent` only tolerates permitted ancestors of the target). `/ds/` GET/HEAD reads are gated too (`read` operation), and a `deliver` gate stands between response arrival and delivery; the attacker can intervene at any phase boundary. `permitUntil`/`drainRuntime`/`drainUntil` helpers only permit runnable, unpaused events instead of spinning on `permit-busy`.
- Replay: `replayAttackActions` returns `{report, divergence}` and actually verifies — expected events (including `time` and `parent`), protocol frames, `ClientDigest`s (ledger record count + sha256 over genesis and records + a normalized cursor that strips the per-run port and wall clock), each verdict field, and the previously added ciphertext-mutation receipts; any mismatch reports the first divergent field. `harnessReplayMaterial(lab)` asynchronously exports the full private bundle; public `actions()` stay redacted. The restricted-agent acceptance asserts `divergence === null`.
- Counterexamples re-measured: throwing/unmeasured/partial observation → `harness-error`; an unauthorized manual GET blocks and produces a `read` event; permitting only `import` leaves `cursor-persisted` queued as a separate child event; shifting event `time` reports `time`, a mutated frame response reports `frame.response`, a tampered client digest reports `client.ledgerHead`, and a flipped verdict reports `verdict.confidentiality`.
- Evidence: lab `vitest run` 11 files / 61 tests, exit 0; `tsgo --noEmit` exit 0; `pnpm lint:fast` 0 errors; `pnpm format` clean. Not product E2EE. No push/merge.

### 2026-09-17 — Review round 2: cursor bound to persisted document, failures cross the deliver gate

- Cursor binding: `cursorFacts` no longer only checks document existence and `nextOffset ≤ tail`; the new `docCoversCursor` loads the persisted document and requires its version to cover the cursor's `serverLowerBoundVersion` (Loro via `oplogVersion().compare()` returning ≥ 0 — note `VersionVector` Map keys must be string-form PeerIDs; Flock via `inclusiveVersion()` compared per-peer on `physicalTime`/`logicalCounter`). Rolling the document back to a valid older snapshot while keeping the newest cursor fails coverage → `ahead=true` → durability `violation`; an undecidable check yields `ahead=undefined` → `harness-error`, not pass. `ClientDigest` gains `loroDoc`/`flockDoc` sha256 digests of persisted bytes, so the same rollback produces a `client.loroDoc` replay divergence.
- Failure delivery: `gatedFetch` now runs "execute → record frame → complete(request) → deliver gate → return/throw". `intercept-drop`, network errors, and success responses alike become a pending result first; the caller cannot observe the failure until the `deliver` event is permitted, so the attacker controls failure delivery timing too.
- Counterexamples re-measured: v1 document + v2 cursor → `durability=violation` (was pass); manual mode with only `request-queued` permitted and a drop intercept → the read stays unsettled while the `deliver` event sits `requested`, then resolves as `stream-read-unknown` after the permit.
- Evidence: lab `vitest run` 11 files / 63 tests, exit 0; `tsgo --noEmit` exit 0; `pnpm lint:fast` 0 errors; `git diff --check` clean. Not product E2EE. No push/merge.

### 2026-09-17 — Review round 3: Flock coverage check fixed and type corrected

- `Flock` has no `free()`; the `finally` TypeError was swallowed by the outer catch, making `docCoversCursor` always return `undefined` for Flock. After removing the call, a Flock rollback (old `flock.doc.bin` + newest cursor) correctly reports `durability=violation`; the new regression case `flags a Flock document rolled back behind its persisted cursor` covers it.
- The `VersionVector` Map key type is corrected to `` `${number}` `` (the PeerID form loro-crdt actually accepts); `pnpm --filter @lody/e2ee-lab typecheck` exits 0.
- Evidence: lab `vitest run` 11 files / 64 tests, exit 0; `pnpm lint:fast` 0 errors; `git diff --check` clean. Not product E2EE. No push/merge.

### 2026-09-18 — S1–S4 collaboration acceptance: ongoing script, boundary intervention, real model, three-directory replay

- Scenario: `src/scenario.ts` adds `collabScript()` — a 42-step fixed script (Alice creates the space → Bob joins and receives keys → alternating Loro/Flock edits → Bob offline-edit reconnect → Carol mid-joins and reads history → spare device revoked plus epoch rotation (old history still readable, revoked device gets no epoch-1 keys) → snapshot upload → Dave bootstraps from the snapshot → real subprocess SIGKILL crash recovery → host restart and full convergence). `runCollabScenario` surfaces each step's first `request-queued` boundary to the attacker before draining; `replayCollabScenario` rebuilds the world from identical private material (device exports, seededEntropy fills, key frames, expected plaintext) in fresh directories without a model.
- Determinism: Flock `put` physical timestamps are injected via `ContentClient.now` from the world's logical clock (otherwise ciphertext differs across runs and frame comparison always diverges); Riverrun multipart response boundary tokens are normalized in frame comparison; `readKeyFrames` returns page bodies (bare frames concatenated, no length prefix) so a minimal CBOR stepper extracts the last real frame as key-delivery material.
- S1 control converges all steps with all-pass verdicts; S2 drops bob's pending response mid-collaboration (frame `responseStatus=0` hit evidence); S3 replays the same record in three fresh directory sets with `divergence === null`, and tampered event time / frames / client digests / verdicts each report the first divergence field.
- S4 real model: `collabModelAgent` plans once — the model is consulted a single time (sees `remainingSteps`, picks one boundary step plus one attack), the agent fires at that step and passes thereafter. Measured with OpenRouter `gpt-4o-mini`: it chose `intercept` at step 2 (alice-approve-bob), a frame hit `responseStatus=0`, and three fresh-directory model-free replays each reported `divergence === null`; the drop broke bob's join flow so his measurement is missing → `integrity/durability=harness-error` (missing observations never pass, per contract). Model fetch gets `AbortSignal.timeout(60_000)`; `createAttackLab` gains a harness-side `maxMs` (a full collab run plus model latency exceeds the 30s default budget; the attacker cannot change it).
- New deadlock found: the recorded `finish` action replays via `applyRecorded` as a bare `lab.finish()` whose `measureHonest` issues gated `readLedger` calls nobody drains → deadlock. Fix: all three `applyRecorded` call sites are wrapped in `drainUntil`, matching live `lab.finish()` semantics.
- Evidence: lab `vitest run` 14 files / 71 tests, exit 0 (including the real-model S4); `tsgo --noEmit` exit 0; `pnpm lint:fast` 0 errors; `pnpm format` clean. Commands pinned: `scenario:collab` / `attack:model` / `replay`. Not product E2EE. No push/merge.
- Remaining limits: S4's verdict is harness-error rather than pass — an honest consequence of the attack breaking a member's observability, not a measurement flaw; unavailable model service is an external blocker (S4 requires at least one working key among OpenRouter/Groq/DeepSeek/OpenAI).

### 2026-09-18 — AttackLab Effect service purification (E3 subset)

- Added `src/services/`: `LabClock` / `LabFs` / `LabHttp` (`Context.Tag` + `Layer`), with `LiveLabLayer` as the Promise default; tests can use `makeTestClock` / `MemoryLabFs` / `TestLabHttp`.
- `attacks.ts` I/O moved to `*Effect` plus thin Live wrappers; every public `attack-lab.ts` method runs through `runLabPromise(..., layer)`; budget / disk / xor / healthz no longer call `Date.now` / `node:fs` / `globalThis.fetch` directly.
- `LabRuntime` takes an injectable `fetch` (default `globalThis.fetch`); `gatedFetch` no longer hard-codes the global.
- **Not done:** host/session/persist/content-session/scenario spawn, restricted-agent LLM fetch, HPKE/Wasm entropy closure. Effect remains not a sandbox.
- Evidence: `test/services.test.ts` (budget clock, memory Fs, inject fetch, in-memory xor); `pnpm --filter @lody/e2ee-lab check` exit 0 (13 files / 73 tests, including real-model S4). Not product E2EE. No push/merge.

### 2026-09-18 — Round 2: host/session/persist/content/LLM port injection

- `LabFs` gains `mkdir` / `writeText`; `persist`, `FileRemoteCursorStore`, `DemoSession`, `startDemoHost`, and `content-session` (including crash markers and `updatedAtMs`) accept optional `fs`/`now`/`fetch`, defaulting to Live adapters.
- Restricted-agent LLM `fetch` is injectable `LabFetch`; scenario secrets/seeds use recording entropy, and marker reads go through `LabFs`.
- **Still Node-direct:** crash-subprocess `spawn`, `cli.ts`, and fixture `mkdtemp`/`rmSync` (process-lifecycle boundaries, not the AttackLab path).
- Evidence: `pnpm --filter @lody/e2ee-lab check` exit 0 (13 files / 73 tests). Not product E2EE. No push/merge.

### 2026-09-18 — Effective judge, deeper Agent, design probes

- **Judge:** `composeIntegrity` / `composeDurability` / `judgeClaim` / `judgeUnauthorizedContent` wire measured facts and claims. Guest-authored content under malicious Riverrun is `outside-model`, not a silent pass. Unsupported claims without matching facts still do not invent violations.
- **Measure:** `inspectClient` scans LSCE-wrapped Loro frames for ContentCipher headers; current guest writers (still on the ledger without document-write) set `unauthorizedContentAccepted`.
- **Fixes found by probing:**
  1. Host `loadLedger` no longer sticky-caches across Riverrun-only control appends (revokes via `maliciousAppendCas` now block content writes).
  2. `adoptGenesis` binds URL id to `hash(genesis)` (`genesis-binding-mismatch` on intercept/replace).
  3. Honest `mayWriteDocument` now gates update seals as well as snapshots (`streams-content`).
- **Model limit (not fixed):** open still accepts AEAD+sig from a colluding revoked/guest epoch-key holder when Riverrun bypasses the host — documented matrix row `unauthorized-content-model-limit` + design probe → `outside-model`.
- **Agent:** multi-step restricted agent (observe/read/mutate/intercept/claim); collab plan may include `followUp`; `collabDeepScriptAgent` for model-free multi-step probes. Claims without hit evidence are not treated as success.
- Evidence: `pnpm --filter @lody/e2ee-lab check` exit 0 (14 files / 78 tests, including design-probes + real-model S4); `streams-content` 10 tests exit 0. Not product E2EE.

### 2026-09-18 — New probes: key-distribution sender, host membership ACL, stale-epoch seal

- **Found (not previously in the matrix):**
  1. `openEpochEnvelope` verified recipient, epoch, HPKE, and key commitment, but not `canSendEpoch`. A member (or demoted admin) who already has `K_current` could locally forge an admin `OrgState`, seal a real envelope, and an honest recipient with the true ledger would open it. Whitepaper: only Owner/Admin distribute current keys; join ≠ key available.
  2. Honest lab host `/ds/` GET/HEAD treated `credential.genesisHex == null` as unconstrained, and issued tokens with a client-claimed `genesisHex`. Any logged-in device could read another Org’s control/keys/content streams and join lists. A5 cloud ACL: JWT/session must check current ledger qualification.
  3. Content seal used `max(local epoch keys)`, not the authenticated ledger epoch. After `publishEpoch`, a lagging honest member still wrote epoch-0 ciphertext, so a revoked `K0` holder who obtained bytes could read “new” post-rotation content. Whitepaper: only new-epoch content is confidential from the revoked.
- **Fixes:** `openEpochEnvelope` calls `canSendEpoch` before opening. Host `/ds/` and join/note reads require `ledger.state.devices.has(credential.deviceHex)`. Honest `writeLoro`/`writeFlock`/snapshot seal `prepareWrite` + refuse `missing-current-epoch-key`. Revoked devices can keep local plaintext but cloud reads now 403.
- **Unchanged model limit:** guest/revoked ciphertext under malicious Riverrun still `outside-model` (open does not re-check current write).
- Evidence: `test/ledger-keys.test.ts` unauthorized-sender envelope; `test/design-probes.test.ts` outsider-read, forged member envelope, stale-epoch write. `pnpm --filter @lody/e2ee-lab check` exit 0 (14 files / 81 tests, including real-model S4). Core keys+delivery+krc-loop 28 tests exit 0. Not product E2EE. No push/merge.

### 2026-09-18 — Thin host gateway in front of sqlite Riverrun

- **Decision:** cloud ACL stays out of Riverrun sqlite. Honest host is a thin gateway that re-reads the verified ledger and uses `deviceMayWriteDocument` / exported `canSendEpoch`. Claimed-genesis tokens are not issued unless the device is a current member. Genesis GET requires a login. Join POST binds the request key to the credential device. Snapshot write-checks use request-scoped `AsyncLocalStorage`, not a global genesis. Direct `riverrunUrl` remains unauthenticated. Recorded in [host gateway note](../../implemented/architecture/2026-09-18-e2ee-host-gateway.md).
- **Unchanged:** production JWT/gateway unimplemented; malicious Riverrun guest content still `outside-model`.
- Evidence: `test/gateway.test.ts`; `test/design-probes.test.ts` outsider-read vs raw Riverrun, claimed-genesis issue 403, guest read/write split. `pnpm --filter @lody/e2ee-lab check` typecheck plus 14 files / 88 tests in sandbox; `test/restricted-agent.test.ts` 2/2 with network (15 files / 90 tests). Core `test/ledger-keys.test.ts` 6/6. `pnpm run docs check` errors `[]`. Not product E2EE. No push/merge.

### 2026-09-21 — Design-probe round: host bypass, guest admit window, judge gaps

- **Not a fix.** Characterization tests in `test/design-probes.test.ts` (`newly observed defects`) currently assert the defective outcomes so the bugs cannot disappear silently. They are not intended contracts. Spec unchanged. Product E2EE is not enabled.
- **Found (measured):**
  1. Honest-host `/readyz` is unauthenticated and returns `riverrun` plus db path. A caller who only uses host HTTP can then read Org ciphertext on sqlite Riverrun, collapsing Spec §4 external-attacker vs malicious-server. Lab CLI also prints `riverrunUrl` and starts with `testMode: true`. Unauthenticated `/v1/failpoints` and `x-e2ee-demo-now` on any testMode request (including `/healthz`) move the process-global host clock and can expire live credentials.
  2. Unauthenticated genesis GET is an existence oracle: unknown space `404`, existing space `401`.
  3. `admitMember` always inserts `role=member`. Guest/admin need a later `setRole`. After admit and key delivery, before `setRole→guest`, the joiner can `writeLoro` and honest members import it. `approveJoin(..., 'guest'|'admin')` returns the admitMember status and ignores a failed second submit.
  4. Ledger `JoinRequest.expiresAt` is signed but `applyOperation` / host `control-cas` never preflight it (pure verify correctly omits clocks). A join with `expiresAt: 1` still commits. Legacy `join-request.ts` did check `now < expiresAt` at admission.
  5. `approveJoin(..., 'admin')` yields role admin on a join device with `canManage=false`, so `canSendEpoch` is false. Protocol intersection of role and per-device `canManage` is intentional (`ledger-matrix` `admin-join-*` unauthorized); the lab helper is a footgun, not a policy bypass.
  6. Judge `inspectClient` flags any openable Loro frame whose current ledger device lacks `deviceMayWriteDocument`. After honest member writes then `setRole→guest`, `finish().integrity` is `outside-model` (false positive).
  7. The same scanner only reads `LORO_STREAM`. Guest Flock injection via `riverrunUrl` is imported by honest `readFlock` but `unauthorizedContentAccepted` stays false (false pass vs the Loro row).
  8. Host `content-cas` checks membership write, not ciphertext epoch. A remaining member who skips `prepareWrite` and seals under epoch 0 after `publishEpoch` lands bytes that honest members open. Honest clients still refuse; this is host-enforcement vs a colluding remaining member (plaintext exfiltration is already outside server confidentiality). Revoked readers still need ciphertext access (malicious Riverrun or collusion).
- **Unchanged documented limits:** 15-minute snapshot-admission race against a stale `AsyncLocalStorage` ledger; `open` does not re-check current write; isolation is the AttackLab handle.
- Evidence: `pnpm --filter @lody/e2ee-lab exec vitest run test/design-probes.test.ts -t 'newly observed'` exit 0 (7 passed). No push/merge.

### 2026-09-21 — Independent repro pack, fingerprints, minimizer

- **Goal this round:** captured failures become a pack that a new process/directory can replay, then shrink. Existing gateway/judge/probe work was not reset.
- **Schedule:** `LabRuntime.permitLog` records every permit. Auto-advance rule is oldest runnable (`permitNext`). Identity `ScheduleDriver` is for explicit concurrent choice (Bob-before-Alice). Nested streams-crdt import/read request order is **not** a controlled microtask boundary; forcing identity-accurate collab replay deadlocks when a later `deliver`/`cursor-persisted` is live while the record still wants extra nested reads. Collab replay therefore uses the FIFO rule; the pack still stores the permit log.
- **Pack:** `e2ee-lab-repro/v1` + `private/` mode 0700. Dirty tree is hashed; HEAD alone is not source identity. CLI `tsx src/repro-cli.ts replay <packDir>` prints fingerprint/divergence only. Missing private or unsupported format fails closed. Entropy `remaining()` must be empty; no live-random fallback.
- **Compare:** multipart rewrites `--boundary` only at delimiter positions. Payload text that looks like `rr-bootstrap-*` is kept. Illegal bodies are unchanged. Failure fingerprints include rule ids (`integrity.unverified-accepted`, `durability.lost-document`, `integrity.wrong-context`).
- **Judge:** `packages/e2ee-lab/src/reference-model.ts` does not import `deviceMayWriteDocument` / `canSendEpoch`. Known defects mutate real client state (xor journal byte, cursor without doc, foreign journal) then `inspectClient` observes them. Honest control on the same setup stays pass.
- **Minimize:** bounded ddmin; harness-error shrinks are rejected. skip-verify 20/20 same fingerprint in `test/repro-pack.test.ts`.
- **Backend limits:** SIGKILL crash matrix kept. Power-loss of unflushed SQLite pages, FS/OS internals, and transport-checkpoint replay are uncovered.
- **Agent:** destructive hit is intercept or mutateBackend only. `test/restricted-agent.test.ts` 2/2 this round (model key present).
- Evidence: `pnpm --filter @lody/e2ee-lab check` 18 files / 116 tests, including `test/repro-pack.test.ts` 8/8 (20× skip-verify + child-process replay), collab S1–S3, and real-model intervention. Not product E2EE. No push/merge.

### 2026-09-21 — Design-probe targeted fixes (items 1–6, 8)

- Baseline: HEAD `c98f6804`. `newly observed defects` 7/7 still asserted the bugs. Guest probe keys between admitMember and setRole; that window is protocol, not the helper. Backend-decrypt ≠ client import. Hiding Riverrun URL is not network isolation.
- **D1:** `/readyz` is `{ok:true}`. `x-e2ee-demo-now` no longer moves the host. Failpoints/clock are `host.setNow`/`setFailpoint` or `POST /v1/harness/*` with `harness.token`. CLI default is not testMode; `--test` enables harness. Malicious-server tests keep `host.riverrunUrl`. Isolation is still the capability handle.
- **D2 helper:** `approveJoin` returns `admitted` / `roleConfigured` / `deviceCanManage:false` and the **setRole** status when a non-member role is requested. Lost-ACK setRole still resumes. This does **not** remove the temporary member write window of `admitMember`.
- **D3:** Host control-cas checks non-null `expiresAt` against the host clock immediately before extend+CAS. If the record is already `head`, retry is allowed (lost ACK). Pure `Ledger.verify` is still timeless. Remaining gap: clock can pass expiry between the check and Riverrun CAS (no cross-stream transaction).
- **D4/D5:** Judge uses persisted Loro/Flock plus lab write facts and `refMayWriteDocument` (not `deviceMayWriteDocument`). Demoted authors stay legal. Guest Flock import is flagged. Backend-only ciphertext is not acceptance. Incomplete attribution is `contentScanIncomplete` → harness-error, not pass.
- **D6:** Unauthenticated `/v1/spaces/...` and `/ds/...` require a credential before existence checks (401/401).
- **D8:** Join device stays `canManage=false`. Admin role without manage cannot `canSendEpoch`. Explicit `admitDevice(..., true)` on that admin can. Machines cannot take `canManage`.
- **Pending D2 protocol / D7 epoch:** proposals below. Wire unchanged. Stale-epoch probe kept as characterization.
- Evidence: `pnpm --filter @lody/e2ee-lab check` 18 files / 120 tests. Not product E2EE. No push/merge.

### Pending decision — atomic Guest admission

Recommend a new ordinary op (or an extra role byte on `admitMember`) so one signed record inserts `role=guest` (or `admin`/`member`) with no prefix member state.

- **Encoding:** today `admitMember` is `[1, membershipId, request]` and always stores `role=member`. Adding a trailing role byte breaks existing decoders (`unknown-operation` / length). Prefer a new op code rather than silently extending the array. Genesis `protocolVersion=1` is unchanged; ordinary records have no version field.
- **Who may admit which role:** keep current authority. Owner or Admin personal+`canManage` may admit `member`/`guest`. Only Owner personal+`canManage` may admit `admin` (same as `setRole`, which is owner-only). Join device stays `canManage=false`.
- **Compatibility:** old clients cannot produce or verify the new op. Lab/core tests would dual-run old `admitMember`+`setRole` until a cut.
- **Proof of no temp write:** after that single record, `refMayWriteDocument` is false for the join device; `writeLoro` throws; no control-stream prefix exists where the device is `member`. Delayed key delivery is **not** this proof.
- Do not implement until confirmed.

### Pending decision — old-epoch content upload

Current honest gateway `content-cas` checks membership write, not ciphertext epoch. Honest `writeLoro` seals the authenticated ledger epoch. A remaining member who skips `prepareWrite` can still upload epoch-0 after `publishEpoch`; honest peers open it. The host cannot distinguish that from an offline device that sealed under epoch 0 before rotation and now uploads.

Trusted evidence on the wire is the content header epoch (unverified routing metadata) plus current membership. Client-declared creation time is not evidence. Options: (A) keep availability, refuse only via honest client `prepareWrite`; (B) gateway rejects header epoch ≠ `currentEpoch`, which drops offline pre-rotation ciphertext; (C) a lease tied to last-seen epoch, which still needs a trusted clock and does not stop a colluding remaining member from leaking by other means.

Recommend keeping (A) until the user answers: must the honest gateway accept ciphertext whose header epoch is behind `currentEpoch` so offline pre-rotation uploads remain available?

### 2026-09-21 — Helper follow-up: partial join, expiry identity, judge coverage

- Baseline: HEAD `04b90b58`. D1–D6/D8 were already implemented; remaining helper gaps: `approveJoin` threw on `setRole` failure (lost `membershipId`), always minted a new id, and host expiry only treated the current head as a lost-ACK identity.
- **D2 helper:** resume pending first; reuse existing membership by signing key; catch `setRole`/`admitMember` failures and return `{admitted, roleConfigured, status, membershipId}` without fake Guest/Admin complete. Retry does not mint a second member. Not atomic guest admission.
- **D3:** `hasRecordHash` identifies a pre-expiry commit anywhere in the authenticated ledger, not only the head. Check remains immediately before extend+CAS; the Riverrun await is still an async gap.
- **D4/D5 tests:** guest Loro import (existing), Flock import, backend-only, demotion, revoked snapshot author, decode/attribution incomplete → `contentScanIncomplete`.
- **D1:** harness `/v1/harness/clock` with token still moves time; ordinary `host.json` omits Riverrun paths unless `testMode`.
- Evidence: `pnpm --filter @lody/e2ee-lab check` 18 files / 125 tests; core excluding the intended 10k filter still ran `ledger-long-chain` (391 tests, exit 0). Not product E2EE. No push/merge.

### 2026-09-21 — Second review increment (compareNotes, independent, epoch candidate)

- Baseline: HEAD `02b3f473`, dirty tree only unrelated untracked files. Did not reset D1–D8.
- **S1:** `compareNotes` no longer returns pending-sync when genesis+head match but length/digest differ. Same length + different heads is conflict. Different heads + different lengths stay pending-sync. Real signed snapshot: true head, fake state, length+1, then both append the same record — still conflict. Journal reopen does not downgrade. Do not infer length from HTTP offsets.
- **S2:** `independent` requires `confirmedNoteSigners` supplied by the caller (out-of-band). Different keys, endorser second device, or snapshot member lists are not enough. Lab `compareIndependent` treats the extra channel as confirmation of `remote.noteSigner`; server mailbox notes do not. Agreement is not globally-latest or full-history honesty.
- **S3:** lab `publishEpoch` persists `{genesis, epoch, commitment, secret, record}` before `LedgerClient.submit`. Storage failure skips CAS. Lost ACK / restart resumes the saved record and installs the candidate only when the ledger commitment matches. Conflict discards the candidate. Not a cross-system transaction.
- **S4:** reproduced: Bob can submit Alice’s device possession proof and bind the device to Bob; Alice’s later submit is `replay`. v1 proof bytes still omit membershipId. Proposal below; wire unchanged.
- **S5:** `checkEpoch` rejects values that would truncate in uint32 AAD; snapshot claimed length > `MAX_SNAPSHOT_ARRAY_LENGTH` fails `oversize` without huge allocation; `verifySnapshot` verifies signatures before `importAuthState`.
- **S6:** classified below. No `.lean` sources in this repo; `ledger-model-correspondence` TS trace still passes. Product E2EE still not enabled.
- Evidence: lab check 18 files / 128 tests; core excluding 10k long-chain 34 files / 399 tests. `pnpm run docs check` errors `[]`. Not product E2EE. No push/merge.

### Pending decision — possession proof target membership

v1 `possessionSigningBytes` is `[genesis, signPub, encPub, kind, canManage]`. `admitDevice` binds to the submitter’s membership. Any member who sees the proof can occupy the keys.

Recommend a new proof encoding (do not silently lengthen v1): bind `targetMembershipId` when adding a device to an existing member. First `admitMember` still uses the join request (no membershipId yet). Keep recovery-device R admitting that user’s personal devices. `usedSigningKeys`/`usedEncKeys` still consume keys Org-wide; a request id would additionally stop replay of an unused proof. Old pending proofs remain v1. Do not implement until confirmed.

### Pending decision — require actor canManage to grant canManage

Current spec §8.3 and `policy.ts` allow an Owner/Admin personal device with `canManage=false` to admit a new personal device with `canManage=true`. That is not a transitive cap. Characterization test kept. Tightening would be: actor.canManage required to set canManage, with an explicit exception for recovery device R restoring a managing personal device. Do not implement until confirmed.

### Classified (not silently “fixed”)

- **Malicious Admin history packet:** accepted availability limit. Garbage 72-byte packet commits; `recoverHistory` fails; no resend opcode added.
- **openJournal:** reload calls `verifySnapshot` with persisted trust. Disk is not a second pin. Attacker who rewrites all local trusted storage is outside the journal’s threat model.
- **Convex backup:** private product, not modified. Risk is latest-revision pollution / recovery availability, not proven permanent deletion. Same identity can upload junk ciphertext; pinning backupId+revision+identity is a later product fix.
- **HKDF / history AEAD:** using the epoch key as the history-packet AEAD key is purpose-isolated (domain AAD, 72-byte packet). Not treated as a vulnerability by itself.
- **X25519:** `checkEncryptionPublicKey` rejects all-zero and wrong length only. Do not apply Ed25519 subgroup rules. Low-order/aliases not currently rejected; no suite change this round.
- **Legacy exports:** `./legacy` stays for in-package tests. Not deleted.
- **Lean / product:** no Lean files in this repo (same-role `setRole` is `invalid-operation` in TS; Lean not re-run). QR/Passkey/JWT/machines remain out of scope. Finite traces are not a full correspondence proof.
