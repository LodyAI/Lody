# Operation result inbox and reverse-chat containment

Status: implemented
Type: architecture
Translation: current

[中文](2026-10-12-operation-inbox.zh.md)

## Abstract

Per-result continuations and reverse task chat could repeatedly restart conversations. Wakeable completion receipts now resume idle, unpaused Sessions through one coalesced queue batch; busy Sessions wait for normal release, while Stop defers results until fresh human input. A native Effect kernel owns durable scheduling and admission, with an explicitly temporary Session/ACP adapter. This PR candidate is implemented, but independent re-review, Spec approval and model/desktop acceptance remain outstanding.

## Decision and rationale

The [Session orchestration Spec](../../../../specs/session-orchestration.md) owns behavior; the [orchestration README](../../../../apps/cli/src/orchestration/README.md#completion-consumption) owns implementation and transaction contracts. This record consolidates the former investigation, reverse-chat note, design and implementation plan; their earlier revisions remain in Git history.

- Wakeable completion receipts persist an idle scheduling intent atomically with completion. Busy Sessions defer until normal release. Claim snapshots all available queue members, including passive results; only post-claim membership is immutable. Restart recovers unsubmitted intents; duplicates and empty queues cannot restart work.
- Inbox-aware Stop persists pause before cancellation. Pre-Stop queued inputs retain their history but lose execution eligibility; fresh human input carries result data, not canceled instructions. Human text, configuration and causal depth remain unchanged. Agent-authored tasks cannot clear pause.
- Stop, trusted human acceptance and actual transport start share admission. Unknown submission never replays, including user-plus-batch stale-ACP recovery; only settlement retries. Scope closure or canceled waiting does not prove resource release.
- B cannot chat back to A while A's exact Agent-authored input drives B. Single, batch and legacy paths reject before new work with `REVERSE_CHAT_FORBIDDEN`; subsequent independent input replaces that scope. This avoids a new task graph or task/note tools, but does not guarantee prevention of longer cycles or repeated outbound delegation.

The historical investigation did not identify a single change that made models send more reverse messages. [PR #1262](https://github.com/LodyAI/Lody/pull/1262) changed Agent-author display, not the ordinary execution prompt; reverting avatars was not supported as a fix. The pre-existing amplification paths were reverse task creation and per-Delivery continuation. Source inspection was not a controlled model replay.

The 2026-10-12 research borrowed durable queuing, separate admission and batched consumption from [Codex completion handling](https://github.com/openai/codex/blob/a9b0815167c27ab13719dd12d13b63e02b70d221/codex-rs/core/src/agent/control/completion.rs) and [OpenCode's coordinator](https://github.com/anomalyco/opencode/blob/4617210822bdbb31e5749751afbfb4584ccedac8/packages/core/src/session/run-coordinator.ts). Neither product's Stop semantics were adopted wholesale, and their test suites were not independently run.

## Ownership, recovery and compatibility

Effect remains locked at 4.0.2. `inbox/service.ts` owns the repository, signals and scoped fibers; `operationInboxLegacy` bridges Session input; `operation-coordinator.ts` and `workspace-cleanup-legacy.ts` are registered application entries. Platform Session resource observers bridge acquisition callbacks synchronously before spawn. Whole Session/ACP/history migration remains unfinished, as recorded in the [Effect ledger](../../proposed/architecture/2026-09-27-effect-lifecycle-migration-roadmap.md#unit-ledger).

Review of `40ef5c29cbe496f28f17ab10297cf37c3c48030f` found three adapter defects, addressed by the following contracts:

1. Journal every resource acquisition before spawning, mark incomplete acquisition persistently, union later terminal/process roots, and retain all Session owners and the producing host PID. Reopen requires a complete resource set and proven disappearance. Missing identities, Windows and unproven release remain blocked; never signal a possibly reused PID.
2. Trusted renderer/non-delegated CLI sends persist `humanInputReceipts` before activation or queuing. History fallback restores matching authorization after lost or oversized RPC; generic history, foreign receipts and canceled/terminal inputs cannot clear pause.
3. Coordinator `recoverStop()` calls independent `recoverClose()` to repair durable settlement/release/pause writes. Preserve the original failed receipt and recovery owner; never replay transport or treat repeated Scope close as recovery.

Manual Stop shares its request ID between RPC and persistent fallback, preventing late duplicates from pausing fresh input. Failed writes retain request identities for repair. Consumed payload copies follow Operation retention; permanent Session deletion removes Inbox copies. The final storage boundary is schema/Inbox protocol v2 and host launch v3. Upgrade preserves released Operations, author/input snapshots, recovery state and retired IDs; only Delivery tables and unused compatibility result copies are removed. Legacy completion backlog is never imported or replayed. Current Inbox pause, unknown submission and resource ownership remain. Completion indexes directly into Inbox; old tables, per-result claims/continuations, models and coordinator fixture are removed. Persistent result sequences cannot be reused after retention cleanup, and passive results no longer imply busy execution. `inbox/legacy.ts` only bridges current unfinished Session/ACP consumers; batch-member display format remains. Inbox has not shipped, but Operation tables have: those compatibility boundaries must not be conflated.

Source provenance is separate from display snapshots. A retained current Operation with no author snapshot but a saved `sourceTurnId` reads as minimal Agent provenance from its frozen requester Session/source Turn, using the generic `Agent` label without Role/model/catalog reconstruction. Create/chat reject delegated input without source identity before publication; ordinary human entry points remain human-authored. Reverse checks use the exact input’s Agent Session, never parent relationships. This preserves existing Operations and does not rewrite history.

Stop request details now live in one replaceable `cancelRequest` control-document slot, rather than an extra metadata ID field. The renderer persists the payload before publishing `lastCanceledTurn = cancel-request:<id>`; RPC remains an immediate fast path with the same ID. The watcher waits for matching control data and processes control arrivals on its separate cancellation chain. Legacy turn-ID markers remain supported. SQLite owns durable deduplication, so reopen and late RPC/fallback cannot pause fresh input again, while a new click has an independent ID. Resource ownership, actual-release handoff and failed-pause recovery are unchanged; this adapter adjustment does not extend the native migration.

Integration with main `09407b3b7` preserves raw ACP drain → presence clear → Turn/Inbox handoff. Presence cleanup failure retains the old execution owner. Daemon shutdown cancels history-owned work and drains/recover-closes Inbox. Merged dependency pins remain unchanged, including Streams 0.17.0 and Effect 4.0.2. Capability registration retains Inbox v2 alongside main’s new Magpie/DSH capabilities.

## Native orchestration unit

Coordinator reconciliation, coalesced wake tickets and retry fibers now run as native
Effect workflows; the application facade only composes and hands off owners. Pure
rules are separate from platform effects. Static checks forbid direct SQL, Session,
process, Promise-workflow and runtime access from the native core. A scoped SQLite
Service owns the shared Operation/Inbox connection. Semantic transactions are
synchronous and reject Effect/Promise returns. The memory Layer uses the same real
implementation and remains effectful. Unused session configuration I/O is removed
without changing the schema.

ExecutionOwner contains input, batch, resources and raw requests, and owns submission,
settlement, actual release and independent recovery. Session no longer accesses Inbox
SQL. A native close owner retains shared failed receipts and full Cause; recovery only
retries settlement. Fleet startup failure and normal stop share a phased owner, and
production automatic retry recovers that owner before replacement. Session/ACP/history
remain registered temporary adapters; this does not complete their dependency chains.

Agent-initiated turns suppress user-facing completion notices. Finalization reads the
exact completed invocation's input author, including steer handoffs, rather than
parent relationships or older input. Operation receipts, Inbox results, finalization
and release retain their behavior. Stop is rechecked after the author read. The
execution suite passes 256 tests, including Agent suppression, later human delivery
and completed history/release in both cases.

Upgrade review identified destructive Operation migration, unsupported Stop fields sent
to released CLIs, and persistent pause that old clients could never resume. The fix
retains Operations, duplicate guards, author snapshots and recovery state; removes
only Delivery scheduling data; negotiates Inbox v2 before sending new Stop fields;
and treats identity-free legacy Stop as ordinary execution cancellation without
persistent Inbox pause. This avoids inferring human authority from missing receipts,
role or author. Updated clients retain the persistent-pause contract. New tests use
real SQLite upgrade/completion, React Stop publication and the Session/Inbox boundary
for the next legacy message after Stop.

Upgrade validation: 4 CLI suites / 487 tests and 79 component tests pass. All three targeted cases fail against reviewed `552c349` source in the isolated copy and pass after restoring the fix. CLI Stop also tests released strict parsing and Inbox v2 pause / Operation cancellation fields. No full-machine upgrade or old-desktop-binary end-to-end acceptance is claimed.

The native orchestration cleanup removes the Effect.exit / thrown exception / Cause
restoration round trip from ordinary steps. Only deadline, materialization retry and
best-effort progress boundaries handle failure; interruption propagates. Immutable
store aliases and identity comparisons are removed, while activity/epoch checks remain.
The Legacy facade no longer exposes begin/prepare/submit/settle/adopt. ExecutionOwner.submit
records the submitted receipt, replacing Session's manual settlement. Queries use an
ordinary Effect-valued port instead of an unused Context.Service/Layer. Shared close
receipts, actual release, independent recovery and durable admission remain intact.

The changed intersection passes 4 suites / 339 tests, including seven native Cause /
real SQLite state cases for combined failures, deadline settlement, progress downgrade
and interruption. Shared-close failure/recovery tests now use the production execution
owner and still assert original receipts and non-replay. Counts overlap earlier evidence;
upstream Session/ACP/history migration completion is not expanded.

Merged base `0b46cc2d8e33c6feafd08c00f51089456ab1e732` without rewriting PR history. Conflict resolution keeps main's reusable Effect function conversions and lint installation/check scripts, together with Inbox admission/non-replay, exact-input notification attribution and sandbox recovery roots. The six execution, sandbox, Coordinator and Inbox suites pass 391 cases after resolution. Root types, lint (including Effect lint), format, quick boundaries and docs pass. Full CLI tests report 4137 passed, four skipped and the same Git transport failure observed before this merge; the root check remains incomplete.

The blocked-restart review was reproduced on `ea9fb9b0f` with disk SQLite reopen:
a missing resource row cannot enter automatic enumeration; an incomplete journal
cannot prove release even with an empty process table. The fix retains this conservative
automatic rule and adds `session recover-inbox`, a local offline operator entry.
A scoped platform adapter holds the Host lease before opening SQLite; all external I/O
stays there, while the native workflow checks explicit attestation and exact execution.
Known live roots, failed probes and cross-platform identities reject recovery. The
operator must independently confirm unrecorded resources as well. One transaction pauses,
retires old input, confirms release and records the attestation; failures roll it all back.
Unknown batch receipts remain unknown, no automatic intent is created, and only fresh
trusted human input resumes. No MCP recovery tool or remote RPC was added. The existing
Promise Host-lease capability remains a named platform adapter, not a new native migration claim.

Admission gates now count queued waiters and holders and evict only at zero references;
projected batch cache entries are pruned against retained SQLite receipts. Named reconcile
tracing, five removed non-null assertions, an explicit 50-member preview constant and a
private release retry receipt simplify the code. Scope failure recovery is unchanged;
close-owner comments state that delayed disposal success does not replace its original
failure receipt. No evidence justified repeating Scope.close or changing coordinator disposal.

The failing Actions runs `38378067632` and `38378068245` were read in full for
head `86553a65e`. Their actual checkout is merge `7ae334e` over base `567afa18d`,
not the standalone PR head. Seven CI groups and Desktop smoke fail before testing:
main upgraded ACP gitlinks without updating the root pnpm lockfile. The aggregate
Tests and missing Playwright video tool errors are downstream consequences. Frozen
install reproduces the same nine Claude manifest mismatches with those exact gitlinks.

Lock regeneration then hits the existing seven-day age gate. Registry integrity was
verified against main's committed adapter locks for 34 candidate artifacts; only 11
need age exceptions (ACP SDK 1.8.0; Claude Agent SDK 0.3.293 and its eight platform
artifacts; Anthropic SDK 0.132.1). The proposed exceptions are exact and preserve the
general gate. Automatic approval rejected applying broader supply-chain exceptions
without explicit user authorization; no exception or new lockfile has been applied.
The fix remains pending that decision. `pnpm check` was attempted and stops in Claude adapter compilation against the old installed SDK, so it is not validation of the upgraded dependency graph. Docs and format pass. Two moved Codex test evidence links are repaired
without changing Spec intent or approval. These runs are installation failures, not
Inbox test failures or desktop acceptance evidence.

## Current-head local verification (2026-10-13)

At `58d2e34b3`, local validation passes 371 tests across 16 suites: 204 in Inbox,
Coordinator, Operation store and dispatch watcher; 107 in the race model, progress
and MCP suites; 23 in shared control-plane/protocol/forward-compatibility suites;
and 37 in component control-plane, send resources, dispatch state and durable human
send suites. Real Host socket/resource tests were rerun outside the sandbox after
sandbox socket denial. Direct CLI, shared and component type checks and root
`check:quick` pass with the existing installed dependency graph. These results do
not validate a fresh installation of main's upgraded ACP dependencies.

Session execution and Fleet suites fail during import: main's Codex adapter declares
`@openai/codex` 0.160.1, while the committed runtime manifest remains 0.159.2. The
same manifest is present on base `567afa18d`; fresh installation alone cannot fix
that source contract mismatch. Root `pnpm check` also stops compiling the upgraded
Claude source against the old installed SDK. No runtime guard was bypassed; desktop
build/smoke and complete current-head acceptance remain blocked.

Inbox scheduling and its SQLite database are machine-local. Input admission also
consumes synchronized Session document fields (`humanInputReceipts`, `cancelRequest`
and the metadata cancellation marker), plus client-to-machine RPC. Therefore local
scheduling does not eliminate mixed client/CLI compatibility. Existing negotiated
Stop behavior and preserved Operation rows remain unchanged; no broader old-client
binary or full-machine upgrade validation was performed in this run. The existing
SQLite upgrade regression is included in the Operation store suite.

## Verification and remaining limits

Before the ACP base upgrade (head `86553a65e`), author validation included installation and checks in the actual author worktree: Node 24.21.0, pnpm 10.20.0 and locked Effect 4.0.2. `pnpm install --frozen-lockfile` succeeds without changing the lockfile. The install guard permits this checkout; the earlier assumption that it was a nested workspace was incorrect. Earlier isolated-copy results remain historical evidence, not an independent base/head review. Overlapping scopes must not be added.

| Scope | Pre-ACP-upgrade implementation evidence |
| --- | --- |
| Author-worktree intersection | 5 suites, 413 passed: Inbox, Coordinator, execution service, dispatch watcher and Fleet. Final Inbox rerun: 51 passed, including five operator recovery cases and frozen caller-event regression |
| Admission ablation | Earlier isolated-copy tests fail at both deterministic competition positions when the submission lock is removed, and pass when restored; unknown-submission non-replay assertions retained |
| SQLite / ownership | Shared in-memory completion transaction, rollback and asynchronous-callback rejection; disk reopen, actual release and shared-close recovery behavior retained |
| Types / static / format | Author-worktree root type checks, lint, format and check:quick pass; native core boundaries checked |
| pnpm check | Author-worktree run is not green: types and lint pass; CLI reports 4142 passed, 4 skipped and one Git transport failure (`context_unreadable` / remote helper aborted). Both transport source and test are unchanged from main. No independent baseline reproduction; recursive termination prevents a full-root test acceptance claim |
| Documentation | Author docs check passes; earlier 82 broken-link errors are historical (the previously absent submodule source files are now present) |

The CLI editor project now includes source and test files, so both use the same `@/*` alias. Production type checking explicitly uses `tsconfig.typecheck.json` with the previous exclusions. A real TypeScript language-server probe confirms that both a colocated test and a `tests/` file belong to the configured project and resolve `timeout-utils`; unrelated test typing errors are not claimed as fixed. Two test cleanup paths now await Coordinator shutdown before closing SQLite (144 focused cases pass). Root types, lint, format, quick boundaries and docs pass; the full check still stops at the same Git transport failure listed below.

Tests observe full provider inputs, durable rows and actual release with Deferred, injected clocks, fake timers and failure triggers. They cover eight-result batching, empty boundaries, late ninth results, event-free restart, paused/unknown non-replay, and current scheduler ownership/resource release. Earlier legacy-fixture handoff tests were retired with their contract and are not v2 acceptance. Resource tests use real independent process groups with injected process-table snapshots. No live model, complete system process-table, desktop end-to-end, merge or release acceptance is claimed.

The revised candidate requires independent re-review; the Spec stays draft. Once all Lody endpoints and Agent adapters fully support ACP steer, reconsider batched delivery during execution with application, pause, cancellation and unknown-delivery tests. This is a future maintenance condition, not current behavior or a scheduled reminder.

[PR #1523](https://github.com/LodyAI/Lody/pull/1523).

## Receipt-driven idle wake revision (2026-10-13)

Human testing found that A delegates to B and finishes before B: the prior passive-arrival contract strands the expected continuation. The user approved a queue-based wake marker. Existing `automatic_eligible` now grants scheduling eligibility, not a membership filter. Completion creates a coalesced durable intent when idle, unpaused, unblocked and without accepted input. Preparation snapshots the current queue and claims both wakeable and passive results atomically. Prepared/submitted/unknown batches retain fixed membership and non-replay; queued human input and Stop retain priority. The Spec remains draft.

Tests retain real SQLite rollback, dual-connection claims, process reopen, physical release and no-replay coverage. Prior fixed-release-watermark expectations are replaced by claim-time coalescing; post-claim arrivals still form a separate batch. Coordinator fixtures now settle the real submission receipt rather than merely append mock output. The changed intersection passes 4 suites / 158 cases in the author worktree, including atomic intent failure, passive-plus-wakeable batching, post-claim isolation, paused/unreleased restart, and duplicate/unknown non-replay. Direct CLI types, root check:quick, format and docs pass. Root pnpm check stops at the existing Claude source/installed SDK mismatch; this is not full-root acceptance. Cloud integration and interactive desktop behavior remain separate validation boundaries.

Cloud composition validation uses the same PR production code with documented local SDK/runtime pin alignment (no remote runtime uploads). Five Inbox/Coordinator/Session/dispatch/Fleet suites pass 417 cases. The Session test observes a third provider input after the ninth idle receipt and excludes the already consumed eight; it follows a real native queue wake, not a direct manual continuation. CLI/renderer build, packaged native smoke and ad-hoc signature verification pass. This is a local production-cloud integration build, not a successful root CI installation or interactive login/model acceptance claim.

## Local CI reproduction at ce194f5a (2026-10-13)

Validation pins PR source `ce194f5a030e274846b001b2e32fb8476f2c1414` and base
`567afa18d1f0d45ebbe78fca7dde2a5dde3a7536`; no merge or dependency/runtime
alignment was applied. Existing installed dependencies are used after frozen
installation fails. Components pass 564 files / 5194 tests on Node 22.18.0.
With checksum-verified official Node 22.23.1, the workflow's full rest group
passes, including Shared's 1477 tests and Electron's 219 tests; both conversation
browser specs pass all 18 cases. CLI passes 3276 tests with 3 skipped, but 48
suites cannot import because Codex manifest 0.159.2 disagrees with adapter 0.160.1.
Inbox's 55 cases pass in that full CLI run. Package typechecks without the adapter
preparation step, check:quick, format:check, document checks, contribution-policy
tests and the desktop suite contract pass.

Frozen installation still reports nine Claude importer/lockfile mismatches.
Root pnpm check and OSS desktop build fail in Claude adapter compilation against
the old installed SDK; desktop smoke therefore cannot start. The relevant ACP
gitlinks and Codex manifest are byte-identical to the pinned base. These results
do not establish clean-install, Linux CI, PR merge-tree or desktop acceptance.

Initial environment-specific failures remain recorded separately: inherited
GIT_EXEC_PATH resolves Git to the current session's credential wrapper; removing
only that variable makes all 18 native Git tests pass, including the full CLI
rerun. Node 22.18.0 lacks the WASM loading behavior needed by one Shared suite;
22.23.1 passes. Two operator-recovery tests fail during the initial concurrent
Node 24 run, then pass in both Node 22 full runs and a focused Node 24 rerun.
That first failure is not erased or attributed to a proven cause; the operator
adapter's process snapshot rejects any warning, including optional macOS memory
probe warnings. No production recovery check was weakened.

## Main integration at a4270dd81 (2026-10-13)

Merge main `a4270dd8162f94f60c13ed55eba4a5c7bcb0b1c8` into PR head
`ad8b4a4ec40ab906fcd5c03de097135856dcc358`, following the branch's existing
merge history. Preserve Inbox admission/receipts and main's independent quota
refresh, including both protocol capability keys and both appended execution
test groups. The quota test group remains byte-identical to main. The exhaustive
machine-registration test now expects the added quota capability as well.
Codex evidence links follow the restored adapter revision without changing intent.

Main's quota merge reintroduced the upgraded ACP lock graph after the runtime-pin
rollback. Frozen installation rejects that graph against the restored gitlinks;
fresh resolution also hits the unchanged release-age gate. Restore the compatible
lockfile from `c10ca8561`, whose dependency declarations and workspace settings
match this merge (the PR's CLI typecheck script is the only package-manifest
difference). This preserves quota refresh, which declares no new dependencies,
and avoids a new dependency upgrade, quarantine exception or runtime publication.

Frozen installation, complete pnpm check (including 4162 CLI tests, 4 skipped),
format/format:check, document checks against main and 113 GitHub policy tests pass.
The 358-case execution/Inbox/registration intersection also passes; it overlaps
the complete check and is not an additional test total. The CLI builds under the
2 GiB heap limit with published-bundle import checks. The OSS desktop builds and
its smoke suite passes all 6 scenarios / 40 steps. Validation uses Node 22.23.1,
native Git helpers and CI's signing configuration. No runtime guard, release-age
policy or test assertion was weakened. Matching pushed-head Actions and real
model/cloud product acceptance remain separate evidence.

## Silent manual target Stop (2026-10-14)

The user requested that stopping B's delegated turn not wake its requester A.
Keep cancellation observable through Operation lookup, but filter manual-stop
targets from automatic model receipts, including mixed batches. Stop journals
the cause in machine-local Inbox input state; HistoryWriter projects it on the
exact user turn for remote reconciliation and late-input recovery. No Session
metadata field or new RPC is introduced. The Effect admission/SQL transaction
boundary is retained; filtering is pure and I/O remains in the existing platform
adapters. A consumed result tombstone is committed with terminalization, so
restart, duplicate finish and a subsequent user input cannot recover a silent
receipt. It also preserves retention eligibility. New target work is independent;
non-user cancellation, errors and deadlines retain their reply rules.

Verification: frozen install and complete pnpm check pass (4181 CLI tests, 4 skipped). The latest Inbox/coordinator intersection passes 96 cases, including a fault-injected tombstone rollback; shared HistoryWriter/peer projection tests pass 63 cases. These overlaps are not additive. Real model and desktop acceptance were not rerun for this receipt-policy change.

Local cancellation authority precedes stale target history and deadline fallback through the native OperationRepository. A real SQLite/coordinator test covers a stopped input whose history still has partial terminal output at an expired deadline. Remote coordination uses the persisted history cause.

Finalization rechecks Stop under the SQLite writer transaction and normalizes both stored items and completion before indexing. A precomputed success cannot overtake an already committed Stop. The full check still passes; the final 156-case Inbox/coordinator/store intersection also passes.

Follow-up implementation: [PR #1553](https://github.com/LodyAI/Lody/pull/1553).

## Deterministic operator recovery verification (2026-10-17)

The two Inbox failures observed during [Roost PR #1626](https://github.com/LodyAI/Lody/pull/1626)
were reproduced with the same controlled memory-probe failure in an archive of
its unmodified main baseline `fb4d565fa235fc56f626aef50bf4721ad6e5ea42`.
The process sampler, operator adapter, recovery probe and recovery predicate have
identical Git blobs in that baseline and the original Roost head `b625473e3`.
This establishes the pre-existing warning behavior, rather than inferring
independence merely because the files were unchanged.

The success tests depended on the real machine's process and optional macOS
memory sampling. Their success therefore required a warning-free host snapshot.
The operator suite now supplies deterministic command output at the process I/O
boundary, while retaining the real Host lease, SQLite reopen, scoped platform
adapter and native workflow. Assertions cover paused recovery without replay,
absent/live known roots, unavailable probes, and the existing macOS memory-warning
refusal. A failure still retains the blocked execution and prevents its successor;
Scope exit still releases the operator lease.

This change fixes test determinism. It does not relax production release checks
or change their existing treatment of memory warnings. A separate PID-only probe
would require its own bounded behavior change and review. Effect 4.0.2, native
ownership boundaries and migration ledger facts remain unchanged.

Final verification for this fixture correction: all 63 Inbox cases and the root
`pnpm check` pass, including 4287 CLI and 5402 component cases. Formatting and
documentation checks pass; missing isolated Kimi/Pi checkouts were initialized at
the existing pins without changing the dependency graph or their tracked source.
