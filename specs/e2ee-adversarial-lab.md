# Deterministic E2EE adversarial lab

Status: draft
Translation: current

[中文](e2ee-adversarial-lab.zh.md)

## 1. Goal and scope

Use one attacking Agent to explore vulnerabilities. Deterministic programs perform every honest action: collaboration, reconnects, invitations, revocation, rotation, synchronization, and judging. The Agent can inspect or mutate backend data at explicit event boundaries and observe subsequent behavior. Findings must replay without an Agent and become regression tests.

This replaces the old demo and game tutorial direction. The target is `packages/e2ee-lab` in this repository and current branch, not a new repository or a permanent temporary-directory checkout. Keep local Node + SQLite Riverrun and real public e2ee-core, streams-crdt, Loro/Flock APIs. Do not mock cryptography, verification, or CRDT merging. No Lody product integration, protocol changes, cloud services, UI, or game.

The lab lives in `packages/e2ee-lab`. This spec remains draft: it is not a security acceptance claim or product enablement. Interface names may be refined without silently changing security boundaries.

The selected stack is **TypeScript + Effect**, not a Rust controller. Localized Effect adoption inside e2ee-core is allowed, without rewriting cryptography or the pure ledger wholesale. The [implementation plan](../.agents/notes/proposed/testing/2026-09-16-e2ee-adversarial-lab.md#implementation-plan-and-single-task-tracker) owns task status and evidence; this spec owns acceptance contracts, not a duplicate progress tracker.

## 2. Responsibilities

```text
Attack Agent ──restricted attack API──► Scheduler ──► Riverrun / network responses
                                           │
                                Deterministic honest clients
                                           │
                                  Private judge and recorder
```

| Module           | Owns                                                                  | Must not                                                      |
| ---------------- | --------------------------------------------------------------------- | ------------------------------------------------------------- |
| Honest clients   | Scripted edits, membership, key delivery, verification, sync, restart | Use an LLM for normal actions or bypass public APIs           |
| Scheduler        | Total event order, virtual time, delivery, persistence boundaries     | Depend on sleeps or OS scheduling for outcomes                |
| Attack interface | Server-visible data and mutable requests/responses                    | Expose client plaintext, keys, private traces, or judge state |
| Judge            | Property checks, convergence, recovery, evidence                      | Trust Agent success claims or HTTP status alone               |

The total order describes one execution, not a concurrency-free protocol. A and B can both read head H and submit competing CAS requests before the scheduler selects which commits first.

### 2.1 Core and Effect boundaries

| Layer                              | Owner     | Contract                                                                                                                                                                 |
| ---------------------------------- | --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Pure computation                   | e2ee-core | Ordinary TS codecs, hashes, signature algorithms, policy and state transitions; no implicit network, storage, time, randomness, environment detection or Worker creation |
| Capability ports and live adapters | e2ee-core | Explicit crypto, clock/timers, streams, storage, live authority and verification execution strategy; real algorithms, not crypto mocks                                   |
| Business workflows                 | e2ee-core | Effect for submission/recovery, key delivery, admission and resource lifecycle; preserve thin Promise entrypoints over one implementation                                |
| Scheduling and attacks             | e2ee-lab  | Pure event reducer, controlled capability implementations, attacks, recorder and judge; no reverse core dependency. AttackLab, persist, session, host, content-session, and LLM fetch clock/fs/HTTP go through Effect `LabClock`/`LabFs`/`LabHttp`; Promise entrypoints provide the same Live implementation. Crash `spawn` and CLI/fixture process lifecycle may still use Node APIs. |

Added acceptance contracts E1–E8 preserve existing protocol, policy, recovery and initial-sync rules:

- **E1 Pure computation:** identical explicit inputs produce identical results/errors without mutating inputs or earlier ledgers. Local mutation is acceptable if not leaked. Caches have explicit instance ownership and can be disabled; they neither cross runs nor change verification verdicts. Necessary crypto-library initialization has an explicit owner; tests cannot arbitrarily override global verification configuration.
- **E2 Explicit execution strategy:** ledger logic neither reads environment variables nor automatically creates Workers. Sequential verification is the deterministic baseline; parallel verification is an explicit adapter. Preserve every signature, nested proof and error-position rule. Do not add a public `verified=true` or raw boolean-results bypass.
- **E3 Closed effect boundary:** inventory and control both time reads and timers, network, files, SQLite, key generation, nonces, HPKE ephemeral keys and CRDT/Wasm clocks/randomness. An `Effect.tryPromise` wrapper alone is not injection; uncontrolled sources block the relevant replay gate.
- **E4 One workflow implementation:** keep existing Promise usage; new Effect entrypoints expose dependencies and typed errors. Promise wrappers and the lab run that same implementation, never a second simulated submit. Runtime creation/release belongs at the outer boundary, not hidden per network request. Keep the repository's Effect 3.18.4 rather than bundling an upgrade.
- **E5 Security ordering:** durably save exact pending bytes before CAS. Retain pending and read back unknown outcomes; conflicts never re-sign. Retry/cache/recovery cannot renew original expiry. Recheck live authority after asynchronous verification; add no yield/await between a final synchronous check and its protected action.
- **E6 Interruption/crash:** Fiber interruption is not network withdrawal, transaction rollback or process crash. Track dispatch and unknown outcomes explicitly. Scope handles orderly cleanup; crash tests kill/restart a process without finalizers saving state. Protect only necessary short synchronous commit regions, never entire network waits.
- **E7 Explicit scheduling:** `transition(state, event) -> { state, commands }` performs no effects. Effect interprets commands; state-changing operations obtain permission before starting. Native completion means readiness, not delivery priority. IDs derive from logical actor/operation/phase, not callback arrival order.
- **E8 Controlled, not fake:** Effect is not a sandbox; TestClock does not control third-party global timers or Wasm. Execute real SQLite/HTTP. Interleave only at declared boundaries, not arbitrary native thread instructions. Mark uncontrolled internals uncovered; compare controlled and live adapters for semantic equivalence.

These are targets, not current implementation claims. Inspection found automatic Workers, module-level caches, ambient randomness and timers: precisely the hidden dependencies to remove. Freeze detailed API shapes through early type sketches and compatibility tests, not a generic runtime platform.

## 3. Time and events

Events have stable IDs, increasing steps, virtual time, actors, operation references, and phases. Honest scripts are fixed; attacks insert actions, delay/drop messages, and cause deterministic error branches. Record the resulting complete order.

Expose at least these applicable boundaries:

1. Local edit completed.
2. Real encrypted/signed bytes generated.
3. Pending persisted, before sending.
4. Request queued, before backend commit.
5. Backend committed, before acknowledgement delivery.
6. Response received, before verification/import.
7. Verification/import finished, before document persistence.
8. Document persisted, before cursor persistence.
9. Cursor persisted, step completed.

Only applicable phases exist for an operation; do not manufacture internal behavior. “Any time” means any exposed boundary, not any CPU instruction. Public phase labels must not reveal secret event arguments. Control retries, timeouts, credential expiry, disconnects, restarts, and asynchronous completion order. Inventory Wasm/CRDT peer IDs, clocks, and randomness; uncontrolled sources prevent a reproducibility claim.

## 4. Attack capabilities and isolation

Report two modes separately:

- **External attacker:** own device keys, normal server APIs, no bypass of host authorization.
- **Malicious server:** all server-visible Riverrun data is readable/mutable; responses may be replaced, truncated, deleted, replayed, or forked per client. Deliberately bypass host authorization to exercise client defenses.

Honest-host authorization is a thin HTTP gateway in front of sqlite Riverrun. Riverrun stores ciphertext and performs CAS; it does not hold Org roles. The gateway re-reads the verified control ledger and applies membership, document-write, and key-distribution checks. Ordinary HTTP (`/readyz`, device credentials) does not expose Riverrun URLs, database paths, failpoints, or a request-header clock. Harness clock and failpoints are a separate test-only capability. Malicious-server tests continue to call `riverrunUrl` on the lab handle so a host 403 cannot stand in for client verification. Non-null join `expiresAt` is checked on the trusted admit path against the host clock; `Ledger.verify` stays timeless. A lost-ACK retry of a record that is already the ledger head is still identified. The check-to-CAS gap is not a cross-stream transaction.

Allow arbitrary attacker-generated bytes and restricted database mutations, not just canned attack buttons. Mutate through transactions at scheduler barriers or with a correct shutdown/restart procedure, accounting for WAL/sidecars and recording before/after data. Physical database corruption is an availability attack, not a signature bypass.

The attacker cannot inspect honest client files, memory, environment, keys, decrypt logs, recovery files, or judge expectations, nor modify client/judge code. Use actual sandbox/container permissions or expose only capability APIs. Two same-user processes, directory prefixes, or prompt instructions are not isolation. If isolation cannot be verified, run scripted tests only, not an unrestricted Agent.

Do not inherit a debugger's secret-bearing context into the attacking Agent. Payloads are data, never new execution instructions for clients, judge, or tools. Bound execution, input size, disk, and output; budget exhaustion is explicit, never a pass.

## 5. Proposed programming interface

```ts
interface AttackLab {
  observe(): Promise<PublicView>;
  advance(input: { steps: number }): Promise<PublicView>;
  advanceUntil(input: { actor?: string; phase: string; maxSteps: number }): Promise<PublicView>;
  readBackend(input: BackendRead): Promise<Uint8Array>;
  mutateBackend(input: BackendMutation): Promise<MutationReceipt>;
  intercept(input: ResponseMutation): Promise<MutationReceipt>;
  submitClaim(input: AttackClaim): Promise<ClaimReceipt>;
  finish(): Promise<PublicReport>;
}
```

This belongs to the lab, not e2ee-core. CLI/JSON-RPC can wrap it. `advanceUntil` is bounded and explicitly reports an unmet condition. Mutations reference the current event and exact target; stale targets fail rather than silently selecting another. Interception supports drop, delay, duplicate, replace, and per-client forks. Record actual bytes and application positions.

The Promise interface is the Agent/CLI boundary; its single internal implementation uses Effect. Initially group capabilities as Clock, Crypto/Entropy, Network, Storage, Actors and Recorder, not a service per function. Release one selected phase at a time while retaining cross-client interleavings. Commands require acknowledgements; withholding a return value after a database write is not a pre-commit pause.

`observe` exposes server metadata, public events, and reviewed error categories only. Claims can include recovered plaintext or an accepted forgery. Keep detailed judge expectations private until completion; do not create an unlimited plaintext-guessing oracle. `finish` ends attack control and runs bounded scenario cleanup without magically repairing permanently deleted data.

## 6. Replay artifacts

Record code revision/dirty-tree identity, dependency/build hashes, scenario version, initial state, virtual time, all scheduling choices, request/response bytes, database mutations, errors, and verdicts. Unrecorded host SQL or external changes invalidate replay qualification.

Keep two artifact sets:

- **Attacker view:** observations available at the time, backend ciphertext, actions, public outcomes.
- **Private reproduction bundle:** initial client states, secret random inputs/tape, expectations, and necessary full network material. Only a trusted replay runner may read it; never commit it or expose it to the Agent.

A public seed is insufficient and defeats confidentiality if it derives client keys. Explicitly inject test-only controlled randomness, never as a production default. If a library cannot accept it, retain safe initial state or add a narrow test hook and document limitations. Cryptographic algorithms remain unchanged.

Replay uses recorded actions without an LLM. Require identical event sequences, protocol bytes, admission/rejection outcomes, logical states, and verdicts. SQLite file layout, process IDs, and wall-clock duration need not match. Report the first divergent event; divergence is not successful replay.

Independent reproduction packs use format `e2ee-lab-repro/v1`. They bind scenario version, implementation identity (HEAD **and** dirty-tree hash), dependency/vendor hashes, and environment. Private device material and entropy live under a `private/` directory with restricted permissions and are not part of the attacker view or public reports. Missing private material, unsupported format/version, or environment mismatch fails closed; replay must not fall back to live entropy, clocks, or a model. Distinguish **full-execution** replay from **transport-checkpoint** replay (the latter is unimplemented). Signature verification and decryption still execute.

Auto-advance follows the explicit rule “oldest runnable event”. Explicit non-FIFO choices are recorded and replayed by identity (`actor`, `operation`, `phase`). Nested streams-crdt import/read request order is not a controlled JavaScript microtask boundary. Entropy records must be consumed exactly (label, order, length, empty tail). Multipart transport comparison rewrites delimiter boundary tokens only; protected part bodies stay byte-for-byte, and illegal bodies stay illegal. A failure fingerprint includes rule ids and related state, not only pass/violation. SIGKILL process-crash tests are in scope; power-loss of unflushed SQLite pages and other OS/FS internals are not.

## 7. Scenarios and verdicts

Start with three members and one Loro document: creation, invitations, key delivery, repeated interleaved edits, offline/reconnect, one revocation/rotation, then continued collaboration. Previously delivered historical keys cannot be taken back. The first complete attack changes real ciphertext in Riverrun, proves receiver rejection without state pollution, and replays exactly.

Expand to:

| Scenario                                                                   | Required observation                                                                                              |
| -------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| Ciphertext/signature/key-package mutation, cross-document/Org substitution | Reject; no forged import, permission grant, or durable cursor advancement past invalid data                       |
| Unauthorized append, forged invitation/role escalation                     | No admission into authenticated client state; evaluate server and client defenses separately                      |
| Competing CAS, duplicate delivery, commit then lost ACK                    | Only valid commits apply; resume existing pending rather than inventing duplicate operations                      |
| Crash between document and cursor persistence                              | No silent durable data loss after restart; duplicate import remains idempotent                                    |
| Revocation/rotation, old credentials, delayed uploads                      | Apply existing policy/cutoffs; no invented cross-stream transaction or immediate-revocation guarantee             |
| Snapshot substitution/truncation, bootstrap/live-update interleaving       | No unauthenticated snapshot acceptance; later author revocation does not invalidate historical admitted snapshots |
| Rollback, forks, forged comparison notes                                   | Test local anchors and independent comparison separately; no checked status without independent verification      |
| Key-history chain, Flock, recovery backup                                  | Real public APIs; recovery claims limited to implemented scope                                                    |

Judge confidentiality, identity/authorization, integrity, durability, availability, and detectability separately. Outcomes are `pass`, `violation`, `unavailable`, `outside-model`, or `harness-error`, not a single ambiguous success flag.

Confidentiality challenges use unknown content privately generated by honest actors; compare recovery claims privately. Backend plaintext scanning is supplementary, not cryptographic proof. Lengths, access timing, and public ledger metadata are not hidden. Authorized-member exfiltration and stolen honest endpoint keys are outside server-confidentiality guarantees.

**Not every attack is immediately detectable.** Forged signatures can be rejected. Deletion or indefinite outage demonstrates unavailability, not malicious intent. A first join receiving validly signed stale state, or facing a colluding authorized endorser and server, may need comparison with an independent honest member. Without that evidence, show the model limit rather than inventing detection.

Freshness, non-equivocation, and credential-cutoff guarantees that assume an honest backend do not automatically survive malicious-server mode. Test the 15-minute cutoff under its assumptions and classify assumption bypass separately. Require convergence within declared step bounds only after faults cease and necessary history and legitimate keys remain available. Permanent deletion does not imply recoverability.

## 8. Implementation stages and acceptance

Each stage records commands, exact versions, raw results, and unpassed items. Counts do not replace property coverage. Finish deterministic attacks and replay before adding the Agent.

Order: **P0 inventory → C1 explicit dependencies → C2 submission/recovery pilot → C3 remaining workflows → P1 persistent collaborators → P2 replay → P3 fixed attacks → P4 Agent → P5 handoff/cleanup closure**. C1–C3 are added core stages; original P0–P5 IDs remain stable. Tasks, dependencies, gates and evidence live in the [single tracker](../.agents/notes/proposed/testing/2026-09-16-e2ee-adversarial-lab.md#implementation-plan-and-single-task-tracker). P0 backs up and freezes the deletion inventory; final old-demo removal follows behavioral coverage migration, preserving the only regression evidence until then.

Done means one command runs deterministic collaboration, programmable attacks affect actual backend data, another command replays without an LLM, and reports identify the first property violation. Define CLI commands in P1 and document them; proposed names are not shipped commands.

## 9. Execution log and design changes

Append concise dated entries to the [Agent Note](../.agents/notes/proposed/testing/2026-09-16-e2ee-adversarial-lab.md): stage, discoveries, evidence, constraints, new understanding, plan amendments, blockers, and decisions requiring confirmation. Check tasks only with evidence; do not repeat ineffective checks while waiting.

Before implementation, inventory missing hooks, randomness/time controls, and isolation facilities. Implementers may choose small implementation details. Pause for confirmation before changing cryptography, weakening authorization/verification, exposing secrets, or changing the trust model. Record implementation/spec conflicts as counterexamples, not specification changes that conceal defects.

## 10. Evidence and validation status

The agreed direction is one attacking Agent with deterministic honest programs, total-order scheduling, and replay. The lab uses official sqlite Riverrun `0.3.0` and the pinned continuationOffset streams-crdt tarball. Evidence and remaining limits live in the implementation note; this spec is still draft and is not a mathematical security proof.
