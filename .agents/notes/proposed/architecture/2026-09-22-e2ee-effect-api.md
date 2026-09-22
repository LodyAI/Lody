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

| Stage                     | Status      | Deliverable and gate                                                                               |
| ------------------------- | ----------- | -------------------------------------------------------------------------------------------------- |
| P0 Contracts and baseline | Done        | Exports/consumers, old data, acceptance; unchanged protocol                                        |
| P1 Pure computation       | Done        | Schema, policy, proofs, snapshot, content-frame, recovery-file, and replay apply are Either |
| P2 Ledger workflows       | Done        | Native verify/extend/snapshot/submit. Local `create` signs genesis; remote publish+key backup stay app-composed |
| P3 Other active modules   | Done        | Lab send/receive, snapshot admit, identity, content workflows, user recovery Effect. Promise SDKs listed |
| P4 Migration and closure  | Partial     | Protocol bridges gone. Content Effect re-execution fixed. Four-class performance evidence still incomplete |

## Acceptance

### Remaining implementation (not a request for new product decisions)

- [x] Finish P1: migrate schema, crypto, policy and snapshot validation to total
      functions; keep owned internal replay updates efficient rather than cloning per record.
- [x] Finish P2: native verify/extend/snapshot/submit and intent `create`. Initial-key
      durability and remote publication remain application composition, not a second
      Org-create algorithm inside the client.
- [x] P3: Lab send/receive uses bound delivery+outbox and persist-first install.
      Snapshot admit shares one workflow. Content parse/seal/open is Either/Effect;
      `ContentCipher` and streams-crdt stay listed Promise SDK unwraps. User
      recovery is on `UserIdentityStore`.
- [x] P4: Lab host/content-session/backup and Electron device/user services compose
      those workflows at Promise SDK/IPC boundaries. Protocol bridges are gone
      (`--complete` is 0). Deliberate raw attack inputs stay at audit/test edges.
- [ ] Four-class 1000-record gates still need old-vs-new baselines for increment,
      snapshot and recovery (not only current-implementation medians), and
      increment must time full submit rather than only `Ledger.extend`. Replay
      median 1140 ms vs ~1215–1268 ms is recorded. 10k/100ms stays withdrawn.

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

### 2026-09-22 — Required source style

- Added the same binding source-style rules to core and Lab `AGENTS.md`: fully
  pure calculations, Service-isolated Effect workflows, thin platform Layers,
  complexity concentrated in pure then workflows, and Effect-based tracing/logs.
- Expected failures must not throw; unexpected fatal defects remain distinct.
  Existing migration exceptions are temporary, not a claim of completed purity.
- Both packages already use the exact workspace Effect v3 pin `3.18.4`.
  Dependency changes and runtime behavior changes are not part of this update.

### 2026-09-22 — P1 pure policy calculation

- Genesis and all seven ordinary-operation policy calculations now return typed
  Either values in `pure/ledger-policy.ts`. Inputs are never mutated; no signing
  cache, I/O or implicit clock is used there. Encoding and policy rules are unchanged.
- A successful internal delta is applied immediately to the owned replay state by
  the temporary legacy adapter. Failure applies nothing. The delta is not exported
  as public authority, cannot bypass proof checks, and does not clone history per record.
- State helpers moved to `pure/ledger-state.ts`; forks now own copies of member,
  device and genesis bytes as well as history. Identifier formatting has one pure
  implementation shared by the compatibility path.
- Added behavioral tests for deterministic/no-mutation calculation, late invalid-key
  failure without consuming signing keys, tampered returned deltas, replay rejection,
  and byte isolation across forks. The full core suite passes: 38 files / 430 tests,
  including the real 10k journal and cross-process recovery. Typecheck, scoped lint,
  boundary check and docs check pass (37 existing document warnings).
- P1 remains partial: schema/crypto/proof/snapshot conversion and the mutable replay
  adapter still need closure. The existing 9 workflow protocol bridges remain;
  this work adds no new exception. P2–P4 and non-replay performance gates remain open.
- Same machine and 1,000 records: both versions produce identical heads and full
  authorization states. Three warmups and ten alternating measurements give replay
  medians of 1268.49 ms baseline and 1453.48 ms current (+14.6%), below the 20%
  threshold. Baseline policy SHA-256 matches `d7d3b7c6`; other performance gates remain open.
- Repository `pnpm check` passed all typechecks, then found the existing Lab lint
  errors plus one new exhaustive-switch return diagnostic. Fixed the latter with
  a `never`-checked fallback (no suppression); scoped type-aware lint and the five
  policy/verification tests pass after that final change. The 430-test full run
  preceded this fallback. The remaining root lint errors are not a completion waiver.

### 2026-09-22 — P1 Either schema and explicit validity facts

- Moved the single record encoder/decoder and signature-message construction to
  `pure/ledger-schema.ts`; old schema functions only unwrap that implementation.
  Field/hash/epoch primitives now live in `pure/wire-crypto.ts`, with old primitive
  APIs delegating. Signature execution, proof and snapshot workflows still remain.
- Native workflows consume schema Either values directly. Removed three migration
  bridges from the checked list (9 → 6); no new exceptions or wire fields.
- Initial migration caused +63.0% replay overhead by losing repeated-point reuse.
  Added immutable `SigningFacts`, explicitly passed into and returned from pure
  decoding. Facts prove point validity only, not signatures, membership or authority.
  The legacy bounded cache owns replacement of facts; pure functions mutate neither
  facts nor input bytes. Policy reuses the same evidence instead of checking again.
- Same 1,000 records, 3 warmups and 10 alternating measurements: baseline median
  1216.16 ms, current 1232.65 ms (+1.36%). Both full states and heads match. This fixes
  the measured regression, not the still-open increment/snapshot/recovery gates.
- `pnpm check` in core passes: typecheck, boundary guard, 38 files / 432 tests.
  Scoped type-aware lint has no errors. Added owned-byte/fact-isolation and invalid
  point tests; a later compile-only negative case rejects structural fake facts and
  passes typecheck. P0–P4 remains incomplete; the legacy replay/signature adapters
  and active consumer migrations are not accepted as the final architecture.
- Lab `pnpm check` also passes: typecheck and 18 files / 135 tests, including
  collaboration, hostile-backend probes, process crashes and model-free replay.
  No judge expectations were weakened. Repository-wide closure still remains.

### 2026-09-22 — P1 proof-message ownership

- Centralized joining/device proof messages in pure `operationProofJobs`, returning
  Either and owned copies. Sequential replay and batch joining-proof collection
  delegate to it; device proofs remain in replay where preceding membership is known.
- Missing device target returns unauthorized. Real-signature tests show that changing
  the target membership invalidates the proof and later mutation of input keys,
  signatures or genesis does not change an already constructed job.
- Typecheck, boundary guard and scoped type-aware lint pass. Ledger/vector/matrix
  selection: 19 tests passed; subsequent verification/executor-boundary selection:
  14 tests passed. This turn did not rerun the full suite. Signature execution and
  snapshot migration remain open; no new authority or protocol fields were introduced.

### 2026-09-22 — Snapshot computation and explicit signature Service

- Moved snapshot encoding, canonical/structural validation, state import and comparison
  into `pure/ledger-snapshot.ts` with Either failures. The old entry delegates; wire
  layout and endorsement policy are unchanged. A real-signature regression verifies
  that structurally valid forged signatures still fail trusted snapshot verification;
  parsing owns its bytes and does not manufacture trusted state.
- Record verification and enrollment now require `SignatureVerifier`. Its platform
  Layer owns a per-acquisition cache; workflows cannot silently use the global default.
  Compilation rejects running verification without supplying the Service. Real-key
  tests cover deferred input mutation and enrollment signed by the wrong device;
  the latter still returns bad-proof. Services are trusted application dependencies,
  not attacker-controlled attestations.
- Remaining workflow protocol bridges: 4. The platform adapter still delegates to
  legacy strict Ed25519, including legacy hash configuration; this is not a completed
  native crypto implementation. Whole-ledger replay still uses legacy validators.
- Core `pnpm check`: 38 files / 435 tests passed, including persisted 10k history and
  cross-process recovery. Lab `pnpm check`: 18 files / 135 passed. These full checks
  preceded the final enrollment-Service change; afterwards typecheck, boundary guard,
  scoped type-aware lint and the 30-test Effect client/types/verification selection
  passed. Root full check and remaining performance gates are still open.
- This is uncommitted work on e2448e49, not a completed P1/P2 acceptance or product
  enablement. Continue with native replay/crypto and P2 creation/storage lifecycle,
  followed by all P3/P4 consumers; do not substitute passing subsets for final gates.

### 2026-09-22 — Intent-based local genesis creation

- `LedgerClient.create` now accepts `CreateLedgerCommand`: opaque user/membership IDs,
  encryption key and distinct EpochCommitment. It owns field selection, signing,
  genesis encoding, anchor calculation and verified journal creation. Existing raw
  genesis initialization is explicitly named `importGenesis` for audit/import use.
- Real-key tests compare the complete record and anchor against the existing genesis
  fixture, reopen the journal, and reject mismatched signing keys without persistence.
  Creating a local journal does not publish genesis or prove the epoch secret was
  durably backed up; P2/P3 must still compose those lifecycles. No journal or wire
  format changed. This is not a substitute for complete Org onboarding acceptance.
- Fixed the signing adapter's deferred-byte ownership: it copies when constructing
  the Effect and supplies a fresh copy on each execution. A real deterministic
  signature test mutates the source and repeats execution; both signatures match.
- Engine hashing now uses pure wire primitives; 3 workflow protocol bridges remain.
  Typecheck, boundary guard, scoped lint (0 errors / 1 warning), and 34 Effect/client/
  vector tests passed. No full-suite or performance claim for this final change.
  Work remains uncommitted on e2448e49; the full P0–P4 objective stays open.

### 2026-09-22 — Pure journal codec and explicit Node database lifecycle

- Extracted v0/v1 journal encoding/decoding to `pure/journal-codec.ts` with typed
  Either failures, no Buffer or Node imports. The old Node entry delegates rather
  than keeping another codec. Frozen persisted strings round-trip unchanged;
  structural decoding still does not authenticate a ledger or grant authority.
- Added Node-only `./effect/platform-node` with `nodeJournalStoreLayer({path, mode})`.
  Creation uses exclusive file creation; open requires existing recognized SQLite
  storage and never initializes an empty/foreign file. Every subsequent transaction
  retains that no-create policy. Missing, existing, corrupt, foreign and busy outcomes
  remain distinct. Creation failure can leave a file; no destructive cleanup/retry.
  The directory is application-owned, not a concurrent hostile-local-filesystem model.
- Shared SQLite mechanics keep legacy defaults only for unmigrated callers. The new
  explicit layer still delegates through the Promise transaction adapter: replacing
  that adapter and migrating all callers remain open, not implicitly accepted.
- Tests: 31 client/store tests plus 80 shared-store/history/recovery tests passed.
  Coverage includes a real held SQLite lock, reopening after release, deletion after
  Layer acquisition, missing-file open, foreign/corrupt file preservation and existing
  process-crash recovery. Typecheck, pure boundary, scoped type-aware lint (0 errors),
  public boundary (5098 files / 23 manifests), diff check and docs check pass; docs
  retain 37 warnings. Full repository and performance gates remain open.

### 2026-09-22 — Effect-owned synchronous SQLite leases

- Split the shared SQLite mechanism into a synchronous `openExclusive` lease and
  a legacy Promise wrapper delegating to it. Node JournalStore now uses
  `Effect.acquireUseRelease` directly, pure journal codecs, and synchronous load/save;
  no callback rendezvous, hidden runtime or asynchronous SQLite transaction was added.
  Each save still commits independently: later failure cannot roll back persisted
  bytes that may already have been sent remotely.
- Interruption/defect tests prove lock release, preservation of saved pending bytes,
  and rejection of an escaped transaction after release. The native LedgerClient
  also creates a real database, persists a false-ACK Pending, reopens with signing
  unavailable, resumes the exact saved record and clears pending only after readback.
- Before the last integration test, 78 SQLite/store/recovery tests passed; with it,
  the 13-test journal suite passed. Typecheck, boundary guard and earlier scoped lint
  passed. The general Promise adapter still exists for unmigrated consumers and the
  shared legacy error boundary is not fully converted. No full P0–P4 or performance
  acceptance is implied; changes remain uncommitted on e2448e49.

### 2026-09-22 — P3 pure key-envelope/history computation

- Forwarding eligibility, owned recipient-key lookup, AAD, signature-domain framing
  and frame parsing now live in pure Either functions shared by legacy HPKE callers.
  Guest/machine forwarding and recovery receive-only policy are unchanged. Parsing
  owns ciphertext/signature bytes; it does not prove signature or key authenticity.
- History encryption takes an explicit nonce; entropy remains outside pure code.
  Packet collection, decryption and complete-chain commitment checking are shared
  pure computations. Formats/domains/algorithms are unchanged; missing/damaged links
  fail rather than being skipped.
- Real crypto tests cover owned values, invalid nonce size, corrupt history and
  parseable forged signatures. Key/process recovery selection: 15 passed; final
  key/snapshot/vector selection: 32 passed. Typecheck and boundary guard pass;
  scoped lint: 0 errors / 4 warnings. No new full-suite/performance acceptance.
- P3 remains partial: HPKE and entropy still run in legacy entrypoints; delivery
  retains an unknown error channel, generic authorization callback and broad catches.
  Replace those with bound recipient/current-view workflows and typed Services,
  preserving exact outbox retry and pre-dispatch authorization.

### 2026-09-22 — HPKE platform Services and opaque epoch secrets

- Moved HPKE SDK construction/handles/WebCrypto calls into one platform driver,
  shared by legacy entrypoints and native HpkeSender/HpkeRecipient Layers. Service
  construction does no crypto work; Layer acquisition and Effect execution own it.
  Captured bytes are copied before deferred execution. Recipient private handles
  never enter pure code or appear in the Service interface.
- Added EpochKey as a private-byte value with no public byte-export method; it is
  distinct from EpochCommitment. Only package-internal crypto/persistence code can
  extract a temporary copy. This is a misuse boundary, not a JavaScript sandbox.
- Known HPKE/DOM failures become CryptoError; unexpected entropy defects remain
  defects. Real seeded HPKE produces the same ciphertext as legacy envelopes,
  decrypts/reseals correctly, rejects tampering and survives source mutation.
  Compile negatives cover commitment substitution and secret byte export.
- Key/type/process-recovery selection passed 21 tests before opaque-secret tightening;
  final key/type selection passed 16. Typecheck and boundary guard pass; preceding
  scoped lint: 0 errors / 4 warnings. This is not complete P3: the current-view and
  commitment-bound envelope workflow, entropy Service, delivery outbox and other
  lifecycle modules still need migration. No protocol or product enablement change.

### 2026-09-22 — Bound envelope workflows and explicit native entropy

- Native LedgerClient now prepares/opens envelopes against refreshed verified views,
  looking up recipient encryption keys itself and checking the current commitment.
  Both paths refresh again after asynchronous crypto and reject relevant revocation
  or epoch changes. Unrelated head advances need not invalidate the operation.
- PreparedEpochEnvelope owns its ciphertext and cannot be structurally manufactured
  by a typed caller. Prepared does not mean persisted/delivered; opened EpochKey does
  not mean installed. Existing wire signatures and HPKE frames remain interoperable.
- Native HpkeSender now requires CryptoEntropy, with an explicit production Layer
  using WebCrypto and injected test Layers. Each execution requests fresh bytes;
  construction consumes none. Invalid source length is a typed generate failure;
  defects remain defects. Legacy callers retain their temporary entropy adapter.
- Verified 43 tests across ledger-keys, effect-types, effect-client and two-process
  recovery; typecheck and scoped lint pass (0 errors/warnings). Boundary guard passes
  with the same 3 declared protocol bridges. Tests include real crypto, forged
  signatures, wrong secrets/recipient handles, revocation during signing/decryption,
  deferred input ownership and separate ciphertexts per entropy generation.
- Work remains uncommitted on e2448e49. P3 remains partial: delivery still has a generic
  authorization callback and unknown/broadly caught errors. Next migrate its durable
  exact-frame outbox and pre-dispatch checks; never re-encrypt on resume. No full-suite,
  performance or P0–P4 completion claim.

### 2026-09-22 — Shared typed delivery engine

- Extracted pure delivery-id validation, exact-frame selection and observation;
  workflow owns save-before-send, repeated authorization and readback through
  KeyOutbox/KeyDeliveryRemote Services. Legacy delivery delegates to this one engine;
  its hand-written abort race and unknown public error channel were removed.
- Only typed TransportError can become Pending. Protocol rejection and adapter
  defects propagate; interruption retains ciphertext and releases the lease. The
  temporary Promise storage adapter waits for in-flight storage before releasing
  the lock. It does not start a runtime or change persisted formats.
- Deferred input is captured on construction; authorization receives copies and
  cannot mutate bytes that will be saved/sent. Tests verify these observable values,
  typed deferred invalid-id rejection, and put/read defects versus protocol rejection.
- Delivery, SQLite journal and native client selection: 43 tests passed; typecheck,
  scoped lint (0 errors/warnings) and the boundary guard passed with 3 existing bridges.
  Final lease/span follow-up: 10 delivery tests, typecheck and scoped lint passed.
  Native client-bound
  delivery authorization and direct durable outbox composition remain open; no full
  P3/P4 acceptance or new commit is claimed.

### 2026-09-22 — Client-bound outbox authorization

- Added deliverEpochEnvelope/resumeEpochDelivery to the bound client; callers no
  longer supply the authorization callback. Saved frames must match its signer,
  recipient and refreshed genesis/epoch, pass strict signature verification, and
  survive a second refresh. Resume neither signs nor invokes HPKE nor requires the
  epoch secret. Forwarding eligibility remains separate from management rights.
- DeliveryId has its own checked opaque type rather than reusing join RequestId.
  The frame and outbox formats did not change. Observed proves exact readback, not
  installation or global freshness. The explicit prepare/deliver stages are not yet
  the final single-intent lifecycle owning ID/secret preparation and persistence.
- Real-crypto tests cover Pending-to-Observed without HPKE dependencies, recipient
  substitution, sender substitution, current epoch change and device revocation;
  a compile negative distinguishes join and delivery IDs. After correcting a test
  fixture's history-seal call, typecheck and all 28 selected key/delivery/type tests
  pass. Scoped lint and boundary guard also passed before that fixture-only correction.
- Remaining: direct native durable outbox, full intent send lifecycle, other P3
  modules and P4 consumers/checks. Changes remain uncommitted on e2448e49.

### 2026-09-22 — Direct native SQLite outbox

- Added nodeKeyOutboxLayer with explicit create/open, direct synchronous SQLite
  leases owned by Effect.acquireUseRelease and no Promise transaction bridge.
  Opening missing, foreign or corrupt files fails without initialization; creation
  uses exclusive file creation. Individual saves remain durable after later failure
  or interruption; lease closure releases the OS lock.
- Moved the existing v0 payload codec into pure Either computations. Native and
  legacy stores share its implementation and unchanged format. Exact-frame selection
  rejects replacing a saved frame; bounded canonical rows and duplicate rejection
  remain enforced. Domain/codec decisions stay outside the platform wrapper.
- Final SQLite/delivery selection: 27 tests passed, including bidirectional legacy
  interoperability, fixed payload bytes, noncanonical/duplicate/unknown-version
  input, missing/foreign/corrupt files and explicit cancellation after durable save.
  Typecheck and scoped lint passed (0 errors/warnings); boundary guard passed before
  the last test-only additions with the same 3 transitional bridges.
- No whole-plan acceptance: the intent-level send lifecycle, remaining P3 modules,
  consumer migration and complete performance/check gates remain open. No commit.

### 2026-09-22 — Single-intent current-key delivery

- sendEpochKey(recipient, key) now owns preparation/save/send/readback through the
  same delivery engine. A canonical, domain-separated hash of genesis/epoch/sender/
  recipient yields a stable 16-byte local idempotency slot. This changes neither
  signed envelope nor persisted outbox format; the ID is never authority. Explicit
  prepared delivery remains an advanced boundary, not the ordinary example path.
- Under the outbox lock, saved bytes take precedence; HPKE executes only if absent.
  Preparation cannot drift to a different epoch than the chosen slot. Repeated and
  concurrent calls recheck permission and signatures without replacing the saved
  frame. No remote side effect occurs before persistence. Results return DeliveryId
  for later resume without the epoch secret.
- Real integration evidence: Pending→Observed after a new client instance, unchanged
  durable ciphertext, a retry Layer that defects if HPKE runs, decryptable output,
  and concurrent duplicate sends. Key/delivery/SQLite selection: 41 tests passed;
  typecheck, scoped lint and boundary guard passed. Full core check recorded below.
- Remaining: key-source and key-installation storage, remaining P3 lifecycle modules,
  P4 consumer migration and complete acceptance/performance. No product enablement.
- Full package `pnpm check` completed: typecheck, boundary guard (3 declared bridges),
  38 test files / 458 tests passed. The 10k persisted-chain test passed as functional
  coverage, not a reinstated timing target. Root/workspace and P4 acceptance remain open.

### 2026-09-22 — Shared pure rotation binding exposes a Lab context bug

- Candidate classification moved from Lab platform code into a core pure query,
  reached via verified Ledger/LedgerView. It checks secret/commitment, publishEpoch
  fields and presence of the exact signed record before classifying current/history.
  Historical success does not alter the current epoch; absent is not installation.
- Initial Lab lifecycle run failed 10/29 tests: DemoSession.genesis contains the
  signed genesis record, but Lab used it where the protocol requires its hash in
  epoch commitments, history AEAD and envelope AAD. Existing internal roundtrips used
  the same wrong context on both sides. Core's query made this discrepancy visible.
- Fixed Lab calls to use verified ledger.state.genesis, while retaining the signed
  record for replay/bootstrap. No core protocol or persisted schema changed. Old
  captured Lab artifacts with record-bound commitments are NOT silently migrated or
  blessed; replay compatibility cannot be claimed for those artifacts. New captures
  must come from the corrected implementation.
- Core key/snapshot selection passed 36 tests; both package typechecks passed.
  Corrected Lab lifecycle passed 29 tests. Added direct core opening of a Lab frame
  with the Org hash as an interoperability regression (final rerun below). Full
  rotation Service orchestration, persistence and installation remain open.
- Final interoperability rerun: Lab typecheck and all 29 lifecycle tests pass;
  document check and diff whitespace check pass. No new whole-core/full-Lab claim.

### 2026-09-22 — Rotation migration prerequisites: honest failure and durable install

- Before extracting the remaining state machine, inspection found two existing Lab
  lifecycle hazards: unreadable/invalid pending journals were treated as no pending,
  and candidate keys were inserted into memory before their key file was saved.
  Fixed these first rather than carrying their semantics into the native workflow.
- Pending journal read/decode failures now propagate. Submission no longer converts
  arbitrary defects/storage failures to unknown; the existing explicit replay and
  wrong-parent cases retain their handling, and transport uncertainty remains owned
  by the shared ledger engine. This is still the temporary Promise Lab boundary,
  not a claim that its throws or entire platform orchestration have been migrated.
- Candidate installation computes a separate key map, persists it, then exposes it
  in memory and clears the candidate. Failed persistence leaves the original key map
  and candidate intact; retry installs the same confirmed secret without rotation.
- Lifecycle 31 tests passed; Lab typecheck passed. Added real file-failure probes
  check committed-but-uninstalled recovery and damaged journal refusal. Scoped lint:
  0 errors / 25 warnings. Full Lab regression is running; no completion claim yet.
- Full run initially found two design probes still passing full genesis records to
  key APIs. Corrected only their context inputs; retained the authorization and
  wrong-key rejection assertions. Final Lab `pnpm check`: typecheck plus 18 files /
  137 tests passed, including independent replay and real-model attack traces.
  Complete Effect migration and root checks remain open.

### 2026-09-22 — Workspace gate and Lab static checks

- Workspace typecheck passed, including existing Electron consumers. Root check then
  stopped on 9 pre-existing Lab lint errors, before tests. Fixed the unused import,
  generator return consistency and closure-updated loop budget checks without rule
  suppressions. ScheduleDriver now selects scheduler-vs-work failure explicitly after
  cleanup rather than overriding control flow by throwing from finally.
- Root lint now passes with 0 errors / 11739 existing warnings. Focused repro-pack,
  attack-lab and runtime-permit tests: 36 passed; Lab typecheck passed. Added checks
  for zero/one minimization trials and deterministic scheduler failure priority.
- P4 is now honestly marked Partial, not Not started: shared Lab policy and boundary
  repairs are underway, but Promise consumers and platform orchestration remain.
  Root full check is being retried; neither these fixes nor warnings imply completion.

### 2026-09-22 — Root result and rotation storage extraction

- Root check terminated with exit 1: core 459 and Lab 138 tests passed, but CLI
  `worktree-gc.test.ts` expected `/private/var/...` and received `/var/...` for the
  same cleanup path. This is outside this migration's edits; not repaired or waived.
  Checks chained after test:ci did not run. Root acceptance remains unpassed.
- Extracted candidate JSON decoding/encoding into core pure, preserving the five
  hex fields, order and trailing newline. Lab now delegates instead of duplicating
  parsing. Decoding validates shape, lengths and positive safe-integer epoch only;
  it is explicitly NOT signature verification or permission to install a key.
- Storage read failures now propagate rather than being relabeled corrupt JSON.
  Lifecycle test asserts the exact read failure and unchanged candidate, ledger
  epoch and installed keys. Malformed files still fail closed without regeneration.
- New codec tests cover byte-compatible old JSON, independent decoded buffers and
  invalid fields. Core key suite: 17 passed; Lab lifecycle: 31 passed; both package
  typechecks and scoped architecture guard passed (3 bridges still remain).
  Native rotation orchestration and its storage Service remain unfinished; Lab's
  Promise boundary is still transitional, not evidence of complete purity.

### 2026-09-22 — Native rotation and recovery workflows

- Added `rotateEpoch` / `resumeEpochRotation` on the intent client, using explicit
  candidate-store and append-only keyring Services. The journal engine owns current
  authorization and signing; candidate JSON is saved before its exact bytes enter
  CAS. A saved candidate takes precedence over new generation, including retries.
- Installation requires the exact record in the verified view. Key persistence
  precedes candidate removal; interrupted/failed installation retains recovery
  material. Historical installation cannot change the current epoch: this comes
  exclusively from the ledger, not a mutable keyring current pointer.
- Missing candidate with pending publication, corrupt payload and mismatched
  candidate are separate typed failures. Conflict removes only the rejected
  candidate; Pending and Unsupported retain it. Defects/interruption are not
  converted into Pending. Tracing uses secret-free Effect spans.
- Native client suite: 27 passed, with real signatures and deterministic Services:
  save-before-CAS, save failure, pending retry with forbidden entropy, failed key
  installation, cancellation before candidate removal, concurrent recovery, missing
  candidate, malformed/mismatched candidate, and historical no-rollback recovery.
  Typecheck passed. Production storage Layers, Lab consumer migration and broader
  P3/P4 gates are still incomplete; no phase or goal completion claimed.

### 2026-09-22 — Native file storage for local rotation

- Added the pure existing-format keyring codec and append-only installation rule.
  Duplicate epochs, malformed keys and replacement of a different existing key fail
  closed. The old JSON rows/order/newline are retained; file presence is not authority.
- `nodeEpochFilesLayer` explicitly binds an Org and opens existing key data. It
  uses operational SQLite lock sidecars (no key payload), atomic file replacement
  and file/directory fsync. No stale-lock stealing, timeout-based unlocking or missing
  keyring reinitialization. Transaction handles reject use after lease release.
- This is the plaintext local/Lab compatibility adapter, not production OS-wrapped
  storage. Native workflow restart was exercised with real signing and file storage:
  pending candidate reopened without entropy, exact record committed, key installed,
  candidate removed and journal pending cleared. Additional tests cover missing and
  corrupt data, duplicate/replacement rejection, independent-handle exclusion and
  interruption releasing the lock without deleting saved bytes. Node suite: 20 tests;
  combined with native client: 47 passed. Typecheck, scoped lint and boundary guard
  passed. Lab still needs migration, and no new full-workspace acceptance is claimed.

### 2026-09-22 — Lab rotation delegates to core

- Removed Lab's duplicate candidate preparation, retry/reconciliation and installation
  algorithm. Its Promise SDK method now composes the core workflow through a temporary
  legacy-client Effect bridge; no second rotation algorithm remains in that method.
  Full native session migration and removal of transitional entrypoints remain open.
- Native file adapter accepts explicit fault-injection I/O. Production/default local
  composition keeps atomic/fsynced writes; injected LabFs remains a test capability.
  Retained the existing `history-packet-nonce` entropy label for replay continuity.
  Lab key loading now rejects malformed files instead of resetting to an empty map.
- Lifecycle tests were updated to assert typed StorageError / PendingOperationExists,
  retaining no-CAS/no-install/unchanged-file and subsequent recovery checks. A blocked
  new rotation no longer creates a candidate alongside another pending operation.
- Both package typechecks, scoped lint and 38 lifecycle/collaboration/byte-replay tests
  passed, including fresh-directory replay and cross-process recovery. Full Lab check
  is next; no claim of complete P3/P4 or full-workspace acceptance.
- Full Lab check then passed: typecheck and 18 files / 138 tests, including
  independent packs and adversarial scenarios. Inspection afterward found that the
  new entropy adapter classified replay-label defects as generic CryptoError. It now
  maps only DOMException to CryptoError, preserving other defects. The added service
  test checks the original defect diagnostic, no candidate and unchanged ledger/keys.
  An initial identity assertion failed because Effect span annotations may copy the
  Error; the diagnostic is the contract, not JavaScript object identity. Focused
  service and core checks are being rerun. The full Lab suite has not been rerun
  after this final narrow classification fix.
- Final focused rerun passed: 5 Lab service tests and 64 core key/client/storage
  tests. Scoped lint and documentation checks passed; no commit or push performed.

### 2026-09-22 — Framing prerequisite for key-stream migration

- The installed Streams client is 0.7.0 and the Lab uses its vendored streams-crdt.
  Key streams contain raw canonical-CBOR-AAD + HPKE + signature envelopes, not the
  legacy StreamsKeyDeliveryRemote framing. Reusing that adapter would change bytes;
  migration must preserve this raw format and opaque offsets.
- Added a pure incremental frame parser plus unverified delivery-ID routing. It
  carries partial headers/ciphertext between pages and returns owned buffers; it
  does not verify signatures or infer authority. Replaced the Lab scenario's manual
  CBOR walker, which treated each page as complete and padded truncated uint reads.
- An exhaustive split test initially exceeded 5 seconds because routing reused
  the checked SigningPublicKey constructor (curve checks). Separated routing bytes
  from validated key types instead of increasing the timeout or weakening actual
  envelope verification. The same test completes in about 1.2 seconds locally.
- 19 core key tests and 4 full collaboration/replay scenarios passed, along with
  both package typechecks and scoped architecture guard. The actual Lab send/outbox
  consumer migration is still next; this is its byte-compatible parsing prerequisite,
  not completion of delivery migration or P0–P4.

### 2026-09-22 — Raw epoch stream workflow

- Added an explicit EpochStream Service and KeyDeliveryRemote Layer preserving raw
  envelopes. Reads carry partial frames across opaque offsets, cap pages/bytes,
  and reject terminal truncation, cursor loops and conflicting bytes in a delivery
  slot. Matching a prefix never skips validation of the remaining stream.
- Writes compare exact observed bytes before CAS; contention is a business result,
  not a transport failure. Existing outbox readback reconciles it without resealing.
  Neither routing IDs nor remote observation grant signature/permission authority.
- Initial focused run: core typecheck and 13 delivery tests passed. After tightening
  the CAS result type, checks are rerun below. SDK platform adapter and Lab consumer
  migration remain pending; no claim of end-to-end migration or complete P0–P4.
- Final rerun passed: core/Lab typechecks, 13 delivery tests and scoped boundary
  guard (3 existing protocol bridges remain). Documentation and diff checks ran;
  no full workspace check, commit or push in this increment.

### 2026-09-22 — SDK epoch stream platform adapter

- Added `streamsEpochLayer` for the application's selected StreamsClient, without
  implicit creation, wire changes or ordinary-append fallback. Read cancellation
  reaches the SDK signal; append retains exact owned bytes (SDK CAS lacks a signal).
  Authentication/protocol errors are not Pending; transient failures remain typed.
  Error codes exclude upstream bodies/messages. Unexpected rejected SDK promises
  remain defects, rather than silently becoming transport failures.
- Real SDK tests use a deterministic HTTP peer. A new mismatch fixture initially
  omitted `Stream-CAS-Mismatch: true`; the SDK correctly treated plain 409 as a
  generic conflict. Corrected the fixture to the actual protocol, not the adapter.
  Final 51 stream/delivery tests, core/Lab typechecks and scoped lint passed.
- Next: wire this Layer and the persistent outbox into the Lab send lifecycle.
  Existing prototype send paths and the full P0–P4 completion gates remain open.

### 2026-09-22 — Lab key-delivery closed loop

- `sendCurrentEpochKey(recipient)` looks up the current secret from EpochKeyring and
  the recipient encryption key from the verified view. Callers pass the recipient
  device identity, not `recipientEncryptionKey`. `receiveEpochKey` verifies then
  `EpochKeyring.put` before reporting Installed. Failed persistence leaves the
  previous key map unchanged. Delivery outcomes are Observed or Pending plus the
  exact frame; Observed is not installation.
- Lab `DemoSession.deliverEpochKey` / `receiveEpochKey` compose `streamsEpochLayer`,
  `epochStreamDeliveryLayer` and `nodeKeyOutboxLayer`. Direct `appendCas` and
  caller-supplied recipient encryption keys were removed from that path.
  `sealEpochEnvelope` remains only at audit/test boundaries (design probes).
- Evidence, uncommitted on `e2448e49`: core typecheck; 32 key/delivery tests;
  Lab host-lifecycle 34, design-probes 25, collab-baseline 1 (60 total) including
  restart-without-re-encrypt, persist-first receive failure, pending-then-observe,
  guest forwarding, and wrong-key rejection. Boundary guard still reports 3
  protocol bridges. No root `pnpm check`, commit or push.
- Snapshot admission: moved offset/lease/identity/write-right decisions to
  `pure/snapshot-admission.ts`; `workflows/snapshot-admission.ts` verifies outside
  the lock and rechecks inside. Promise `createContentSnapshotPublication` is the
  host/SDK boundary over that single algorithm. Injected SQLite write failures
  remain defects, not `snapshot-store-corrupt`. Snapshot suites: 21 passed.
  `deviceMayWriteDocument` now lives in pure. ContentCipher and streams-crdt
  provider methods are still Promise. P0–P4 is not complete.

### 2026-09-22 — Device/user identity Effect stores

- Added `DeviceIdentityStore` / `UserIdentityStore` with explicit create vs load.
  Missing, exists, corrupt, foreign and busy are typed StorageError reasons.
  Load never generates a replacement. Node Layers wrap the existing SQLite
  stores and formats; they are not a second identity protocol.
- Electron `E2eeDeviceService` initialize/create/load and `E2eeUserService`
  create/load compose those Layers at the IPC Promise boundary. Recovery-file
  export/verify still uses the Promise user store.
- Evidence: core typecheck; Effect identity test (load-missing, create, exists,
  load-same-id); Electron node+web typecheck. Still uncommitted on `e2448e49`.
  Remaining: ContentCipher Effect, 3 protocol bridges, Lab host/content-session
  native composition, user-store recovery Effect, four-class performance, root
  `pnpm check`, and a phase commit.

### 2026-09-22 — Native verify/extend; protocol bridges removed

- `LedgerView` now wraps `InternalState`, not the throwing `Ledger` class.
  `pure/ledger-apply.ts` replays one decoded record as Either. Workflows batch
  outer and admitMember signatures with `SignatureVerifier.verifyMany` (one
  Effect, tight loop), then apply policy. admitDevice proofs still run during
  replay because the target membership comes from the preceding state.
- The engine captures `SignatureVerifier` at construction. Later execute/refresh
  /resume do not re-declare it. Promise `LedgerClient` reconstructs `Ledger`
  via `fromInternal` for `./ledger` callers.
- `workflows/protocol.ts` deleted. `check:effect-boundaries --complete` reports
  0 bridges. Evidence, uncommitted on `e2448e49`: core typecheck; 40 Effect
  client/types/verification tests; 73 key/snapshot/store/delivery tests; Lab
  typecheck. ContentCipher, Lab content-session/host, recovery-file, four-class
  performance, and root `pnpm check` remain. No commit or push.

### 2026-09-22 — Content/recovery Effect and four-class performance

- `pure/content-frame.ts` owns header encode/parse and XChaCha seal/open as
  Either. `workflows/content.ts` uses `ContentAuthority` / `ContentCrypto`.
  Promise `ContentCipher` unwraps `ContentError` to `ControlLogError`; policy
  callback throws remain defects (`unauthorized-author` still propagates).
  `inspectContent` stays a throwing unwrap of the same parser. Wire codes,
  HKDF context, nonce/messageId injection and copy-before-await are unchanged.
- `pure/recovery-file.ts` owns file parse, backup header and AEAD frames.
  `UserIdentityStore.sealBackup` / `recover` wrap the existing SQLite store.
  Electron recovery export/restore/verify compose those methods at the IPC
  Promise boundary. Lab `createStreamsContentProvider` and host `Ledger.verify`
  remain listed SDK unwraps, not second algorithms.
- Evidence: core `pnpm check` 38 files / 486 tests including 10k journal;
  `check:effect-boundaries --complete` 0 bridges; Lab `pnpm check` 18 files /
  142 tests; Electron typecheck. Four-class 1000-record medians (3 warmup / 10
  runs, Node v24.21.0): replay 1140 ms, incremental extend(+1) 1.76 ms,
  snapshot join 156 ms, journal recovery+verify 1148 ms. Replay is below the
  earlier ~1215–1268 ms baseline. Product E2EE remains off. Root `pnpm check`
  and the phase commit follow.
- Root typecheck passed, including Electron. Type-aware lint: 0 errors / 11741
  existing warnings after fixing 8 new no-shadow/consistent-return diagnostics
  in epoch-stream, node-epoch-files, ledger-keys, and host-lifecycle. `pnpm
  test:ci` then failed only CLI `worktree-gc.test.ts` (`/var` vs `/private/var`
  for the same tmpdir). That is outside this migration and was not repaired.
  Remaining chained checks after test:ci are recorded below if they run.

### 2026-09-22 — Root check: canonicalize worktree-gc paths

- WorktreeManager `hostPath` already uses `realpathIfExists`. GC scanned
  `path.join(reposDir, …)` and passed the unresolved macOS `/var/folders`
  spelling to cleanup scripts. Cleanup now receives the same canonical path
  as `hostPath`. Eligibility, backup-commit, and branch-preserve rules are
  unchanged. The test still asserts `worktree.hostPath`; it was not deleted
  or relaxed.
- Root `pnpm check` now passes: typecheck, type-aware lint (0 errors / 11741
  warnings), `test:ci` (including CLI `worktree-gc.test.ts` 11/11 and Electron),
  i18n, code-collab, platform-boundary, and public-boundary. Product E2EE
  remains off. Local commit of this path fix follows; no push.

### 2026-09-22 — Lab submit is intent-only

- Honest Lab `DemoSession.submit` no longer calls `prepare` / `encodeSignedRecord`.
  It maps the operation to a `LedgerCommand` and runs `executeEffect`, which owns
  parent selection, signing and CAS. Attack/matrix probes still assemble raw
  records at the audit boundary. `createSpace` still composes local genesis
  encoding with key persistence and remote POST; that is application Org
  onboarding, not a second submit path.
- `LedgerEngine.legacy` no longer takes a unused point-cache argument, so
  workflows import no `../ledger/` types. Core `pnpm check` now runs
  `check:effect-boundaries --complete`.
- Evidence: core/Lab typecheck; `--complete` 0 bridges; Lab host-lifecycle 34,
  design-probes 25, collab-baseline 1; core execute/submit/node-store 65.
  Product E2EE remains off. No push.

### 2026-09-22 — Lab createSpace uses intent create

- Honest `DemoSession.createSpace` persists the epoch-0 secret first, then
  `LedgerClient.create` signs genesis into the local journal. The host POST is
  still application-owned and happens after local durability. Lab no longer
  calls `encodeGenesisBody` / `encodeSignedRecord` on the ordinary path.
- Evidence: Lab typecheck; host-lifecycle 34, design-probes 25, collab-baseline 1.
  Product E2EE remains off. No push.

### 2026-09-22 — Lab join and device admission use enrollment workflows

- Honest `requestJoin` uses `prepareJoinRequest`; `admitDevice` uses
  `prepareDeviceAdmission` on the target device, then owner `executeEffect`.
  Lab `src/` no longer imports `joinRequestSigningBytes` or
  `possessionSigningBytes`. Attack probes may still assemble those bytes.
- Evidence: Lab `pnpm check` 18 files / 142 tests. Product E2EE remains off.
  No push.

### 2026-09-22 — Lab host verifies with native workflows

- Host `loadLedger`, space create, and control-CAS authorization use
  `verifyLedger` / `extendLedger` plus `LedgerView.inspectState()`. Promise
  `Ledger.verify` is gone from Lab `src/platform/host.ts`. Incoming HTTP
  still uses the throwing `decodeRecord` unwrap for request bodies.
- Evidence: Lab typecheck; host-lifecycle / design-probes / collab-baseline.
  Product E2EE remains off. No push.

### 2026-09-23 — Content Effects must not wipe snapshots

- `sealContent` / `openContent` kept working copies in the Effect closure and
  zeroed them after the first run. Re-executing the same Effect derived HKDF
  from all-zero epoch material. Construction now snapshots caller bytes;
  each run allocates working copies and wipes only those. `ContentCrypto.derive`
  copies its input and does not mutate the caller's buffer.
- Tests: re-run after caller wipe, concurrent `Effect.all`, retry after a failed
  `deriveBits`. Content suite 16/16. P0–P4 is not accepted: four-class
  performance still lacks old-version baselines for increment/snapshot/recovery.
