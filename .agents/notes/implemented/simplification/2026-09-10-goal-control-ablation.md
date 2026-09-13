# Goal control review and ablation

Status: implemented
Translation: current

[中文](2026-09-10-goal-control-ablation.zh.md)

## Abstract

This is an independent review and item-by-item ablation of PR #554 across the main repository and two
ACP submodules. The cleanup targets only protocol-carrying fields with no independent effect, duplicate
types, unused helpers and test/implementation coupling; a fully green test run is not taken as proof
that the production path still holds. Deterministic probes found three P1 problems — startup
acknowledgement, cross-transport queue ordering, and cold-session transport selection; those are
problems awaiting a fix, not guarantees this simplification has delivered. Goal's dual-transport
contract and independent turn ownership are retained, with a recommendation to separate an action's
acceptance, start and execution end explicitly in later work.

Related: [PR #554](https://github.com/LodyAI/Lody/pull/554),
[the original decision](../architecture/2026-09-09-goal-control-plane.md),
[draft Spec](../../../../specs/session-goal-control.md).

## Scope and method

- Main repository: `4400744a..9da5c12f`. The shallow clone has no merge base with the local `main`, so
  that single commit was compared against its parent, without counting unrelated main differences.
- Core: `1aa2431..9e7503c`; Codex: `f9dbc8c..1a35bc0`, with each diff read in its submodule.
- Each new diff hunk — and, inside large hunks, each field, function, branch and test — was deleted
  temporarily one at a time; within one check's dependency graph, the next item followed only after the
  previous one was restored. Independent CLI/components/Codex batches ran in parallel, and the CLI type
  file list was confirmed not to include components. When a typecheck failed, the subsequent tests were
  not recorded as passing.
- A single-package check is not a check of every consumer; a passing item was also traced to its real
  writers, readers and user-visible behavior. For a test deletion, the remaining tests passing is an
  experimental result, not a reason to delete.
- The CLI's default production tsconfig excludes tests; the test-only tsconfig was also run and produced
  746 type diagnostics in both the parent commit and the review copy, which is not used as a passing
  signal. No diagnostic appeared in the new goal test sections, but that does not mean the whole test
  directory typechecks.
- The lifecycle defects were reproduced with synthetic fixtures, explicit deferreds and the real owner
  guard — no real sleeps, no network, and no live Codex session.

## Review findings (all P1, awaiting a fix)

### 1. RPC mistakes the end of goal execution for a start acknowledgement

`controlSessionGoal` awaits `startGoalTurn`, which awaits `continueSession`; the real
`runVisibleSessionTurn` awaits the complete turn fiber. So `turn_started` for an idle Resume/Set is not
a start acknowledgement, and a long task exceeds the facade's 10-second RPC timeout. `session/goal` also
occupies the control request's four-slot semaphore: four long-running goal requests can fill the control
channel, so later Pause/Cancel cannot reach the handler in time.

Another deterministic probe gave ordinary chat the real owner guard during the metadata await: the goal
continuation was rejected by the guard, but the void return was still reported upward as
`accepted: true, disposition: turn_started`. The recommendation is to separate the atomic slot claim, the
start acknowledgement and the complete execution promise; fire-and-forget alone does not solve duplicate
or rejected acknowledgements.

### 2. A new Pause/Clear does not invalidate a queued Resume

`pendingGoalTurnBySession` is updated only on the queue path. After the request path successfully applies
Pause/Clear, the old Resume is still in the map; once the current turn releases, it starts again and
overrides the user's updated intent. Stop/cancel likewise does not invalidate that queue. Probes verified
the `queue resume → apply pause/clear → release → resume` ordering for each case.

The recommendation is for the session owner to order both transports uniformly, and to define explicitly
how a new intent and Stop invalidate a queued or preparing action. "Keep the last element of each queue"
alone is not newest-wins for the whole session. The silent drop after three turn waits is also in tension
with the draft Spec's "nothing is dropped" guarantee; that extra policy question is not listed separately
as a P1.

### 3. The prompt fallback for a cold session's Pause/Clear cannot execute

With no live agent, the service enters the goal turn path. A restored Codex advertises both request and
prompt support for Pause/Clear; the generic resolver prefers `request`, but `buildGoalControlPrompt`
accepts only `promptMeta` or `slashCommand`, so it throws `ACP_GOAL_UNSUPPORTED`. Both actions were
reproduced through the real `AgentClient.prompt` boundary.

The recommendation is to select the transport by the current stage: choose from the prompt-supported set
when a prompt is already held, or restore the connection first and then send the status-only request,
avoiding opening a work turn for a status change. The dual-transport division of responsibility is itself
justified, but the current resolver cannot represent both the global preference and the transport that is
executable right now.

## Ablation results

The representative case of "checks green, path broken": deleting the real prompt `_meta` carrying or the
capability transport array parsing leaves every existing test passing; adding a real AgentClient/parser
probe makes it fail. Both must be kept, and what is missing is integration coverage. The complete
item-by-item matrix is at the end of this note, and the combined simplifications actually adopted are in
table B.

## The combined simplifications actually adopted (table B)

These experiments go beyond table A by eliminating call/definition relationships together, and every
affected package was rechecked after the complete cleanup. The temporary expected-failure probes live
only in `/tmp` and are not added to the repository as tests asserting that a bug exists forever.

| ID | What was deleted | What broke / did not break | Conclusion and constraints |
| --- | --- | --- | --- |
| B001 | The goal RPC timestamp: UI, runtime/facade, local schema, Loro schema/API/envelope params | Deleting any single layer's type fails; after a coordinated deletion, six packages typecheck and the target tests pass | Delete. It is only generated/carried/validated and takes no part in queueing, execution or expiry; expiry is the RPC envelope's `expiresAt`. This targets only this as-yet-unreleased new method and does not imply that a deployed mixed-version protocol may be broken. |
| B002 | `canPauseSessionGoal`, the three assertions that only test it, the empty-array constant/special branch, and the capability alias left with a single use in tests | Deleting the helper alone fails 3 tests; after removing the duplicate assertions and filtering directly, 12 helper/identity tests pass | Delete. The UI already used `goalCommands.includes`; 5 helper behavior cases are kept. The return semantics are preserved, with no promise of array reference equality across calls; the single UI caller memoizes with `useMemo`. |
| B003 | The Promise values in the waiter map, and the tests' get/await of that internal value | Map→Set fails 2 of the original tests; after switching to an explicit `continuationStarted` signal, the goal subset's 6 pass and the full execution-service's 88 pass | Delete the Promise storage, keeping the Set deduplication and the pending action map. Production only checks membership and only tests read the Promise; the container shape is not a queueing contract. |
| B004 | The new goal fixture's `hasSession=false` branch, `isCreated`/`currentModel`, the session `acpSessionId`, repo/`updateHistory`, unobserved mock wrappers and returning `agentClient`; the opaque `goal:resume:` ID prefix assertion | After the legitimate combined simplification, the goal subset's 6 pass and the final complete CLI target suite's 115 pass | Delete. Nothing reads those fixture branches/fields; the ID has no production prefix parser, and the prefix cannot prove the absence of a user message. Identity, transport, metadata, configuration invariance and queue behavior assertions are kept. |
| B005 | The resume parser unit test | After deletion the adapter's two target files pass 14 tests; breaking resume parsing again still fails the remaining prompt lifecycle tests (1 failed / 13 passed) | Delete the duplicate coverage; the set, status-only and invalid-metadata parser cases are kept. |
| B006 | The export of `GOAL_OBJECTIVE_MAX_LENGTH` | The adapter typecheck and the final 36 goal-related tests pass | Delete an export with no external caller; the constant itself is still used by both the slash and metadata paths, and the 4000 cap and its validation are kept. |
| B007 | The duplicated `goalActions` annotation in MessageHandler's private `fetchAcpCapabilities` return type | The single and combined typechecks and target tests pass, and the generated runtime forwarding is unchanged | Delete the private annotation, not the real cache/protocol field or its forwarding. |
| B008 | The two new transport type fields on Codex's locally unused `GoalCapability` | The single and combined adapter typechecks/tests pass | Delete the duplicate declaration; Core's identically named fields, the actual `CODEX_LODY_CAPABILITIES` advertisement and the CLI parser are all kept, and the latter has real readers and writers. |
| B009 | The shared export `isStatusOnlySessionGoalAction`, which had one caller | After inlining the original pause/clear check, the transport/service target tests pass and six packages typecheck | Delete the abstraction, not the restriction; a work-starting action is still not allowed on the request path. |
| B010 | The single-caller `isSystemCausedDispatch` | After inlining the delivery/goal check, the target and full service tests pass | Delete the abstraction, not the assistant-ownership / user dispatch pointer exclusion rule. |
| B011 | The `response ?? {}` fallback on the goal ACK | A legitimate `{}` ACK still passes; the old code fails the null-rejection probe, and after deleting the fallback the 9 diagnostic probes pass | Delete a null/undefined leniency path with no existing producer; an invalid response now errors explicitly. This is not an equivalent transformation under every invalid input. `goal.optional` is kept: the real Codex extMethod returns `{}` and sends a snapshot separately, so real compatibility must not be deleted by mistake. The detail differences between Core's response type and existing producers were not widened into a correction here. |
| B012 | The Core 0.1.2 / Codex-on-0.1.2 dependency upgrade (reverted in a temporary copy only) | After locally lowering the version, the Core build, Codex typecheck and 14 target tests still pass | Keep the upgrade and the corresponding lockfiles. workspace/symlink keeps resolving the new source and masks the published dependency; the older published Core contains none of the new types, so a green local run is not proof it can be published. |

## Final checks

- The Core build passes; six packages pass their formal typecheck, including Codex's examples typecheck.
- Four CLI files pass 115 tests in total (including the full execution-service's 88); to avoid the already
  verified `spawn git EPERM`, they ran in an environment that allows launching git.
- Components goal helper/identity: 12 pass; shared goal/cache: 17 pass; RPC two files: 100 pass.
- Codex goal commands, prompt lifecycle, thread goal events and control transport: 36 pass; before one
  duplicate unit test was removed, the corresponding set was 37.
- The temporary AgentClient/owner/queue diagnostic probes: 9 pass, 6 of which explicitly assert the current
  defects, which does not mean the three P1s are fixed.
- Another temporary probe exercises the real `requestSessionGoal` encoding: the set objective is fully
  preserved, contains no timestamp, and the actual output is accepted by both the local request schema and
  the Loro parameter schema (1 pass); it is not a complete server round-trip test.
- The changed files are formatted; targeted oxlint reports 0 errors / 16 warnings. This is not described as
  a repository-wide lint or `pnpm check` pass.
- public-boundary passes (4365 files, 21 manifests); docs check passes with no SHA-protected topics and the
  pre-existing AGENTS size warning; `diff --check` passes for the main repository and Codex, and the Core
  working tree is clean.
- The repository-wide `pnpm check` was not run during the review phase; it was run before the later commit:
  repository-wide typecheck and lint pass, and the test phase again produced the components
  `act is not a function`, after which that check run was ended early. So `pnpm check` did not pass, the
  full component suite did not finish, the later serial checks were not run, and no live E2E was run. The
  target tests passing must not be written up as the whole repository passing.
- `pnpm format` completed before the commit, and the one unrelated Electron test formatting change it
  produced was removed; docs check and public-boundary were then each run again and passed.

## Verification boundaries

Existing failures were not directly ruled out as described by the user: the main repository's parent commit
still has gh-shim at 5 failed / 2 passed; a representative React rendering test on the components parent
commit still reports `React.act is not a function`; and the Codex parent commit's review slash test also
times out at 40 seconds. The components suite at HEAD is 154 failed of 445 files and 888 failed of 3305
tests; no claim is made that the whole component suite was rerun on the parent commit.

No live Codex end-to-end scenario was run; the three P1s are not fixed. This change does not alter the Spec
to accommodate the implementation. As requested, nothing was committed or pushed during the review phase;
the user later explicitly authorized committing and pushing the cleanup result and this note to the existing
branch.

## The complete item-by-item ablation matrix (A001–A355)

All 355 items were executed: 197 stopped after the package typecheck failed, 59 typechecked but failed the
target tests, and 99 passed both. The table below does not treat every "failure" as evidence of usefulness:
simply deleting a referenced declaration produces syntax/type dependencies, and only eliminating the
references together while keeping legal behavior can tell whether something can be simplified; table B
records the combined experiments actually adopted. `Type` means the selected package's default tsconfig,
and for Core it checks the Codex consumer and rebuilds Core; it is not a combined typecheck of every package
and every test file. Every normal mutation was restored before the next item; one batch that stopped midway
is not counted and was restored and rerun.

Each row's position is the original line number in the reviewed commit; a hunk item is a whole-block revert,
and the others are independent deletions or conditional-branch ablations of a declaration, field, branch or
test inside a block. Some hunks contain moves/rewrites of pre-existing code, so a compile error after
deletion must not be read as proof that the whole block's design is necessary. The test column lists only the
first failure; the complete local logs are named `/tmp/goal-A<number>-type.log` and
`/tmp/goal-A<number>-test.log`. The narrow test selection: CLI transport/capability, the execution-service
goal subset, and the machine capability cache; the components goal helper; shared goal/cache; the two
existing RPC suites; and the adapter goal command / prompt lifecycle.

### `apps/cli/src/agent/acp-capabilities.test.ts`

| ID / original line | Item deleted or reverted | Type / related tests | Conclusion and constraints |
| --- | --- | --- | --- |
| A001 / 36 | getGoalCapability: () => undefined, | Type passes; test fails: fetchAcpCapabilities > uses the current working directory for capability probing | Keep: still depended on by an executed test fixture or assertion; the legitimate combined simplification is B002/B004, and the reference target alone must not be deleted. |
| A002 / 130 | test: records the goal actions the live client advertised | Type / tests pass | Keep: still depended on by an executed test fixture or assertion; the legitimate combined simplification is B002/B004, and the reference target alone must not be deleted. |
| A132 / 133 | test: records the goal actions the live client advertised | Type / tests pass | Keep: behavioral coverage of an independent input/path; the remaining tests staying green after deletion does not prove that coverage is replaceable. |
| A133 / 146 | test: leaves goal actions absent for a runtime with no goal extension | Type / tests pass | Keep: behavioral coverage of an independent input/path; the remaining tests staying green after deletion does not prove that coverage is replaceable. |
| A257 / 134 | const startupResult = createSuccessfulStartupResult(); | Type passes; test fails: fetchAcpCapabilities > records the goal actions the live client advertised | Keep: still depended on by an executed test fixture or assertion; the legitimate combined simplification is B002/B004, and the reference target alone must not be deleted. |
| A258 / 141 | const result = await fetchAcpCapabilities('registry', 'goal-agent', createSilentLogger()); | Type passes; test fails: fetchAcpCapabilities > records the goal actions the live client advertised | Keep: still depended on by an executed test fixture or assertion; the legitimate combined simplification is B002/B004, and the reference target alone must not be deleted. |
| A259 / 149 | const result = await fetchAcpCapabilities('registry', 'plain-agent', createSilentLogger()); | Type passes; test fails: fetchAcpCapabilities > leaves goal actions absent for a runtime with no goal extension | Keep: still depended on by an executed test fixture or assertion; the legitimate combined simplification is B002/B004, and the reference target alone must not be deleted. |

### `apps/cli/src/agent/acp-capabilities.ts`

| ID / original line | Item deleted or reverted | Type / related tests | Conclusion and constraints |
| --- | --- | --- | --- |
| A003 / 92 | goalActions: client.getGoalCapability()?.actions.slice(), | Type passes; test fails: fetchAcpCapabilities > records the goal actions the live client advertised | Keep: still used by capability advertisement, transport selection or prompt/ACK encoding; real wire behavior is not guaranteed by mock tests. |

### `apps/cli/src/agent/acp-capability-normalization.ts`

| ID / original line | Item deleted or reverted | Type / related tests | Conclusion and constraints |
| --- | --- | --- | --- |
| A004 / 2 | type SessionGoalAction, | Type fails; tests not run: error TS2304: Cannot find name 'SessionGoalAction'. | Keep: still used by capability advertisement, transport selection or prompt/ACK encoding; real wire behavior is not guaranteed by mock tests. |
| A005 / 15 | goalActions?: SessionGoalAction[]; | Type fails; tests not run: error TS2339: Property 'goalActions' does not exist on type 'AcpCapabilitiesResult'. | Keep: still used by capability advertisement, transport selection or prompt/ACK encoding; real wire behavior is not guaranteed by mock tests. |
| A006 / 192 | goalActions?: SessionGoalAction[]; | Type fails; tests not run: error TS2353: Object literal may only specify known properties, and 'goalActions' does not exist in type '{ sessionFork?: boolean \| undefined; ac | Keep: still used by capability advertisement, transport selection or prompt/ACK encoding; real wire behavior is not guaranteed by mock tests. |
| A007 / 230 | ...(lifecycleCapabilities.goalActions?.length ? { goalActions: lifecycleCapabilities.goalActions } : {}), | Type passes; test fails: fetchAcpCapabilities > records the goal actions the live client advertised | Keep: still used by capability advertisement, transport selection or prompt/ACK encoding; real wire behavior is not guaranteed by mock tests. |

### `apps/cli/src/agent/agent-client.ts`

| ID / original line | Item deleted or reverted | Type / related tests | Conclusion and constraints |
| --- | --- | --- | --- |
| A008 / 10 | type LodyGoalCapability, | Type fails; tests not run: error TS2304: Cannot find name 'LodyGoalCapability'. | Keep: still used by capability advertisement, transport selection or prompt/ACK encoding; real wire behavior is not guaranteed by mock tests. |
| A009 / 24 | type SessionGoalAction, | Type fails; tests not run: error TS2304: Cannot find name 'SessionGoalAction'. | Keep: still used by capability advertisement, transport selection or prompt/ACK encoding; real wire behavior is not guaranteed by mock tests. |
| A010 / 82 | import { buildGoalPromptMeta, buildGoalSlashCommandText, resolveGoalActionTransport, GOAL_CONTROL_METHOD, type GoalActionTran | Type fails; tests not run: error TS2304: Cannot find name 'GoalActionTransport'. | Keep: still used by capability advertisement, transport selection or prompt/ACK encoding; real wire behavior is not guaranteed by mock tests. |
| A011 / 1367 | getGoalCapability(): LodyGoalCapability \| undefined { return this.lodyExtensionCapabilities.goal; } resolveGoalActionTranspor | Type fails; tests not run: error TS2339: Property 'getGoalCapability' does not exist on type 'AgentClient'. | Keep: still used by capability advertisement, transport selection or prompt/ACK encoding; real wire behavior is not guaranteed by mock tests. |
| A012 / 2455 | options?: { signal?: AbortSignal; \_meta?: acp.PromptRequest['_meta']; goalControl?: GoalPromptControl; } ) { const goalPrompt | Type fails; tests not run: error TS2304: Cannot find name 'goalPrompt'. | Keep: still used by capability advertisement, transport selection or prompt/ACK encoding; real wire behavior is not guaranteed by mock tests. |
| A013 / 2490 | const promptMeta = goalPrompt?.\_meta ?? options?.\_meta; const promptPromise = this.connection?.prompt({ sessionId, prompt, .. | Type / tests pass | Keep: the metadata write on the real `connection.prompt`; the original tests stay green while the added wire probe fails. |
| A134 / 1370 | getGoalCapability(): LodyGoalCapability \| undefined { return this.lodyExtensionCapabilities.goal; } | Type fails; tests not run: error TS2339: Property 'getGoalCapability' does not exist on type 'AgentClient'. | Keep: still used by capability advertisement, transport selection or prompt/ACK encoding; real wire behavior is not guaranteed by mock tests. |
| A135 / 1374 | resolveGoalActionTransport(action: SessionGoalAction): GoalActionTransport \| null { return resolveGoalActionTransport(this.lo | Type fails; tests not run: error TS2339: Property 'resolveGoalActionTransport' does not exist on type 'AgentClient'. | Keep: still used by capability advertisement, transport selection or prompt/ACK encoding; real wire behavior is not guaranteed by mock tests. |
| A136 / 1387 | async controlGoal(action: SessionGoalAction): Promise<void> { if (this.resolveGoalActionTransport(action) !== 'request') { th | Type fails; tests not run: error TS2339: Property 'controlGoal' does not exist on type 'AgentClient'. | Keep: still used by capability advertisement, transport selection or prompt/ACK encoding; real wire behavior is not guaranteed by mock tests. |
| A137 / 1388 | if (this.resolveGoalActionTransport(action) !== 'request') { throw new Error( `[ACP_GOAL_UNSUPPORTED] Agent did not advertise | Type / tests pass | Keep: it forbids starting work on the request path, holding the turn ownership boundary. |
| A138 / 1395 | if (!sessionId \|\| !connection) { throw new Error('[ACP_GOAL_UNAVAILABLE] ACP session is not connected'); } | Type fails; tests not run: error TS18047: 'connection' is possibly 'null'. | Keep: still used by capability advertisement, transport selection or prompt/ACK encoding; real wire behavior is not guaranteed by mock tests. |
| A139 / 1398 | const response = await connection.request<unknown, { sessionId: string; action: string }>( | Type fails; tests not run: error TS2353: Object literal may only specify known properties, and 'sessionId' does not exist in type '{ action: string; }'. | Keep: still used by capability advertisement, transport selection or prompt/ACK encoding; real wire behavior is not guaranteed by mock tests. |
| A140 / 1405 | if (!parsed.success) { throw new Error( `[ACP_GOAL_INVALID_RESPONSE] Agent returned an invalid goal control response: ${parse | Type fails; tests not run: error TS18048: 'parsed.data' is possibly 'undefined'. | Keep: still used by capability advertisement, transport selection or prompt/ACK encoding; real wire behavior is not guaranteed by mock tests. |
| A141 / 1423 | private buildGoalControlPrompt( prompt: acp.ContentBlock[], control: GoalPromptControl ): { prompt: acp.ContentBlock[]; \_meta | Type fails; tests not run: error TS2339: Property 'buildGoalControlPrompt' does not exist on type 'AgentClient'. | Keep: still used by capability advertisement, transport selection or prompt/ACK encoding; real wire behavior is not guaranteed by mock tests. |
| A142 / 1426 | ): { prompt: acp.ContentBlock[]; \_meta?: acp.PromptRequest['_meta'] } { | Type fails; tests not run: error TS2353: Object literal may only specify known properties, and 'prompt' does not exist in type '{ \_meta?: { [key: string]: unknown; } \| null | Keep: still used by capability advertisement, transport selection or prompt/ACK encoding; real wire behavior is not guaranteed by mock tests. |
| A143 / 1428 | if (transport === 'promptMeta') { return { prompt, \_meta: buildGoalPromptMeta(control) }; } | Type / tests pass | Keep: the real branch that writes the goal action into prompt metadata. |
| A144 / 1431 | if (transport === 'slashCommand') { return { prompt: [{ type: 'text', text: buildGoalSlashCommandText(control) }] }; } | Type / tests pass | Keep: the slash compatibility path for an older runtime that advertises no transports. |
| A145 / 2459 | signal?: AbortSignal; | Type fails; tests not run: error TS2353: Object literal may only specify known properties, and 'signal' does not exist in type '{ \_meta?: { [key: string]: unknown; } \| null | Keep: still used by capability advertisement, transport selection or prompt/ACK encoding; real wire behavior is not guaranteed by mock tests. |
| A146 / 2460 | \_meta?: acp.PromptRequest['_meta']; | Type fails; tests not run: error TS2353: Object literal may only specify known properties, and '\_meta' does not exist in type '{ signal?: AbortSignal \| undefined; goalContr | Keep: still used by capability advertisement, transport selection or prompt/ACK encoding; real wire behavior is not guaranteed by mock tests. |
| A147 / 2466 | goalControl?: GoalPromptControl; | Type fails; tests not run: error TS2339: Property 'goalControl' does not exist on type '{ signal?: AbortSignal \| undefined; \_meta?: { [key: string]: unknown; } \| null \| und | Keep: still used by capability advertisement, transport selection or prompt/ACK encoding; real wire behavior is not guaranteed by mock tests. |
| A148 / 2472 | if (goalPrompt) { prompt = goalPrompt.prompt; } | Type / tests pass | Keep: the slash fallback must replace the original text, not compute it and discard it. |
| A260 / 1393 | const sessionId = this.acpSessionId; | Type fails; tests not run: error TS2304: Cannot find name 'sessionId'. | Keep: still used by capability advertisement, transport selection or prompt/ACK encoding; real wire behavior is not guaranteed by mock tests. |
| A261 / 1394 | const connection = this.connection; | Type fails; tests not run: error TS2663: Cannot find name 'connection'. Did you mean the instance member 'this.connection'? | Keep: still used by capability advertisement, transport selection or prompt/ACK encoding; real wire behavior is not guaranteed by mock tests. |
| A262 / 1398 | const response = await connection.request<unknown, { sessionId: string; action: string }>( GOAL_CONTROL_METHOD, { sessionId, | Type fails; tests not run: error TS2552: Cannot find name 'response'. Did you mean 'Response'? | Keep: still used by capability advertisement, transport selection or prompt/ACK encoding; real wire behavior is not guaranteed by mock tests. |
| A263 / 1402 | const parsed = z .object({ goal: LodyGoalSnapshotSchema.nullable().optional() }) .safeParse(response ?? {}); | Type fails; tests not run: error TS2304: Cannot find name 'parsed'. | Keep: still used by capability advertisement, transport selection or prompt/ACK encoding; real wire behavior is not guaranteed by mock tests. |
| A264 / 1427 | const transport = this.resolveGoalActionTransport(control.action); | Type fails; tests not run: error TS2552: Cannot find name 'transport'. Did you mean 'WebTransport'? | Keep: still used by capability advertisement, transport selection or prompt/ACK encoding; real wire behavior is not guaranteed by mock tests. |
| A265 / 2469 | const goalPrompt = options?.goalControl ? this.buildGoalControlPrompt(prompt, options.goalControl) : null; | Type fails; tests not run: error TS2304: Cannot find name 'goalPrompt'. | Keep: still used by capability advertisement, transport selection or prompt/ACK encoding; real wire behavior is not guaranteed by mock tests. |
| A266 / 2479 | ...(options?.goalControl ? { goalAction: options.goalControl.action } : {}), | Type / tests pass | Keep: the goalAction attribution on the diagnostic span, which lets logs distinguish a control turn. |

### `apps/cli/src/agent/goal-control.test.ts`

| ID / original line | Item deleted or reverted | Type / related tests | Conclusion and constraints |
| --- | --- | --- | --- |
| A014 / 1 | test: sends status-only actions out-of-band when the agent advertises them | Type passes; test fails: src/agent/goal-control.test.ts [ src/agent/goal-control.test.ts ] | Keep: still depended on by an executed test fixture or assertion; the legitimate combined simplification is B002/B004, and the reference target alone must not be deleted. |
| A149 / 16 | test: sends status-only actions out-of-band when the agent advertises them | Type / tests pass | Keep: behavioral coverage of an independent input/path; the remaining tests staying green after deletion does not prove that coverage is replaceable. |
| A150 / 26 | test: keeps work-starting actions inside a prompt even when the request lists them | Type / tests pass | Keep: behavioral coverage of an independent input/path; the remaining tests staying green after deletion does not prove that coverage is replaceable. |
| A151 / 38 | test: falls back to the slash bridge for runtimes that advertise no transports | Type / tests pass | Keep: behavioral coverage of an independent input/path; the remaining tests staying green after deletion does not prove that coverage is replaceable. |
| A152 / 45 | test: refuses actions the agent never advertised | Type / tests pass | Keep: behavioral coverage of an independent input/path; the remaining tests staying green after deletion does not prove that coverage is replaceable. |
| A153 / 58 | test: carries the action as metadata so no command text enters the conversation | Type / tests pass | Keep: behavioral coverage of an independent input/path; the remaining tests staying green after deletion does not prove that coverage is replaceable. |
| A154 / 67 | test: writes the slash bridge text a legacy runtime understands | Type / tests pass | Keep: behavioral coverage of an independent input/path; the remaining tests staying green after deletion does not prove that coverage is replaceable. |
| A267 / 9 | const capability = (overrides: Partial<LodyGoalCapability> = {}): LodyGoalCapability => ({ version: 1, actions: ['set', 'paus | Type passes; test fails: resolveGoalActionTransport > sends status-only actions out-of-band when the agent advertises them | Keep: still depended on by an executed test fixture or assertion; the legitimate combined simplification is B002/B004, and the reference target alone must not be deleted. |
| A268 / 17 | const advertised = capability({ controlActions: ['pause', 'clear'], promptActions: ['set', 'pause', 'resume', 'clear'], }); | Type passes; test fails: resolveGoalActionTransport > sends status-only actions out-of-band when the agent advertises them | Keep: still depended on by an executed test fixture or assertion; the legitimate combined simplification is B002/B004, and the reference target alone must not be deleted. |
| A269 / 29 | const advertised = capability({ controlActions: ['set', 'pause', 'resume', 'clear'], promptActions: ['set', 'resume'], }); | Type passes; test fails: resolveGoalActionTransport > keeps work-starting actions inside a prompt even when the request lists them | Keep: still depended on by an executed test fixture or assertion; the legitimate combined simplification is B002/B004, and the reference target alone must not be deleted. |
| A270 / 39 | const legacy = capability(); | Type passes; test fails: resolveGoalActionTransport > falls back to the slash bridge for runtimes that advertise no transports | Keep: still depended on by an executed test fixture or assertion; the legitimate combined simplification is B002/B004, and the reference target alone must not be deleted. |

### `apps/cli/src/agent/goal-control.ts`

| ID / original line | Item deleted or reverted | Type / related tests | Conclusion and constraints |
| --- | --- | --- | --- |
| A015 / 1 | import type \* as acp from '@agentclientprotocol/sdk'; import { LODY_EXTENSION_METHODS, type LodyGoalCapability } from 'acp-ex | Type fails; tests not run: TS2306, goal-control.ts is no longer a module after the deletion | Keep: still used by capability advertisement, transport selection or prompt/ACK encoding; real wire behavior is not guaranteed by mock tests. |
| A155 / 24 | action: SessionGoalAction; | Type fails; tests not run: error TS2339: Property 'action' does not exist on type 'GoalPromptControl'. | Keep: still used by capability advertisement, transport selection or prompt/ACK encoding; real wire behavior is not guaranteed by mock tests. |
| A156 / 36 | export function resolveGoalActionTransport( capability: LodyGoalCapability \| undefined, action: SessionGoalAction ): GoalActi | Type fails; tests not run: error TS2724: '"./goal-control"' has no exported member named 'resolveGoalActionTransport'. Did you mean 'GoalActionTransport'? | Keep: still used by capability advertisement, transport selection or prompt/ACK encoding; real wire behavior is not guaranteed by mock tests. |
| A157 / 40 | if (!capability?.actions.includes(action)) { return null; } | Type fails; tests not run: error TS18048: 'capability' is possibly 'undefined'. | Keep: still used by capability advertisement, transport selection or prompt/ACK encoding; real wire behavior is not guaranteed by mock tests. |
| A158 / 43 | if (capability.controlActions?.includes(action) && isStatusOnlySessionGoalAction(action)) { return 'request'; } | Type passes; test fails: resolveGoalActionTransport > sends status-only actions out-of-band when the agent advertises them | Keep: still used by capability advertisement, transport selection or prompt/ACK encoding; real wire behavior is not guaranteed by mock tests. |
| A159 / 46 | if (capability.promptActions?.includes(action)) { return 'promptMeta'; } | Type passes; test fails: resolveGoalActionTransport > keeps work-starting actions inside a prompt even when the request lists them | Keep: still used by capability advertisement, transport selection or prompt/ACK encoding; real wire behavior is not guaranteed by mock tests. |
| A160 / 54 | export function buildGoalPromptMeta(control: GoalPromptControl): acp.PromptRequest['_meta'] { return { lody: { goalControl: { | Type fails; tests not run: error TS2305: Module '"./goal-control"' has no exported member 'buildGoalPromptMeta'. | Keep: still used by capability advertisement, transport selection or prompt/ACK encoding; real wire behavior is not guaranteed by mock tests. |
| A161 / 67 | export function buildGoalSlashCommandText(control: GoalPromptControl): string { return control.action === 'set' ? `/goal ${(c | Type fails; tests not run: error TS2305: Module '"./goal-control"' has no exported member 'buildGoalSlashCommandText'. | Keep: still used by capability advertisement, transport selection or prompt/ACK encoding; real wire behavior is not guaranteed by mock tests. |
| A271 / 5 | export const GOAL_CONTROL_METHOD = LODY_EXTENSION_METHODS.sessionGoal; | Type fails; tests not run: error TS2305: Module '"./goal-control"' has no exported member 'GOAL_CONTROL_METHOD'. | Keep: still used by capability advertisement, transport selection or prompt/ACK encoding; real wire behavior is not guaranteed by mock tests. |
| A272 / 11 | export const GOAL_CONTINUATION_PROMPT_TEXT = 'Continue working toward the active goal.'; | Type fails; tests not run: error TS2305: Module '"@/agent/goal-control"' has no exported member 'GOAL_CONTINUATION_PROMPT_TEXT'. | Keep: still used by capability advertisement, transport selection or prompt/ACK encoding; real wire behavior is not guaranteed by mock tests. |
| A273 / 51 | return capability.controlActions \|\| capability.promptActions ? null : 'slashCommand'; | Type passes; test fails: resolveGoalActionTransport > refuses actions the agent never advertised | Keep: when an explicit transport list does not support it, it must be refused rather than treated as legacy slash. |
| A274 / 60 | ...(control.action === 'set' ? { objective: control.objective ?? '' } : {}), | Type passes; test fails: goal prompt payloads > carries the action as metadata so no command text enters the conversation | Keep: still used by capability advertisement, transport selection or prompt/ACK encoding; real wire behavior is not guaranteed by mock tests. |
| A275 / 68 | return control.action === 'set' ? `/goal ${(control.objective ?? '').trim()}` : `/goal ${control.action}`; | Type passes; test fails: goal prompt payloads > writes the slash bridge text a legacy runtime understands | Keep: still used by capability advertisement, transport selection or prompt/ACK encoding; real wire behavior is not guaranteed by mock tests. |

### `apps/cli/src/agent/lody-acp-extension.ts`

| ID / original line | Item deleted or reverted | Type / related tests | Conclusion and constraints |
| --- | --- | --- | --- |
| A016 / 43 | const GoalActionSchema = z.enum(['set', 'pause', 'resume', 'clear']); | Type fails; tests not run: error TS2304: Cannot find name 'GoalActionSchema'. | Keep: still used by capability advertisement, transport selection or prompt/ACK encoding; real wire behavior is not guaranteed by mock tests. |
| A017 / 65 | actions: z.array(GoalActionSchema), controlActions: z.array(GoalActionSchema).optional(), promptActions: z.array(GoalActionSc | Type / tests pass | Keep: reading the advertised transport set; the original tests stay green while the added parser probe fails. |

### `apps/cli/src/lib/loro/doc.ts`

| ID / original line | Item deleted or reverted | Type / related tests | Conclusion and constraints |
| --- | --- | --- | --- |
| A018 / 52 | type SessionGoalAction, | Type fails; tests not run: error TS2304: Cannot find name 'SessionGoalAction'. | Keep: real calls or protocol constraints remain, and lossless deletion was not demonstrated. |
| A019 / 1523 | goalActions?: SessionGoalAction[], | Type fails; tests not run: error TS2304: Cannot find name 'goalActions'. | Keep: real calls or protocol constraints remain, and lossless deletion was not demonstrated. |
| A020 / 1544 | goalActions, | Type fails; tests not run: error TS2740: Type '{ signal?: AbortSignal \| undefined; }' is missing the following properties from type '("clear" \| "pause" \| "resume" \| "set")[ | Keep: real calls or protocol constraints remain, and lossless deletion was not demonstrated. |
| A021 / 3219 | goalActions?: SessionGoalAction[], | Type fails; tests not run: error TS2304: Cannot find name 'goalActions'. | Keep: real calls or protocol constraints remain, and lossless deletion was not demonstrated. |
| A022 / 3245 | goalActions: goalActions?.length ? goalActions : undefined, | Type / tests pass | Keep: publishing goalActions to the machine document, which the UI actually reads; existing tests do not cover it. |

### `apps/cli/src/lib/loro/machine-document-capabilities.test.ts`

| ID / original line | Item deleted or reverted | Type / related tests | Conclusion and constraints |
| --- | --- | --- | --- |
| A023 / 159 | undefined, | Type passes; test fails: MachineDocument ACP capabilities > does not write capabilities when cancelled while opening the Machine Flock | Keep: still depended on by an executed test fixture or assertion; the legitimate combined simplification is B002/B004, and the reference target alone must not be deleted. |

### `apps/cli/src/lib/message-handler.ts`

| ID / original line | Item deleted or reverted | Type / related tests | Conclusion and constraints |
| --- | --- | --- | --- |
| A024 / 133 | type SessionGoalAction, type SessionGoalResponse, | Type fails; tests not run: error TS2304: Cannot find name 'SessionGoalAction'. | Keep: goal routing, access validation and requester identity forwarding; both RPC entry points share this boundary. |
| A025 / 2771 | private async controlSessionGoalWithAccessCheck(args: { sessionId: SessionId; action: SessionGoalAction; objective?: string; | Type fails; tests not run: error TS2551: Property 'controlSessionGoalWithAccessCheck' does not exist on type 'MessageHandler'. Did you mean 'forkSessionWithAccessCheck'? | Keep: goal routing, access validation and requester identity forwarding; both RPC entry points share this boundary. |
| A026 / 3424 | controlSessionGoal: async (args) => await this.controlSessionGoalWithAccessCheck(args), | Type / tests pass | Keep: the Loro RPC goal handler registration; deleting it makes that route unavailable. |
| A027 / 6716 | case 'session/goal': { return await this.controlSessionGoalWithAccessCheck({ ...request.params, sessionId: request.params.ses | Type fails; tests not run: error TS2322: Type '{ machineId: string; workspaceId: string; ownerSessionId?: string \| undefined; timeoutMs?: number \| undefined; method: "sessi | Keep: the local RPC's goal routing and access check. |
| A028 / 8439 | goalActions?: SessionGoalAction[]; | Type / tests pass | Delete: a duplicated return-type field on a private method; the value is still forwarded unchanged and callers do not read this annotation. |
| A162 / 2774 | private async controlSessionGoalWithAccessCheck(args: { sessionId: SessionId; action: SessionGoalAction; objective?: string; | Type fails; tests not run: error TS2551: Property 'controlSessionGoalWithAccessCheck' does not exist on type 'MessageHandler'. Did you mean 'forkSessionWithAccessCheck'? | Keep: goal routing, access validation and requester identity forwarding; both RPC entry points share this boundary. |
| A163 / 2775 | sessionId: SessionId; | Type fails; tests not run: error TS2339: Property 'sessionId' does not exist on type '{ action: "clear" \| "pause" \| "resume" \| "set"; objective?: string \| undefined; userId | Keep: goal routing, access validation and requester identity forwarding; both RPC entry points share this boundary. |
| A164 / 2776 | action: SessionGoalAction; | Type fails; tests not run: error TS2339: Property 'action' does not exist on type '{ sessionId: SessionId; objective?: string \| undefined; userId: string; }'. | Keep: goal routing, access validation and requester identity forwarding; both RPC entry points share this boundary. |
| A165 / 2777 | objective?: string; | Type fails; tests not run: error TS2339: Property 'objective' does not exist on type '{ sessionId: SessionId; action: "clear" \| "pause" \| "resume" \| "set"; userId: string; | Keep: goal routing, access validation and requester identity forwarding; both RPC entry points share this boundary. |
| A166 / 2778 | userId: string; | Type fails; tests not run: error TS2339: Property 'userId' does not exist on type '{ sessionId: SessionId; action: "clear" \| "pause" \| "resume" \| "set"; objective?: string | Keep: goal routing, access validation and requester identity forwarding; both RPC entry points share this boundary. |
| A167 / 2781 | if (access.outcome !== 'allowed') { return { type: 'session/goal_response', sessionId: args.sessionId, action: args.action, a | Type / tests pass | Keep: the security access check; an all-green run precisely shows missing denied-access coverage rather than redundancy. |
| A276 / 2780 | const access = await this.verifySessionMachineAccess(args.sessionId, args.userId); | Type fails; tests not run: error TS2304: Cannot find name 'access'. | Keep: goal routing, access validation and requester identity forwarding; both RPC entry points share this boundary. |
| A277 / 2793 | const user = await this.sessionUserResolver.resolve(args.userId); | Type fails; tests not run: error TS2304: Cannot find name 'user'. | Keep: goal routing, access validation and requester identity forwarding; both RPC entry points share this boundary. |
| A278 / 2797 | ...(args.objective ? { objective: args.objective } : {}), | Type / tests pass | Keep: the set objective is forwarded on after access validation. |

### `apps/cli/src/session/session-execution-service.ts`

| ID / original line | Item deleted or reverted | Type / related tests | Conclusion and constraints |
| --- | --- | --- | --- |
| A029 / 5 | type SessionGoalAction, type SessionGoalResponse, | Type fails; tests not run: error TS2304: Cannot find name 'SessionGoalAction'. | Keep: the session owner's queueing, startup configuration or turn ownership chain still uses this; a green mock does not stand in for real execution. |
| A030 / 60 | import { randomUUID } from 'node:crypto'; | Type fails; tests not run: error TS2304: Cannot find name 'randomUUID'. | Keep: the session owner's queueing, startup configuration or turn ownership chain still uses this; a green mock does not stand in for real execution. |
| A031 / 91 | import { GOAL_CONTINUATION_PROMPT_TEXT, type GoalPromptControl } from '@/agent/goal-control'; | Type fails; tests not run: error TS2304: Cannot find name 'GoalPromptControl'. | Keep: the session owner's queueing, startup configuration or turn ownership chain still uses this; a green mock does not stand in for real execution. |
| A032 / 106 | import { resolveDispatchAcpSessionId, resolveResumableAcpSessionId, } from './session-dispatch-logic'; | Type fails; tests not run: error TS2304: Cannot find name 'resolveDispatchAcpSessionId'. | Keep: the session owner's queueing, startup configuration or turn ownership chain still uses this; a green mock does not stand in for real execution. |
| A033 / 219 | type SessionGoalTurnRequest = { sessionId: SessionId; control: GoalPromptControl; userId: string; userName: string; userEmail | Type fails; tests not run: error TS2304: Cannot find name 'SessionGoalTurnRequest'. | Keep: the session owner's queueing, startup configuration or turn ownership chain still uses this; a green mock does not stand in for real execution. |
| A034 / 247 | goalControl?: GoalPromptControl; | Type fails; tests not run: error TS2353: Object literal may only specify known properties, and 'goalControl' does not exist in type 'TurnRuntimeState'. | Keep: the session owner's queueing, startup configuration or turn ownership chain still uses this; a green mock does not stand in for real execution. |
| A035 / 351 | goalControl?: GoalPromptControl; | Type fails; tests not run: error TS2344: Type '"goalControl" \| "invocation" \| "onTurnSettled" \| "session" \| "sessionId" \| "userTurnId"' does not satisfy the constraint 'key | Keep: the session owner's queueing, startup configuration or turn ownership chain still uses this; a green mock does not stand in for real execution. |
| A036 / 372 | export type SessionDispatchSource = 'rpc' \| 'crdt' \| 'queue' \| 'delivery' \| 'goal'; const isSystemCausedDispatch = (source: S | Type fails; tests not run: error TS2322: Type '"goal"' is not assignable to type 'SessionDispatchSource \| undefined'. | Keep the goal dispatchSource and its ownership rule; the single-caller predicate is inlined (B010) without deleting the rule. |
| A037 / 598 | goalActions?: SessionGoalAction[]; | Type fails; tests not run: error TS2339: Property 'goalActions' does not exist on type '{ modes: { id: string; name: string; description?: string \| undefined; }[]; models: | Keep: the session owner's queueing, startup configuration or turn ownership chain still uses this; a green mock does not stand in for real execution. |
| A038 / 739 | private readonly pendingGoalTurnBySession = new Map<SessionId, SessionGoalTurnRequest>(); private readonly goalTurnWaiterBySe | Type fails; tests not run: error TS2339: Property 'pendingGoalTurnBySession' does not exist on type 'SessionExecutionService'. | Keep the pending map and waiter deduplication; only the Promise value storage becomes a Set (see B003). |
| A039 / 1202 | async controlSessionGoal(options: { sessionId: SessionId; action: SessionGoalAction; objective?: string; userId: string; user | Type fails; tests not run: error TS2339: Property 'controlSessionGoal' does not exist on type 'SessionExecutionService'. | Keep: the session owner's queueing, startup configuration or turn ownership chain still uses this; a green mock does not stand in for real execution. |
| A040 / 1802 | 'sessionId' \| 'session' \| 'userTurnId' \| 'invocation' \| 'onTurnSettled' \| 'goalControl' | Type fails; tests not run: error TS2339: Property 'goalControl' does not exist on type 'Pick<VisibleSessionTurnOptions, "invocation" \| "onTurnSettled" \| "session" \| "sessio | Keep: the session owner's queueing, startup configuration or turn ownership chain still uses this; a green mock does not stand in for real execution. |
| A041 / 1810 | goalControl: options.goalControl, | Type / tests pass | Keep: carrying goalControl from execution options to the runtime; without it this becomes an ordinary prompt. |
| A042 / 3094 | ...(runtime.goalControl ? { goalControl: runtime.goalControl } : {}), | Type / tests pass | Keep: carrying goalControl from the runtime to AgentClient; without it this becomes an ordinary prompt. |
| A043 / 3669 | const executionUserTurnId = isSystemCausedDispatch(dispatchOptions?.dispatchSource) ? undefined : userTurnId; | Type / tests pass | Keep: goal must not write the user dispatch pointer; the mock continuation does not cover real history ownership. |
| A044 / 4393 | ...(dispatchOptions?.goalControl ? { goalControl: dispatchOptions.goalControl } : {}), | Type / tests pass | Keep: carrying goalControl from dispatch options to the runtime. |
| A045 / 5267 | capabilities.acknowledgedSteer, capabilities.goalActions | Type / tests pass | Keep: live capability into the machine capability cache; the buttons depend on that data. |
| A046 / 5577 | goalActions, | Type fails; tests not run: error TS2304: Cannot find name 'goalActions'. | Keep: the session owner's queueing, startup configuration or turn ownership chain still uses this; a green mock does not stand in for real execution. |
| A047 / 5618 | goalActions, | Type fails; tests not run: error TS2353: Object literal may only specify known properties, and 'signal' does not exist in type '("clear" \| "pause" \| "resume" \| "set")[]'. | Keep: the session owner's queueing, startup configuration or turn ownership chain still uses this; a green mock does not stand in for real execution. |
| A168 / 223 | sessionId: SessionId; | Type fails; tests not run: error TS2353: Object literal may only specify known properties, and 'sessionId' does not exist in type 'SessionGoalTurnRequest'. | Keep: the session owner's queueing, startup configuration or turn ownership chain still uses this; a green mock does not stand in for real execution. |
| A169 / 224 | control: GoalPromptControl; | Type fails; tests not run: error TS2353: Object literal may only specify known properties, and 'control' does not exist in type 'SessionGoalTurnRequest'. | Keep: the session owner's queueing, startup configuration or turn ownership chain still uses this; a green mock does not stand in for real execution. |
| A170 / 225 | userId: string; | Type fails; tests not run: error TS2353: Object literal may only specify known properties, and 'userId' does not exist in type 'SessionGoalTurnRequest'. | Keep: the session owner's queueing, startup configuration or turn ownership chain still uses this; a green mock does not stand in for real execution. |
| A171 / 226 | userName: string; | Type fails; tests not run: error TS2353: Object literal may only specify known properties, and 'userName' does not exist in type 'SessionGoalTurnRequest'. | Keep: the session owner's queueing, startup configuration or turn ownership chain still uses this; a green mock does not stand in for real execution. |
| A172 / 227 | userEmail: string; | Type fails; tests not run: error TS2353: Object literal may only specify known properties, and 'userEmail' does not exist in type 'SessionGoalTurnRequest'. | Keep: the session owner's queueing, startup configuration or turn ownership chain still uses this; a green mock does not stand in for real execution. |
| A173 / 388 | goalControl?: GoalPromptControl; | Type fails; tests not run: error TS2353: Object literal may only specify known properties, and 'goalControl' does not exist in type 'SessionDispatchOptions'. | Keep: the session owner's queueing, startup configuration or turn ownership chain still uses this; a green mock does not stand in for real execution. |
| A174 / 1215 | async controlSessionGoal(options: { sessionId: SessionId; action: SessionGoalAction; objective?: string; userId: string; user | Type fails; tests not run: error TS2339: Property 'controlSessionGoal' does not exist on type 'SessionExecutionService'. | Keep: the session owner's queueing, startup configuration or turn ownership chain still uses this; a green mock does not stand in for real execution. |
| A175 / 1216 | sessionId: SessionId; | Type fails; tests not run: error TS2353: Object literal may only specify known properties, and 'sessionId' does not exist in type '{ action: "clear" \| "pause" \| "resume" \| | Keep: the session owner's queueing, startup configuration or turn ownership chain still uses this; a green mock does not stand in for real execution. |
| A176 / 1217 | action: SessionGoalAction; | Type fails; tests not run: error TS2353: Object literal may only specify known properties, and 'action' does not exist in type '{ sessionId: SessionId; objective?: string \| | Keep: the session owner's queueing, startup configuration or turn ownership chain still uses this; a green mock does not stand in for real execution. |
| A177 / 1218 | objective?: string; | Type fails; tests not run: error TS2339: Property 'objective' does not exist on type '{ sessionId: SessionId; action: "clear" \| "pause" \| "resume" \| "set"; userId: string; | Keep: the session owner's queueing, startup configuration or turn ownership chain still uses this; a green mock does not stand in for real execution. |
| A178 / 1219 | userId: string; | Type fails; tests not run: error TS2353: Object literal may only specify known properties, and 'userId' does not exist in type '{ sessionId: SessionId; action: "clear" \| "p | Keep: the session owner's queueing, startup configuration or turn ownership chain still uses this; a green mock does not stand in for real execution. |
| A179 / 1220 | userName: string; | Type fails; tests not run: error TS2353: Object literal may only specify known properties, and 'userName' does not exist in type '{ sessionId: SessionId; action: "clear" \| | Keep: the session owner's queueing, startup configuration or turn ownership chain still uses this; a green mock does not stand in for real execution. |
| A180 / 1221 | userEmail: string; | Type fails; tests not run: error TS2353: Object literal may only specify known properties, and 'userEmail' does not exist in type '{ sessionId: SessionId; action: "clear" \| | Keep: the session owner's queueing, startup configuration or turn ownership chain still uses this; a green mock does not stand in for real execution. |
| A181 / 1238 | if (agentClient) { const transport = agentClient.resolveGoalActionTransport(action); if (transport === null) { return respond | Type passes; test fails: SessionExecutionService goal control > pauses out-of-band without opening a turn | Keep: with a live agent, prefer the capability/request path rather than queueing everything. |
| A182 / 1240 | if (transport === null) { return respond('unsupported', `Agent does not support goal ${action}`); } | Type passes; test fails: SessionExecutionService goal control > refuses an action the agent never advertised | Keep: it refuses an unadvertised action, avoiding a fabricated `accepted` or an ordinary chat. |
| A183 / 1243 | if (transport === 'request') { try { await agentClient.controlGoal(action); return respond('applied'); } catch (error) { this | Type passes; test fails: SessionExecutionService goal control > pauses out-of-band without opening a turn | Keep: a status action bypasses the occupied prompt; this is the core fix path. |
| A184 / 1269 | if (this.getExecutionSnapshot(sessionId).hasActiveTurn) { this.queueGoalTurn(request); return respond('queued'); } | Type passes; test fails: SessionExecutionService goal control > waits for the running turn to release instead of dropping the resume | Keep: queue while busy; starting directly when idle cannot replace this branch. |
| A185 / 1290 | private queueGoalTurn(request: SessionGoalTurnRequest): void { const { sessionId } = request; this.pendingGoalTurnBySession.s | Type fails; tests not run: error TS2339: Property 'queueGoalTurn' does not exist on type 'SessionExecutionService'. | Keep: the session owner's queueing, startup configuration or turn ownership chain still uses this; a green mock does not stand in for real execution. |
| A186 / 1293 | if (this.goalTurnWaiterBySession.has(sessionId)) { return; } | Type passes; test fails: SessionExecutionService goal control > keeps only the newest queued action so a stale pause cannot undo a resume | Keep: one waiter per session, avoiding a duplicate continuation. |
| A187 / 1300 | if (!snapshot.hasActiveTurn \|\| !snapshot.activeTurnId) { break; } | Type fails; tests not run: error TS2345: Argument of type 'string \| undefined' is not assignable to parameter of type 'string'. | Keep: end the wait once the session releases, preventing a pointless wait or reading an empty turn. |
| A188 / 1308 | if (!pending) return; | Type fails; tests not run: error TS18048: 'pending' is possibly 'undefined'. | Keep: a queue entry may be cleaned up incorrectly, so its presence must be confirmed before starting. |
| A189 / 1309 | if (this.getExecutionSnapshot(sessionId).hasActiveTurn) { this.deps.logger.warn( `[${sessionId}] Dropping queued goal ${pendi | Type / tests pass | Keep: it must not start concurrently when still busy at the wait limit; the drop policy is a separate open question. |
| A190 / 1326 | private async startGoalTurn(request: SessionGoalTurnRequest): Promise<void> { const { sessionId, control } = request; const s | Type fails; tests not run: error TS2339: Property 'startGoalTurn' does not exist on type 'SessionExecutionService'. | Keep: the session owner's queueing, startup configuration or turn ownership chain still uses this; a green mock does not stand in for real execution. |
| A191 / 1330 | if (!meta) { throw new Error(`Session ${sessionId} has no metadata`); } | Type fails; tests not run: error TS18048: 'meta' is possibly 'undefined'. | Keep: the session owner's queueing, startup configuration or turn ownership chain still uses this; a green mock does not stand in for real execution. |
| A192 / 1333 | if (meta.isArchived) { throw new Error(`Session ${sessionId} is archived`); } | Type / tests pass | Keep: an archived session must not be restarted by goal control; the current narrow tests do not cover it. |
| A193 / 1336 | if (!meta.cliType \|\| !meta.agentType) { throw new Error(`Session ${sessionId} has no agent configuration`); } | Type / tests pass | Keep: give an explicit startup error when there is no agent configuration; the runtime must not be chosen implicitly. |
| A279 / 235 | const GOAL_TURN_QUEUE_MAX_WAITS = 3; | Type fails; tests not run: error TS2304: Cannot find name 'GOAL_TURN_QUEUE_MAX_WAITS'. | Keep: the queue wait limit has a real scheduling effect; it is not a dead constant, and the policy question is discussed separately. |
| A280 / 382 | const isSystemCausedDispatch = (source: SessionDispatchSource \| undefined): boolean => source === 'delivery' \|\| source === 'g | Type fails; tests not run: error TS2304: Cannot find name 'isSystemCausedDispatch'. | Delete the single-caller predicate abstraction and inline the same check, keeping the delivery/goal user pointer exclusion (B010). |
| A281 / 1223 | const { sessionId, action } = options; | Type fails; tests not run: error TS18004: No value exists in scope for the shorthand property 'sessionId'. Either declare one or provide an initializer. | Keep: the session owner's queueing, startup configuration or turn ownership chain still uses this; a green mock does not stand in for real execution. |
| A282 / 1224 | const respond = ( disposition: SessionGoalResponse['disposition'], error?: string ): SessionGoalResponse => ({ type: 'session | Type fails; tests not run: error TS2304: Cannot find name 'respond'. | Keep: the session owner's queueing, startup configuration or turn ownership chain still uses this; a green mock does not stand in for real execution. |
| A283 / 1234 | ...(error ? { error } : {}), | Type / tests pass | Keep: a failure response carries a visible error message. |
| A284 / 1237 | const agentClient = this.deps.sessionManager.getSession(sessionId)?.agentClient; | Type fails; tests not run: error TS2304: Cannot find name 'agentClient'. | Keep: the session owner's queueing, startup configuration or turn ownership chain still uses this; a green mock does not stand in for real execution. |
| A285 / 1239 | const transport = agentClient.resolveGoalActionTransport(action); | Type fails; tests not run: error TS2552: Cannot find name 'transport'. Did you mean 'WebTransport'? | Keep: the session owner's queueing, startup configuration or turn ownership chain still uses this; a green mock does not stand in for real execution. |
| A286 / 1258 | const control: GoalPromptControl = { action, ...(options.objective ? { objective: options.objective } : {}), }; | Type fails; tests not run: error TS18004: No value exists in scope for the shorthand property 'control'. Either declare one or provide an initializer. | Keep: the session owner's queueing, startup configuration or turn ownership chain still uses this; a green mock does not stand in for real execution. |
| A287 / 1260 | ...(options.objective ? { objective: options.objective } : {}), | Type / tests pass | Keep: the set objective is written into the pending control object. |
| A288 / 1262 | const request: SessionGoalTurnRequest = { sessionId, control, userId: options.userId, userName: options.userName, userEmail: | Type fails; tests not run: error TS2552: Cannot find name 'request'. Did you mean 'Request'? | Keep: the session owner's queueing, startup configuration or turn ownership chain still uses this; a green mock does not stand in for real execution. |
| A289 / 1291 | const { sessionId } = request; | Type fails; tests not run: error TS2304: Cannot find name 'sessionId'. | Keep: the session owner's queueing, startup configuration or turn ownership chain still uses this; a green mock does not stand in for real execution. |
| A290 / 1296 | const waiter = (async () => { for (let attempt = 0; attempt < GOAL_TURN_QUEUE_MAX_WAITS; attempt += 1) { const snapshot = thi | Type fails; tests not run: error TS2304: Cannot find name 'waiter'. | Keep the async waiter; only the Promise value storage is removed (B003). |
| A291 / 1299 | const snapshot = this.getExecutionSnapshot(sessionId); | Type fails; tests not run: error TS2304: Cannot find name 'snapshot'. | Keep: the session owner's queueing, startup configuration or turn ownership chain still uses this; a green mock does not stand in for real execution. |
| A292 / 1305 | const pending = this.pendingGoalTurnBySession.get(sessionId); | Type fails; tests not run: error TS2304: Cannot find name 'pending'. | Keep: the session owner's queueing, startup configuration or turn ownership chain still uses this; a green mock does not stand in for real execution. |
| A293 / 1327 | const { sessionId, control } = request; | Type fails; tests not run: error TS2552: Cannot find name 'sessionId'. Did you mean 'sessionDoc'? | Keep: the session owner's queueing, startup configuration or turn ownership chain still uses this; a green mock does not stand in for real execution. |
| A294 / 1328 | const sessionDoc = await this.deps.workspaceDocument.getOrCreateSessionDoc(sessionId); | Type fails; tests not run: error TS2552: Cannot find name 'sessionDoc'. Did you mean 'sessionId'? | Keep: the session owner's queueing, startup configuration or turn ownership chain still uses this; a green mock does not stand in for real execution. |
| A295 / 1329 | const meta = await sessionDoc.getMetaState(); | Type fails; tests not run: error TS2304: Cannot find name 'meta'. | Keep: the session owner's queueing, startup configuration or turn ownership chain still uses this; a green mock does not stand in for real execution. |
| A296 / 1339 | const resumeAcpSessionId = resolveDispatchAcpSessionId(meta); | Type fails; tests not run: error TS2304: Cannot find name 'resumeAcpSessionId'. | Keep: the session owner's queueing, startup configuration or turn ownership chain still uses this; a green mock does not stand in for real execution. |
| A297 / 1346 | ...(meta.project ? { project: meta.project } : {}), | Type / tests pass | Keep: it carries the session's project ownership forward. |
| A298 / 1354 | ...(resumeAcpSessionId ? { resume: resumeAcpSessionId } : {}), | Type / tests pass | Keep: it restores the original ACP session rather than creating a new one that loses the goal. |

### `apps/cli/src/session/session.ts`

| ID / original line | Item deleted or reverted | Type / related tests | Conclusion and constraints |
| --- | --- | --- | --- |
| A048 / 665 | goalActions: started.client.getGoalCapability()?.actions.slice(), | Type / tests pass | Keep: goalActions are synced at session startup and cannot rely on an active probe alone. |

### `apps/cli/tests/session-execution-service.test.ts`

| ID / original line | Item deleted or reverted | Type / related tests | Conclusion and constraints |
| --- | --- | --- | --- |
| A049 / 2446 | true, undefined | Type / tests pass | Keep: the expectation for the new optional positional parameter; the narrow goal filter did not run the test holding the original assertion. |
| A050 / 6171 | undefined, | Type / tests pass | Keep: the expectation for the new optional positional parameter; the narrow goal filter did not run the test holding the original assertion. |
| A051 / 6529 | test: pauses out-of-band without opening a turn | Type / tests pass | Keep: still depended on by an executed test fixture or assertion; the legitimate combined simplification is B002/B004, and the reference target alone must not be deleted. |
| A194 / 6538 | transport?: 'request' \| 'promptMeta' \| 'slashCommand' \| null; | Type / tests pass | Keep: the fixture transport option still has null/promptMeta callers. |
| A195 / 6539 | hasSession?: boolean; | Type / tests pass | Delete: the fixture has no `hasSession=false` caller; deleted together with the dead branch (B004). |
| A196 / 6583 | test: pauses out-of-band without opening a turn | Type / tests pass | Keep: behavioral coverage of an independent input/path; the remaining tests staying green after deletion does not prove that coverage is replaceable. |
| A197 / 6596 | test: refuses an action the agent never advertised | Type / tests pass | Keep: behavioral coverage of an independent input/path; the remaining tests staying green after deletion does not prove that coverage is replaceable. |
| A198 / 6606 | test: starts a Lody-owned turn for an action that resumes work | Type / tests pass | Keep: behavioral coverage of an independent input/path; the remaining tests staying green after deletion does not prove that coverage is replaceable. |
| A199 / 6625 | test: waits for the running turn to release instead of dropping the resume | Type / tests pass | Keep: behavioral coverage of an independent input/path; the remaining tests staying green after deletion does not prove that coverage is replaceable. |
| A200 / 6629 | currentTurnBySession: Map<SessionId, string>; | Type / tests pass | Keep: the test does access `currentTurnBySession`; the production tsconfig does not check test casts. |
| A201 / 6630 | clearCurrentTurn: (sessionId: SessionId, turnId?: string) => void; | Type / tests pass | Keep: the test emits a deterministic release signal through `clearCurrentTurn`. |
| A202 / 6631 | goalTurnWaiterBySession: Map<SessionId, Promise<void>>; | Type / tests pass | Delete: tests no longer read the waiter Promise and await the continuation signal instead (B003). |
| A203 / 6647 | test: keeps only the newest queued action so a stale pause cannot undo a resume | Type / tests pass | Keep: behavioral coverage of an independent input/path; the remaining tests staying green after deletion does not prove that coverage is replaceable. |
| A299 / 6534 | const goalSessionId = 'session-goal' as SessionId; | Type passes; test fails: tests/session-execution-service.test.ts [ tests/session-execution-service.test.ts ] | Keep: still depended on by an executed test fixture or assertion; the legitimate combined simplification is B002/B004, and the reference target alone must not be deleted. |
| A300 / 6536 | const createGoalService = ( overrides: { transport?: 'request' \| 'promptMeta' \| 'slashCommand' \| null; hasSession?: boolean; | Type passes; test fails: SessionExecutionService goal control > pauses out-of-band without opening a turn | Keep: still depended on by an executed test fixture or assertion; the legitimate combined simplification is B002/B004, and the reference target alone must not be deleted. |
| A301 / 6542 | const controlGoal = vi.fn(async () => {}); | Type passes; test fails: SessionExecutionService goal control > pauses out-of-band without opening a turn | Keep: still depended on by an executed test fixture or assertion; the legitimate combined simplification is B002/B004, and the reference target alone must not be deleted. |
| A302 / 6543 | const agentClient = { isCreated: vi.fn(() => true), resolveGoalActionTransport: vi.fn(() => 'transport' in overrides ? overri | Type passes; test fails: SessionExecutionService goal control > pauses out-of-band without opening a turn | Keep: still depended on by an executed test fixture or assertion; the legitimate combined simplification is B002/B004, and the reference target alone must not be deleted. |
| A303 / 6546 | 'transport' in overrides ? overrides.transport : 'request' | Type passes; test fails: SessionExecutionService goal control > refuses an action the agent never advertised | Combined simplification: the fixture switches to a transport default parameter; no test call passes an explicit undefined. |
| A304 / 6551 | const getSession = vi.fn(() => overrides.hasSession === false ? null : { agentClient, acpSessionId: 'acp-goal' } ); | Type passes; test fails: SessionExecutionService goal control > pauses out-of-band without opening a turn | Combined deletion of the unobserved `getSession` mock alias, inlined as a fixture property (B004). |
| A305 / 6552 | overrides.hasSession === false ? null : { agentClient, acpSessionId: 'acp-goal' } | Type passes; test fails: tests/session-execution-service.test.ts [ tests/session-execution-service.test.ts ] | Combined deletion of the dead `hasSession=false` configuration; the single-item AST replacement also broke the arrow-returns-object syntax, and the legitimate simplification is B004. |
| A306 / 6554 | const deps = createBaseDeps({ sessionManager: { getSession, getPendingSession: vi.fn(() => null), } as unknown as SessionMana | Type passes; test fails: SessionExecutionService goal control > pauses out-of-band without opening a turn | Keep: still depended on by an executed test fixture or assertion; the legitimate combined simplification is B002/B004, and the reference target alone must not be deleted. |
| A307 / 6572 | const service = new SessionExecutionService(deps); | Type passes; test fails: SessionExecutionService goal control > pauses out-of-band without opening a turn | Keep: still depended on by an executed test fixture or assertion; the legitimate combined simplification is B002/B004, and the reference target alone must not be deleted. |
| A308 / 6576 | const goalArgs = { sessionId: goalSessionId, userId: 'owner-user', userName: 'Owner', userEmail: 'owner@example.com', } as co | Type passes; test fails: SessionExecutionService goal control > pauses out-of-band without opening a turn | Keep: still depended on by an executed test fixture or assertion; the legitimate combined simplification is B002/B004, and the reference target alone must not be deleted. |
| A309 / 6584 | const { service, controlGoal } = createGoalService({ transport: 'request' }); | Type passes; test fails: SessionExecutionService goal control > pauses out-of-band without opening a turn | Keep: still depended on by an executed test fixture or assertion; the legitimate combined simplification is B002/B004, and the reference target alone must not be deleted. |
| A310 / 6585 | const continueSession = vi.spyOn(service, 'continueSession').mockResolvedValue(undefined); | Type passes; test fails: SessionExecutionService goal control > pauses out-of-band without opening a turn | Keep: still depended on by an executed test fixture or assertion; the legitimate combined simplification is B002/B004, and the reference target alone must not be deleted. |
| A311 / 6587 | const response = await service.controlSessionGoal({ ...goalArgs, action: 'pause' }); | Type passes; test fails: SessionExecutionService goal control > pauses out-of-band without opening a turn | Keep: still depended on by an executed test fixture or assertion; the legitimate combined simplification is B002/B004, and the reference target alone must not be deleted. |
| A312 / 6597 | const { service } = createGoalService({ transport: null }); | Type passes; test fails: SessionExecutionService goal control > refuses an action the agent never advertised | Keep: still depended on by an executed test fixture or assertion; the legitimate combined simplification is B002/B004, and the reference target alone must not be deleted. |
| A313 / 6598 | const continueSession = vi.spyOn(service, 'continueSession').mockResolvedValue(undefined); | Type passes; test fails: SessionExecutionService goal control > refuses an action the agent never advertised | Keep: still depended on by an executed test fixture or assertion; the legitimate combined simplification is B002/B004, and the reference target alone must not be deleted. |
| A314 / 6600 | const response = await service.controlSessionGoal({ ...goalArgs, action: 'resume' }); | Type passes; test fails: SessionExecutionService goal control > refuses an action the agent never advertised | Keep: still depended on by an executed test fixture or assertion; the legitimate combined simplification is B002/B004, and the reference target alone must not be deleted. |
| A315 / 6607 | const { service } = createGoalService({ transport: 'promptMeta' }); | Type passes; test fails: SessionExecutionService goal control > starts a Lody-owned turn for an action that resumes work | Keep: still depended on by an executed test fixture or assertion; the legitimate combined simplification is B002/B004, and the reference target alone must not be deleted. |
| A316 / 6608 | const continueSession = vi.spyOn(service, 'continueSession').mockResolvedValue(undefined); | Type passes; test fails: SessionExecutionService goal control > starts a Lody-owned turn for an action that resumes work | Keep: still depended on by an executed test fixture or assertion; the legitimate combined simplification is B002/B004, and the reference target alone must not be deleted. |
| A317 / 6610 | const response = await service.controlSessionGoal({ ...goalArgs, action: 'resume' }); | Type passes; test fails: SessionExecutionService goal control > starts a Lody-owned turn for an action that resumes work | Keep: still depended on by an executed test fixture or assertion; the legitimate combined simplification is B002/B004, and the reference target alone must not be deleted. |
| A318 / 6614 | const [request, options] = continueSession.mock.calls[0]!; | Type passes; test fails: SessionExecutionService goal control > starts a Lody-owned turn for an action that resumes work | Keep: still depended on by an executed test fixture or assertion; the legitimate combined simplification is B002/B004, and the reference target alone must not be deleted. |
| A319 / 6626 | const { service } = createGoalService({ transport: 'promptMeta' }); | Type passes; test fails: SessionExecutionService goal control > waits for the running turn to release instead of dropping the resume | Keep: still depended on by an executed test fixture or assertion; the legitimate combined simplification is B002/B004, and the reference target alone must not be deleted. |
| A320 / 6627 | const continueSession = vi.spyOn(service, 'continueSession').mockResolvedValue(undefined); | Type passes; test fails: SessionExecutionService goal control > waits for the running turn to release instead of dropping the resume | Keep: still depended on by an executed test fixture or assertion; the legitimate combined simplification is B002/B004, and the reference target alone must not be deleted. |
| A321 / 6628 | const internals = service as unknown as { currentTurnBySession: Map<SessionId, string>; clearCurrentTurn: (sessionId: Session | Type passes; test fails: SessionExecutionService goal control > waits for the running turn to release instead of dropping the resume | Keep: still depended on by an executed test fixture or assertion; the legitimate combined simplification is B002/B004, and the reference target alone must not be deleted. |
| A322 / 6635 | const response = await service.controlSessionGoal({ ...goalArgs, action: 'resume' }); | Type passes; test fails: SessionExecutionService goal control > waits for the running turn to release instead of dropping the resume | Keep: still depended on by an executed test fixture or assertion; the legitimate combined simplification is B002/B004, and the reference target alone must not be deleted. |
| A323 / 6648 | const { service } = createGoalService({ transport: 'promptMeta' }); | Type passes; test fails: SessionExecutionService goal control > keeps only the newest queued action so a stale pause cannot undo a resume | Keep: still depended on by an executed test fixture or assertion; the legitimate combined simplification is B002/B004, and the reference target alone must not be deleted. |
| A324 / 6649 | const continueSession = vi.spyOn(service, 'continueSession').mockResolvedValue(undefined); | Type passes; test fails: SessionExecutionService goal control > keeps only the newest queued action so a stale pause cannot undo a resume | Keep: still depended on by an executed test fixture or assertion; the legitimate combined simplification is B002/B004, and the reference target alone must not be deleted. |

### `packages/components/src/atoms/runtime.ts`

| ID / original line | Item deleted or reverted | Type / related tests | Conclusion and constraints |
| --- | --- | --- | --- |
| A052 / 17 | SessionGoalAction, SessionGoalResponse, | Type fails; tests not run: error TS2304: Cannot find name 'SessionGoalAction'. | Keep: needed by capability control, request routing or the UI pending lifecycle; helper tests do not cover the whole React/RPC path. |
| A053 / 301 | requestSessionGoal: ( machineId: MachineId, args: { sessionId: SessionId; action: SessionGoalAction; objective?: string; user | Type fails; tests not run: error TS2551: Property 'requestSessionGoal' does not exist on type 'WorkspaceRuntime'. Did you mean 'requestSessionCancel'? | Keep: needed by capability control, request routing or the UI pending lifecycle; helper tests do not cover the whole React/RPC path. |

### `packages/components/src/components/sessions/session-chat-interface.tsx`

| ID / original line | Item deleted or reverted | Type / related tests | Conclusion and constraints |
| --- | --- | --- | --- |
| A054 / 209 | getSessionGoalCommands, GOAL_COMMAND_PENDING_TIMEOUT_MS, | Type fails; tests not run: error TS2305: Module '"./session-goal-control"' has no exported member 'canPauseGoalThroughPromptBridge'. | Keep: needed by capability control, request routing or the UI pending lifecycle; helper tests do not cover the whole React/RPC path. |
| A055 / 2373 | requestSessionGoal, | Type fails; tests not run: error TS2552: Cannot find name 'requestSessionGoal'. Did you mean 'requestSessionCancel'? | Keep: needed by capability control, request routing or the UI pending lifecycle; helper tests do not cover the whole React/RPC path. |
| A056 / 2698 | const goalCapability = session.agentConfigId ? sessionMachine?.acpCapabilities?.[getAcpCapabilityCacheKey(session.agentConfig | Type fails; tests not run: error TS2304: Cannot find name 'getPromptBridgeGoalCommands'. | Keep: needed by capability control, request routing or the UI pending lifecycle; helper tests do not cover the whole React/RPC path. |
| A057 / 2737 | useEffect(() => { if (!pendingGoalCommand) { return undefined; } const timer = setTimeout(() => { setPendingGoalCommand((curr | Type / tests pass | Keep: the pending timeout unlock and cleanup; the helper tests do not execute the React effect. |
| A058 / 4151 | if (options?.showPending !== false) { setPendingGoalCommand({ threadId: goal.threadId, command }); } try { const response = a | Type fails; tests not run: error TS2304: Cannot find name 'GOAL_PROMPT_DISPATCH_OPTIONS'. | Keep: needed by capability control, request routing or the UI pending lifecycle; helper tests do not cover the whole React/RPC path. |
| A059 / 4189 | [ captureSessionEvent, currentUser?.id, goalCommands, latestGoal, requestSessionGoal, session.id, session.machineId, session. | Type / tests pass | Keep: the closure depends on the session, machine and requester, and deleting it uses a stale route. |
| A060 / 5029 | comment / documentation text | Type / tests pass | Keep: a comment that only explains the Stop ordering, with no executable behavior. |
| A204 / 4163 | if (!response?.accepted) { throw new Error( response?.error ?? `Goal command was ${response?.disposition ?? 'not delivered'}` | Type fails; tests not run: error TS18047: 'response' is possibly 'null'. | Keep: needed by capability control, request routing or the UI pending lifecycle; helper tests do not cover the whole React/RPC path. |
| A325 / 4159 | const response = await requestSessionGoal(session.id, command, { userId: currentUser?.id ?? session.userId, machineId: sessio | Type fails; tests not run: error TS2552: Cannot find name 'response'. Did you mean 'Response'? | Keep: needed by capability control, request routing or the UI pending lifecycle; helper tests do not cover the whole React/RPC path. |

### `packages/components/src/components/sessions/session-goal-control.ts`

| ID / original line | Item deleted or reverted | Type / related tests | Conclusion and constraints |
| --- | --- | --- | --- |
| A061 / 1 | import { SESSION_GOAL_COMMANDS, type AcpCapabilityCacheEntry, type SessionGoalCommand, } from '@lody/shared'; const NO_GOAL_C | Type fails; tests not run: error TS2305: Module '"./session-goal-control"' has no exported member 'getSessionGoalCommands'. | Keep: needed by capability control, request routing or the UI pending lifecycle; helper tests do not cover the whole React/RPC path. |
| A205 / 20 | if (!actions?.length) { return NO_GOAL_COMMANDS; } | Type fails; tests not run: error TS18048: 'actions' is possibly 'undefined'. | Combined simplification: switch to an optional-chain filter and delete the empty-array special branch (B002). |
| A326 / 16 | export const getSessionGoalCommands = ( capability: Pick<AcpCapabilityCacheEntry, 'goalActions'> \| undefined ): readonly Sess | Type fails; tests not run | Keep: needed by capability control, request routing or the UI pending lifecycle; helper tests do not cover the whole React/RPC path. |
| A327 / 19 | const actions = capability?.goalActions; | Type fails; tests not run: error TS2304: Cannot find name 'actions'. | Combined simplification: read the optional goalActions directly inside the filter (B002). |
| A328 / 23 | const supported = SESSION_GOAL_COMMANDS.filter((command) => actions.includes(command)); | Type fails; tests not run: error TS2304: Cannot find name 'supported'. | Combined simplification: return the filter result directly, with no intermediate `supported` variable (B002). |
| A329 / 24 | return supported.length > 0 ? supported : NO_GOAL_COMMANDS; | Type passes; test fails: session goal control availability > offers the commands the runtime advertised, whatever the agent is | Combined simplification: keep the filter result and delete the empty-array normalization; changing it to a constant empty array on its own naturally fails. |
| A330 / 27 | export const canPauseSessionGoal = ( capability: Pick<AcpCapabilityCacheEntry, 'goalActions'> \| undefined ): boolean => getSe | Type passes; test fails: session goal control availability > keeps goals read-only for a runtime that advertises no goal actions | Delete: `canPauseSessionGoal` is called only by tests; the UI already reads `goalCommands.includes`. |
| A331 / 40 | export const GOAL_COMMAND_PENDING_TIMEOUT_MS = 60_000; | Type fails; tests not run: error TS2305: Module '"./session-goal-control"' has no exported member 'GOAL_COMMAND_PENDING_TIMEOUT_MS'. | Keep: needed by capability control, request routing or the UI pending lifecycle; helper tests do not cover the whole React/RPC path. |

### `packages/components/src/hooks/use-session-actions.ts`

| ID / original line | Item deleted or reverted | Type / related tests | Conclusion and constraints |
| --- | --- | --- | --- |
| A062 / 16 | SessionGoalAction, SessionGoalResponse, | Type fails; tests not run: error TS2552: Cannot find name 'SessionGoalAction'. Did you mean 'SessionActions'? | Keep: needed by capability control, request routing or the UI pending lifecycle; helper tests do not cover the whole React/RPC path. |
| A063 / 369 | requestSessionGoal: ( sessionId: SessionId, action: SessionGoalAction, options?: { objective?: string; userId?: string; machi | Type fails; tests not run: error TS2339: Property 'requestSessionGoal' does not exist on type 'SessionActions'. | Keep: needed by capability control, request routing or the UI pending lifecycle; helper tests do not cover the whole React/RPC path. |
| A064 / 922 | const requestSessionGoal = useCallback( async ( sessionId: SessionId, action: SessionGoalAction, options?: { objective?: stri | Type fails; tests not run: error TS2552: Cannot find name 'requestSessionGoal'. Did you mean 'requestSessionCancel'? | Keep: needed by capability control, request routing or the UI pending lifecycle; helper tests do not cover the whole React/RPC path. |
| A065 / 1478 | requestSessionGoal, | Type fails; tests not run: error TS2741: Property 'requestSessionGoal' is missing in type '{ createSession: (payload: SessionToCreate) => Promise<CreateSessionResult>; star | Keep: needed by capability control, request routing or the UI pending lifecycle; helper tests do not cover the whole React/RPC path. |
| A206 / 929 | options?: { objective?: string; userId?: string; machineId?: MachineId \| null } | Type fails; tests not run: error TS2339: Property 'objective' does not exist on type '{ userId?: string \| undefined; machineId?: MachineId \| null \| undefined; }'. | Keep: needed by capability control, request routing or the UI pending lifecycle; helper tests do not cover the whole React/RPC path. |
| A207 / 931 | if (!runtime) { throw new Error('Runtime not ready'); } | Type fails; tests not run: error TS18047: 'runtime' is possibly 'null'. | Keep: needed by capability control, request routing or the UI pending lifecycle; helper tests do not cover the whole React/RPC path. |
| A208 / 941 | if (!machineId \|\| !userId) { return null; } | Type fails; tests not run: error TS2345: Argument of type 'MachineId \| null' is not assignable to parameter of type 'MachineId'. | Keep: needed by capability control, request routing or the UI pending lifecycle; helper tests do not cover the whole React/RPC path. |
| A332 / 925 | const requestSessionGoal = useCallback( async ( sessionId: SessionId, action: SessionGoalAction, options?: { objective?: stri | Type fails; tests not run: error TS2552: Cannot find name 'requestSessionGoal'. Did you mean 'requestSessionCancel'? | Keep: needed by capability control, request routing or the UI pending lifecycle; helper tests do not cover the whole React/RPC path. |
| A333 / 934 | const roomId = getSessionRoomId(sessionId); | Type fails; tests not run: error TS2304: Cannot find name 'roomId'. | Keep: needed by capability control, request routing or the UI pending lifecycle; helper tests do not cover the whole React/RPC path. |
| A334 / 935 | const existing = await runtime.repo.getDocMeta(roomId); | Type fails; tests not run: error TS2304: Cannot find name 'existing'. | Keep: needed by capability control, request routing or the UI pending lifecycle; helper tests do not cover the whole React/RPC path. |
| A335 / 936 | const meta = isLoroRepoDocDeleted(existing) ? undefined : (existing?.meta as SessionMeta \| undefined); | Type fails; tests not run: error TS2304: Cannot find name 'meta'. | Keep: needed by capability control, request routing or the UI pending lifecycle; helper tests do not cover the whole React/RPC path. |
| A336 / 939 | const machineId = options?.machineId ?? meta?.machineId ?? null; | Type fails; tests not run: error TS2304: Cannot find name 'machineId'. | Keep: needed by capability control, request routing or the UI pending lifecycle; helper tests do not cover the whole React/RPC path. |
| A337 / 940 | const userId = options?.userId?.trim() \|\| meta?.userId; | Type fails; tests not run: error TS2304: Cannot find name 'userId'. | Keep: needed by capability control, request routing or the UI pending lifecycle; helper tests do not cover the whole React/RPC path. |
| A338 / 947 | ...(options?.objective ? { objective: options.objective } : {}), | Type / tests pass | Keep: the UI API's set objective forwarding; there is no separate button yet, but the protocol does have readers and writers. |

### `packages/components/src/providers/create-workspace-runtime.ts`

| ID / original line | Item deleted or reverted | Type / related tests | Conclusion and constraints |
| --- | --- | --- | --- |
| A066 / 1657 | requestSessionGoal, | Type fails; tests not run: error TS2552: Cannot find name 'requestSessionGoal'. Did you mean 'requestSessionCancel'? | Keep: needed by capability control, request routing or the UI pending lifecycle; helper tests do not cover the whole React/RPC path. |
| A067 / 4626 | requestSessionGoal, | Type fails; tests not run: error TS2741: Property 'requestSessionGoal' is missing in type '{ workspaceSlug: string; workspaceId: WorkspaceId; repo: LoroRepo<JsonObject>; co | Keep: needed by capability control, request routing or the UI pending lifecycle; helper tests do not cover the whole React/RPC path. |

### `packages/components/src/providers/workspace-machine-rpc-facade.ts`

| ID / original line | Item deleted or reverted | Type / related tests | Conclusion and constraints |
| --- | --- | --- | --- |
| A068 / 51 | type SessionGoalAction, type SessionGoalResponse, | Type fails; tests not run: error TS2304: Cannot find name 'SessionGoalAction'. | Keep: needed by capability control, request routing or the UI pending lifecycle; helper tests do not cover the whole React/RPC path. |
| A069 / 756 | const requestSessionGoal = async ( machineId: MachineId, args: { sessionId: SessionId; action: SessionGoalAction; objective?: | Type fails; tests not run: error TS2552: Cannot find name 'requestSessionGoal'. Did you mean 'requestSessionCancel'? | Keep: needed by capability control, request routing or the UI pending lifecycle; helper tests do not cover the whole React/RPC path. |
| A070 / 1165 | requestSessionGoal, | Type fails; tests not run: error TS2339: Property 'requestSessionGoal' does not exist on type '{ requestSessionCancel: (machineId: MachineId, sessionId: SessionId, turnId: | Keep: needed by capability control, request routing or the UI pending lifecycle; helper tests do not cover the whole React/RPC path. |
| A209 / 762 | sessionId: SessionId; | Type fails; tests not run | Keep: needed by capability control, request routing or the UI pending lifecycle; helper tests do not cover the whole React/RPC path. |
| A210 / 763 | action: SessionGoalAction; | Type fails; tests not run: error TS2339: Property 'action' does not exist on type '{ sessionId: SessionId; objective?: string \| undefined; userId: string; timestamp: string | Keep: needed by capability control, request routing or the UI pending lifecycle; helper tests do not cover the whole React/RPC path. |
| A211 / 764 | objective?: string; | Type / tests pass | Keep: the facade's callable interface promises set objective support; the runtime merely passing it through does not mean the protocol has no consumer. |
| A212 / 765 | userId: string; | Type fails; tests not run: error TS2345: Argument of type '{ machineId: MachineId; workspaceId: WorkspaceId; method: "session/goal"; params: { sessionId: SessionId; action: | Keep: needed by capability control, request routing or the UI pending lifecycle; helper tests do not cover the whole React/RPC path. |
| A213 / 766 | timestamp: string; | Type fails; tests not run: error TS2345: Argument of type '{ machineId: MachineId; workspaceId: WorkspaceId; method: "session/goal"; params: { sessionId: SessionId; action: | Combined deletion of the goal RPC timestamp (B001); deleting only the facade type leaves it out of sync with the other layers. |
| A214 / 768 | options?: { timeoutMs?: number } | Type fails; tests not run: error TS2339: Property 'timeoutMs' does not exist on type '{}'. | Keep: needed by capability control, request routing or the UI pending lifecycle; helper tests do not cover the whole React/RPC path. |
| A215 / 779 | if (await canUseLocalMachineRpc(machineId)) { const response = await getLocalMachineRpcSender()?.({ machineId, workspaceId, m | Type / tests pass | Keep: prefer the local RPC; deleting it routes through the remote channel, and the helper tests do not execute the facade. |
| A216 / 787 | if (response && !response.ok) { return failure(response.error); } | Type / tests pass | Keep: it converts a local RPC failure into a goal failure response; it must not keep pretending success. |
| A217 / 790 | if (response?.ok) return response.result as SessionGoalResponse; | Type / tests pass | Keep: a successful local RPC must return directly and must not send the remote action again. |
| A339 / 759 | const requestSessionGoal = async ( machineId: MachineId, args: { sessionId: SessionId; action: SessionGoalAction; objective?: | Type fails; tests not run: error TS2552: Cannot find name 'requestSessionGoal'. Did you mean 'requestSessionCancel'? | Keep: needed by capability control, request routing or the UI pending lifecycle; helper tests do not cover the whole React/RPC path. |
| A340 / 770 | const failure = (error: string): SessionGoalResponse => ({ type: 'session/goal_response', sessionId: args.sessionId, action: | Type fails; tests not run: error TS2304: Cannot find name 'failure'. | Keep: needed by capability control, request routing or the UI pending lifecycle; helper tests do not cover the whole React/RPC path. |
| A341 / 780 | const response = await getLocalMachineRpcSender()?.({ machineId, workspaceId, method: 'session/goal', params: args, timeoutMs | Type fails; tests not run: error TS2552: Cannot find name 'response'. Did you mean 'Response'? | Keep: needed by capability control, request routing or the UI pending lifecycle; helper tests do not cover the whole React/RPC path. |
| A342 / 799 | return failure(error instanceof Error ? error.message : String(error)); | Type / tests pass | Keep: it converts an exception into a presentable error string. |

### `packages/components/tests/session-goal-control.test.ts`

| ID / original line | Item deleted or reverted | Type / related tests | Conclusion and constraints |
| --- | --- | --- | --- |
| A071 / 1 | test: keeps goals read-only for a runtime that advertises no goal actions | Type passes; test fails: session goal prompt bridge > keeps provider-neutral Claude goals read-only | Keep: still depended on by an executed test fixture or assertion; the legitimate combined simplification is B002/B004, and the reference target alone must not be deleted. |
| A218 / 9 | test: keeps goals read-only for a runtime that advertises no goal actions | Type / tests pass | Keep: behavioral coverage of an independent input/path; the remaining tests staying green after deletion does not prove that coverage is replaceable. |
| A219 / 15 | test: offers the commands the runtime advertised, whatever the agent is | Type / tests pass | Keep: behavioral coverage of an independent input/path; the remaining tests staying green after deletion does not prove that coverage is replaceable. |
| A220 / 25 | test: offers only the subset a partial runtime advertised | Type / tests pass | Keep: behavioral coverage of an independent input/path; the remaining tests staying green after deletion does not prove that coverage is replaceable. |
| A343 / 16 | const capability = { goalActions: ['set', 'pause', 'resume', 'clear'] as const }; | Type passes; test fails: session goal control availability > offers the commands the runtime advertised, whatever the agent is | Combined: inline the tests' capability literal and remove the alias / readonly spread left with a single use (B002). |

### `packages/loro-streams-rpc/src/machine-rpc-server.ts`

| ID / original line | Item deleted or reverted | Type / related tests | Conclusion and constraints |
| --- | --- | --- | --- |
| A072 / 45 | SessionGoalAction, SessionGoalResponse, | Type fails; tests not run: error TS2304: Cannot find name 'SessionGoalAction'. | Keep: request sending and response parsing/error association have real consumers; a single-package check does not show the facade is still callable. |
| A073 / 119 | 'session/goal', | Type / tests pass | Keep: the control-channel classification; the long-execution ACK should be fixed rather than masked by deleting the classification. |
| A074 / 357 | controlSessionGoal?: (args: { sessionId: SessionId; action: SessionGoalAction; objective?: string; userId: string; }) => Prom | Type fails; tests not run: error TS2339: Property 'controlSessionGoal' does not exist on type 'RpcServerDeps'. | Keep: request sending and response parsing/error association have real consumers; a single-package check does not show the facade is still callable. |
| A075 / 1105 | case 'session/goal': { if (!this.deps.controlSessionGoal) { await this.appendErrorResponse(request.replyTo, request.id, reque | Type / tests pass | Keep: the real session/goal handler; existing RPC tests do not cover this case. |
| A076 / 1614 | \| SessionGoalResponse | Type fails; tests not run: error TS2345: Argument of type 'SessionGoalResponse' is not assignable to parameter of type 'MachineAcpAuthenticateResponse \| MachineAcpAuthentic | Keep: request sending and response parsing/error association have real consumers; a single-package check does not show the facade is still callable. |
| A221 / 1109 | if (!this.deps.controlSessionGoal) { await this.appendErrorResponse(request.replyTo, request.id, request.method, { code: LORO | Type fails; tests not run: error TS2532: Object is possibly 'undefined'. | Keep: request sending and response parsing/error association have real consumers; a single-package check does not show the facade is still callable. |
| A344 / 1116 | const response = await this.deps.controlSessionGoal({ sessionId: request.params.sessionId as SessionId, action: request.param | Type fails; tests not run: error TS2552: Cannot find name 'response'. Did you mean 'Response'? | Keep: request sending and response parsing/error association have real consumers; a single-package check does not show the facade is still callable. |
| A345 / 1119 | ...(request.params.objective ? { objective: request.params.objective } : {}), | Type / tests pass | Keep: the RPC server hands the set objective to the business layer. |

### `packages/loro-streams-rpc/src/rpc.ts`

| ID / original line | Item deleted or reverted | Type / related tests | Conclusion and constraints |
| --- | --- | --- | --- |
| A077 / 45 | SessionGoalAction, SessionGoalResponse, | Type fails; tests not run: error TS2552: Cannot find name 'SessionGoalResponse'. Did you mean 'SessionCancelResponse'? | Keep: request sending and response parsing/error association have real consumers; a single-package check does not show the facade is still callable. |
| A078 / 108 | SessionGoalResponseSchema, SESSION_GOAL_ACTIONS, | Type fails; tests not run: error TS2304: Cannot find name 'SESSION_GOAL_ACTIONS'. | Keep: request sending and response parsing/error association have real consumers; a single-package check does not show the facade is still callable. |
| A079 / 193 | 'session/goal', | Type fails; tests not run: error TS2345: Argument of type '"code-collab/init-directory" \| "code-collab/lsp-definition" \| "code-collab/lsp-references" \| "code-collab/open-al | Keep: request sending and response parsing/error association have real consumers; a single-package check does not show the facade is still callable. |
| A080 / 445 | export const LoroSessionGoalRpcRequestSchema = BaseRpcRequestSchema.extend({ method: z.literal('session/goal'), params: z .ob | Type fails; tests not run: error TS2552: Cannot find name 'LoroSessionGoalRpcRequestSchema'. Did you mean 'LoroSessionCancelRpcRequestSchema'? | Keep: request sending and response parsing/error association have real consumers; a single-package check does not show the facade is still callable. |
| A081 / 600 | LoroSessionGoalRpcRequestSchema, | Type fails; tests not run: error TS2678: Type '"session/goal"' is not comparable to type '"code-collab/init-directory" \| "code-collab/lsp-definition" \| "code-collab/lsp-ref | Keep: request sending and response parsing/error association have real consumers; a single-package check does not show the facade is still callable. |
| A082 / 1443 | \| SessionGoalResponse | Type fails; tests not run: error TS2322: Type '{ type: "session/goal_response"; sessionId: SessionId; action: "clear" \| "pause" \| "resume" \| "set"; accepted: false; disposi | Keep: request sending and response parsing/error association have real consumers; a single-package check does not show the facade is still callable. |
| A083 / 1471 | goalContext?: { sessionId: string; action: SessionGoalAction }, | Type fails; tests not run: error TS2304: Cannot find name 'goalContext'. | Keep: request sending and response parsing/error association have real consumers; a single-package check does not show the facade is still callable. |
| A084 / 1624 | if (method === 'session/goal') { return { type: 'session/goal_response', sessionId: (goalContext?.sessionId ?? '') as Session | Type / tests pass | Keep: request sending and response parsing/error association have real consumers; a single-package check does not show the facade is still callable. |
| A085 / 1820 | if (response.method === 'session/goal') { const parsed = SessionGoalResponseSchema.safeParse(response.result); return parsed. | Type / tests pass | Keep: request sending and response parsing/error association have real consumers; a single-package check does not show the facade is still callable. |
| A086 / 1897 | goalContext?: { sessionId: string; action: SessionGoalAction }; | Type fails; tests not run: error TS2339: Property 'goalContext' does not exist on type 'LoroStreamsRpcPendingRequest'. | Keep: request sending and response parsing/error association have real consumers; a single-package check does not show the facade is still callable. |
| A087 / 2281 | finalPending.goalContext, | Type fails; tests not run: error TS2345: Argument of type '{ sessionId: string; } \| undefined' is not assignable to parameter of type '{ sessionId: string; action: "clear" | Keep: request sending and response parsing/error association have real consumers; a single-package check does not show the facade is still callable. |
| A088 / 2314 | finalPending.goalContext, | Type fails; tests not run: error TS2345: Argument of type '{ sessionId: string; } \| undefined' is not assignable to parameter of type '{ sessionId: string; action: "clear" | Keep: request sending and response parsing/error association have real consumers; a single-package check does not show the facade is still callable. |
| A089 / 2690 | async requestSessionGoal(options: { sessionId: string; action: SessionGoalAction; objective?: string; userId: string; timesta | Type / tests pass | Keep: request sending and response parsing/error association have real consumers; a single-package check does not show the facade is still callable. |
| A090 / 3180 | method: 'session/goal'; timeoutMs: number; params: { sessionId: string; action: SessionGoalAction; objective?: string; userId | Type fails; tests not run: error TS2322: Type '"session/goal"' is not assignable to type '"code-collab/init-directory" \| "code-collab/lsp-definition" \| "code-collab/lsp-ref | Keep: request sending and response parsing/error association have real consumers; a single-package check does not show the facade is still callable. |
| A091 / 3403 | goalContext: args.method === 'session/goal' ? { sessionId: args.params.sessionId, action: args.params.action } : undefined, | Type / tests pass | Keep: request sending and response parsing/error association have real consumers; a single-package check does not show the facade is still callable. |
| A092 / 3515 | case 'session/goal': request = { ...envelope, method: args.method, params: args.params }; break; | Type fails; tests not run: error TS2454: Variable 'request' is used before being assigned. | Keep: request sending and response parsing/error association have real consumers; a single-package check does not show the facade is still callable. |
| A093 / 3706 | pending.goalContext, | Type fails; tests not run: error TS2345: Argument of type '{ sessionId: string; } \| undefined' is not assignable to parameter of type '{ sessionId: string; action: "clear" | Keep: request sending and response parsing/error association have real consumers; a single-package check does not show the facade is still callable. |
| A222 / 2693 | async requestSessionGoal(options: { sessionId: string; action: SessionGoalAction; objective?: string; userId: string; timesta | Type / tests pass | Keep: the real RPC client entry point; deleting it removes the method from out-of-package consumers, which single-package tests do not cover. |
| A223 / 2694 | sessionId: string; | Type fails; tests not run: error TS2339: Property 'sessionId' does not exist on type '{ action: "clear" \| "pause" \| "resume" \| "set"; objective?: string \| undefined; userId | Keep: request sending and response parsing/error association have real consumers; a single-package check does not show the facade is still callable. |
| A224 / 2695 | action: SessionGoalAction; | Type fails; tests not run: error TS2339: Property 'action' does not exist on type '{ sessionId: string; objective?: string \| undefined; userId: string; timestamp: string; t | Keep: request sending and response parsing/error association have real consumers; a single-package check does not show the facade is still callable. |
| A225 / 2696 | objective?: string; | Type fails; tests not run: error TS2339: Property 'objective' does not exist on type '{ sessionId: string; action: "clear" \| "pause" \| "resume" \| "set"; userId: string; tim | Keep: request sending and response parsing/error association have real consumers; a single-package check does not show the facade is still callable. |
| A226 / 2697 | userId: string; | Type fails; tests not run: error TS2339: Property 'userId' does not exist on type '{ sessionId: string; action: "clear" \| "pause" \| "resume" \| "set"; objective?: string \| u | Keep: request sending and response parsing/error association have real consumers; a single-package check does not show the facade is still callable. |
| A227 / 2698 | timestamp: string; | Type fails; tests not run: error TS2339: Property 'timestamp' does not exist on type '{ sessionId: string; action: "clear" \| "pause" \| "resume" \| "set"; objective?: string | Combined deletion of the goal RPC timestamp (B001); the sending API's type annotation alone must not be deleted. |
| A228 / 2699 | timeoutMs?: number; | Type fails; tests not run: error TS2339: Property 'timeoutMs' does not exist on type '{ sessionId: string; action: "clear" \| "pause" \| "resume" \| "set"; objective?: string | Keep: request sending and response parsing/error association have real consumers; a single-package check does not show the facade is still callable. |
| A346 / 2707 | ...(options.objective ? { objective: options.objective } : {}), | Type / tests pass | Keep: the RPC client writes the set objective into the request. |

### `packages/shared/src/ai.ts`

| ID / original line | Item deleted or reverted | Type / related tests | Conclusion and constraints |
| --- | --- | --- | --- |
| A094 / 7 | import type { SessionGoalAction } from './goal'; | Type fails; tests not run: error TS2304: Cannot find name 'SessionGoalAction'. | Keep: the public response/capability contract has real writers and parsers; a single-package check does not include every downstream. |
| A095 / 282 | export const ACP_CAPABILITY_CACHE_VERSION = 8; | Type / tests pass | Keep: a v7 cache lacks goalActions and needs the v8 forced refresh; a green check does not mean existing caches will update. |
| A096 / 316 | goalActions?: SessionGoalAction[]; | Type / tests pass | Keep: the public response/capability contract has real writers and parsers; a single-package check does not include every downstream. |

### `packages/shared/src/goal.ts`

| ID / original line | Item deleted or reverted | Type / related tests | Conclusion and constraints |
| --- | --- | --- | --- |
| A097 / 12 | export const SESSION_GOAL_ACTIONS = ['set', 'pause', 'resume', 'clear'] as const; export type SessionGoalAction = (typeof SES | Type fails; tests not run: error TS2724: '"./goal"' has no exported member named 'SessionGoalAction'. Did you mean 'isSessionGoalActive'? | Keep the action tuple/type; the single-caller status predicate is inlined into the transport selector (B009). |

### `packages/shared/src/local-machine-rpc.ts`

| ID / original line | Item deleted or reverted | Type / related tests | Conclusion and constraints |
| --- | --- | --- | --- |
| A098 / 1 | import { SESSION_GOAL_ACTIONS } from './goal'; | Type fails; tests not run: error TS2304: Cannot find name 'SESSION_GOAL_ACTIONS'. | Keep: the public response/capability contract has real writers and parsers; a single-package check does not include every downstream. |
| A099 / 38 | SessionGoalResponseSchema, | Type fails; tests not run: error TS2552: Cannot find name 'SessionGoalResponseSchema'. Did you mean 'SessionCancelResponseSchema'? | Keep: the public response/capability contract has real writers and parsers; a single-package check does not include every downstream. |
| A100 / 205 | method: z.literal('session/goal'), params: z .object({ sessionId: SessionIdSchema, action: z.enum(SESSION_GOAL_ACTIONS), obje | Type / tests pass | Keep: the public response/capability contract has real writers and parsers; a single-package check does not include every downstream. |
| A101 / 272 | SessionGoalResponseSchema, | Type / tests pass | Keep: the public response/capability contract has real writers and parsers; a single-package check does not include every downstream. |

### `packages/shared/src/message-schemas.ts`

| ID / original line | Item deleted or reverted | Type / related tests | Conclusion and constraints |
| --- | --- | --- | --- |
| A102 / 9 | import { SESSION_GOAL_ACTIONS } from './goal'; | Type fails; tests not run: error TS2304: Cannot find name 'SESSION_GOAL_ACTIONS'. | Keep: the public response/capability contract has real writers and parsers; a single-package check does not include every downstream. |
| A103 / 685 | export const SessionGoalResponseSchema = z .object({ type: z.literal('session/goal_response'), sessionId: SessionIdSchema, ac | Type fails; tests not run: error TS2724: '"./message-schemas"' has no exported member named 'SessionGoalResponseSchema'. Did you mean 'SessionChatResponseSchema'? | Keep: the public response/capability contract has real writers and parsers; a single-package check does not include every downstream. |
| A104 / 1238 | goalActions: z.array(z.enum(SESSION_GOAL_ACTIONS)).optional(), | Type / tests pass | Keep: the public response/capability contract has real writers and parsers; a single-package check does not include every downstream. |
| A105 / 2035 | SessionGoalResponseSchema, | Type / tests pass | Keep: the public response/capability contract has real writers and parsers; a single-package check does not include every downstream. |

### `packages/shared/src/message.ts`

| ID / original line | Item deleted or reverted | Type / related tests | Conclusion and constraints |
| --- | --- | --- | --- |
| A106 / 17 | SessionGoalAction, | Type fails; tests not run: error TS2304: Cannot find name 'SessionGoalAction'. | Keep: the public response/capability contract has real writers and parsers; a single-package check does not include every downstream. |
| A107 / 164 | export interface SessionGoalResponse { type: 'session/goal_response'; sessionId: SessionId; action: SessionGoalAction; accept | Type fails; tests not run: error TS2552: Cannot find name 'SessionGoalResponse'. Did you mean 'SessionChatResponse'? | Keep: the public response/capability contract has real writers and parsers; a single-package check does not include every downstream. |
| A108 / 750 | \| SessionGoalResponse | Type / tests pass | Keep: the public response/capability contract has real writers and parsers; a single-package check does not include every downstream. |
| A229 / 177 | type: 'session/goal_response'; | Type / tests pass | Keep: the response `type` is the real schema's discriminator, and both the UI and RPC construct that response. |
| A230 / 178 | sessionId: SessionId; | Type / tests pass | Keep: the response associates the session, required by the schema and written by the sender. |
| A231 / 179 | action: SessionGoalAction; | Type / tests pass | Keep: the response associates the action, used by both the RPC error mapping and the schema. |
| A232 / 180 | accepted: boolean; | Type / tests pass | Keep: the UI uses `accepted` to decide whether the action was accepted. |
| A233 / 181 | disposition: 'applied' \| 'turn_started' \| 'queued' \| 'unsupported' \| 'error'; | Type / tests pass | Keep: the UI's error explanation and event attribution read `disposition`. |
| A234 / 182 | error?: string; | Type / tests pass | Keep: the UI displays the error; the server's failure reason must not be erased. |

### `packages/shared/tests/ai-capability-cache.test.ts`

| ID / original line | Item deleted or reverted | Type / related tests | Conclusion and constraints |
| --- | --- | --- | --- |
| A109 / 57 | const capability: AcpCapabilityCacheEntry = { ...entry(6), | Type passes; test fails: ACP capability cache compatibility > drops only the known-incompatible derived field from pre-v7 non-Codex entries | Keep: the test explicitly covers the older-than-v7 boundary, and a dynamic current−1 is already a different scenario at v8. |

### `packages/acp-extension-core/src/capabilities.ts`

| ID / original line | Item deleted or reverted | Type / related tests | Conclusion and constraints |
| --- | --- | --- | --- |
| A110 / 11 | actions: readonly LodyGoalAction[]; controlActions?: readonly LodyGoalAction[]; promptActions?: readonly LodyGoalAction[]; | Type fails; tests not run: error TS2353: Object literal may only specify known properties, and 'controlActions' does not exist in type 'LodyGoalCapability'. | Keep: Core owns the real metadata/capability wire contract, which Codex's and the CLI's reads and writes depend on. |
| A235 / 21 | controlActions?: readonly LodyGoalAction[]; | Type fails; tests not run: error TS2353: Object literal may only specify known properties, and 'controlActions' does not exist in type 'LodyGoalCapability'. | Keep: Core owns the real metadata/capability wire contract, which Codex's and the CLI's reads and writes depend on. |
| A236 / 27 | promptActions?: readonly LodyGoalAction[]; | Type fails; tests not run: error TS2353: Object literal may only specify known properties, and 'promptActions' does not exist in type 'LodyGoalCapability'. | Keep: Core owns the real metadata/capability wire contract, which Codex's and the CLI's reads and writes depend on. |

### `packages/acp-extension-core/src/session.ts`

| ID / original line | Item deleted or reverted | Type / related tests | Conclusion and constraints |
| --- | --- | --- | --- |
| A111 / 69 | export type LodyGoalPromptControl = \| { version: 1; action: 'set'; objective: string } \| { version: 1; action: 'pause' \| 'res | Type fails; tests not run: error TS2305: Module '"acp-extension-core"' has no exported member 'LodyGoalPromptControl'. | Keep: Core owns the real metadata/capability wire contract, which Codex's and the CLI's reads and writes depend on. |
| A112 / 158 | goal?: LodyGoalSnapshot \| null; goalControl?: LodyGoalPromptControl; | Type / tests pass | Keep: real producers write and consumers read goalControl; Core owns the type of that wire field. |
| A237 / 86 | \| { version: 1; action: 'set'; objective: string } | Type fails; tests not run: error TS2353: Object literal may only specify known properties, and 'version' does not exist in type '{ action: "set"; objective: string; }'. | Keep: the prompt control's version discriminator is read and validated by the real parser. |
| A238 / 87 | \| { version: 1; action: 'pause' \| 'resume' \| 'clear' }; | Type fails; tests not run: error TS2353: Object literal may only specify known properties, and 'version' does not exist in type '{ action: "clear" \| "pause" \| "resume"; }'. | Keep: the versioned protocol shape for non-set actions; the two union branches must not diverge. |

### `packages/acp-extension-codex/src/AcpExtensions.ts`

| ID / original line | Item deleted or reverted | Type / related tests | Conclusion and constraints |
| --- | --- | --- | --- |
| A113 / 41 | parseGoalPromptControl, type GoalCapability, type GoalControlAction, type GoalControlRequest, type GoalPromptControl, | Type fails; tests not run: error TS2305: Module '"./AcpExtensions"' has no exported member 'parseGoalPromptControl'. | Keep: needed by metadata/slash routing or input validation; a green run after deleting the test cannot replace the behavioral judgement of the real action. |
| A114 / 70 | goal: { version: 1, actions: ["set", "pause", "resume", "clear"], controlActions: ["pause", "clear"], promptActions: ["set", | Type / tests pass | Keep: Codex's real capability advertisement; deleting it falls back to slash and loses mid-prompt status control. |

### `packages/acp-extension-codex/src/CodexAcpServer.ts`

| ID / original line | Item deleted or reverted | Type / related tests | Conclusion and constraints |
| --- | --- | --- | --- |
| A115 / 55 | import {CodexCommands, GOAL_CONTINUATION_PROMPT, type CommandHandleOptions} from "./CodexCommands"; | Type fails; tests not run: error TS2304: Cannot find name 'CommandHandleOptions'. | Keep: needed by metadata/slash routing or input validation; a green run after deleting the test cannot replace the behavioral judgement of the real action. |
| A116 / 72 | parseGoalPromptControl, | Type fails; tests not run: error TS2552: Cannot find name 'parseGoalPromptControl'. Did you mean 'goalPromptControl'? | Keep: needed by metadata/slash routing or input validation; a green run after deleting the test cannot replace the behavioral judgement of the real action. |
| A117 / 3018 | const goalPromptControl = parseGoalPromptControl(params.\_meta); | Type fails; tests not run: error TS2552: Cannot find name 'goalPromptControl'. Did you mean 'parseGoalPromptControl'? | Keep: needed by metadata/slash routing or input validation; a green run after deleting the test cannot replace the behavioral judgement of the real action. |
| A118 / 3134 | const commandOptions: CommandHandleOptions = { | Type fails; tests not run: error TS1005: ')' expected. | Keep: needed by metadata/slash routing or input validation; a green run after deleting the test cannot replace the behavioral judgement of the real action. |
| A119 / 3163 | }; const commandPromise = goalPromptControl === null ? this.availableCommands.tryHandleCommand(params.prompt, sessionState, c | Type fails; tests not run: error TS1005: ',' expected. | Keep: needed by metadata/slash routing or input validation; a green run after deleting the test cannot replace the behavioral judgement of the real action. |

### `packages/acp-extension-codex/src/CodexCommands.ts`

| ID / original line | Item deleted or reverted | Type / related tests | Conclusion and constraints |
| --- | --- | --- | --- |
| A120 / 1 | import {RequestError, type AvailableCommand} from "@agentclientprotocol/sdk"; | Type fails; tests not run: error TS2304: Cannot find name 'RequestError'. | Keep: needed by metadata/slash routing or input validation; a green run after deleting the test cannot replace the behavioral judgement of the real action. |
| A121 / 18 | import {GOAL_EXTENSION_VERSION, type GoalPromptControl} from "./GoalExtension"; | Type fails; tests not run: error TS2304: Cannot find name 'GOAL_EXTENSION_VERSION'. | Keep: needed by metadata/slash routing or input validation; a green run after deleting the test cannot replace the behavioral judgement of the real action. |
| A122 / 29 | export const GOAL_OBJECTIVE_MAX_LENGTH = 4000; | Type fails; tests not run: error TS2304: Cannot find name 'GOAL_OBJECTIVE_MAX_LENGTH'. | Keep: needed by metadata/slash routing or input validation; a green run after deleting the test cannot replace the behavioral judgement of the real action. |
| A123 / 381 | const named = argument.toLowerCase(); if (named === "pause" \|\| named === "resume" \|\| named === "clear") { return await this.r | Type fails; tests not run: error TS2339: Property 'runGoalPromptControl' does not exist on type 'CodexCommands'. | Keep: needed by metadata/slash routing or input validation; a green run after deleting the test cannot replace the behavioral judgement of the real action. |
| A239 / 385 | if (named === "pause" \|\| named === "resume" \|\| named === "clear") { return await this.runGoalPromptControl( sessionState, {ve | Type / tests pass | Keep: a slash status command must be routed as a status action and must not be taken as a new objective. |
| A240 / 393 | if (argument.length > GOAL_OBJECTIVE_MAX_LENGTH) { const session = new ACPSessionConnection(this.connection, sessionId); awai | Type / tests pass | Keep: slash length validation is pre-existing behavior; this change only switches it to the shared constant. |
| A241 / 414 | async runGoalPromptControl( sessionState: SessionState, control: GoalPromptControl, options: CommandHandleOptions = {}, ): Pr | Type fails; tests not run: error TS2339: Property 'runGoalPromptControl' does not exist on type 'CodexCommands'. | Keep: needed by metadata/slash routing or input validation; a green run after deleting the test cannot replace the behavioral judgement of the real action. |
| A242 / 420 | if (control.action === "pause") { await this.runWithProcessCheck(() => this.codexAcpClient.setGoalStatus(sessionId, "paused") | Type / tests pass | Keep: a prompt pause must pause and must not fall through to resume; the contract's caller is reachable. |
| A243 / 424 | if (control.action === "clear") { await this.runWithProcessCheck(() => this.codexAcpClient.clearGoal(sessionId)); return { ha | Type / tests pass | Keep: a prompt clear must clear and must not fall through to resume; the contract's caller is reachable. |
| A244 / 428 | if (control.action === "set" && control.objective.trim().length > GOAL_OBJECTIVE_MAX_LENGTH) { throw RequestError.invalidPara | Type / tests pass | Keep: metadata set validates the length before marking the turn pending or calling native. |
| A347 / 384 | const named = argument.toLowerCase(); | Type fails; tests not run: error TS2552: Cannot find name 'named'. Did you mean 'name'? | Keep: needed by metadata/slash routing or input validation; a green run after deleting the test cannot replace the behavioral judgement of the real action. |
| A348 / 419 | const sessionId = sessionState.sessionId; | Type fails; tests not run: error TS2304: Cannot find name 'sessionId'. | Keep: needed by metadata/slash routing or input validation; a green run after deleting the test cannot replace the behavioral judgement of the real action. |
| A349 / 435 | const onTurnStarted = (turnId: string) => { this.handleCommandTurnStarted(sessionState, options, turnId, sessionId); }; | Type fails; tests not run: error TS2304: Cannot find name 'onTurnStarted'. | Keep: needed by metadata/slash routing or input validation; a green run after deleting the test cannot replace the behavioral judgement of the real action. |
| A350 / 439 | control.action === "set" ? this.codexAcpClient.setGoal(sessionId, control.objective.trim(), onTurnStarted) : this.codexAcpCli | Type / tests pass | Keep: set and resume must call native setGoal/resumeGoal separately; the current integration covers only resume. |

### `packages/acp-extension-codex/src/GoalExtension.ts`

| ID / original line | Item deleted or reverted | Type / related tests | Conclusion and constraints |
| --- | --- | --- | --- |
| A124 / 1 | import { LODY_EXTENSION_METHODS, type LodyGoalPromptControl, type LodyGoalSnapshot, } from "acp-extension-core"; | Type fails; tests not run: error TS2552: Cannot find name 'LodyGoalPromptControl'. Did you mean 'GoalPromptControl'? | Keep: needed by metadata/slash routing or input validation; a green run after deleting the test cannot replace the behavioral judgement of the real action. |
| A125 / 14 | controlActions?: readonly GoalControlAction[]; promptActions?: readonly GoalControlAction[]; | Type / tests pass | Delete: the duplicated local GoalCapability transport fields, which have no production type consumer; Core's fields are kept. |
| A126 / 27 | export type GoalPromptControl = LodyGoalPromptControl; export function parseGoalPromptControl(meta: unknown): GoalPromptContr | Type fails; tests not run: error TS2305: Module '"./GoalExtension"' has no exported member 'parseGoalPromptControl'. | Keep: needed by metadata/slash routing or input validation; a green run after deleting the test cannot replace the behavioral judgement of the real action. |
| A245 / 39 | export function parseGoalPromptControl(meta: unknown): GoalPromptControl \| null { if (typeof meta !== "object" \|\| meta === nu | Type fails; tests not run: error TS2724: '"./GoalExtension"' has no exported member named 'parseGoalPromptControl'. Did you mean 'GoalPromptControl'? | Keep: needed by metadata/slash routing or input validation; a green run after deleting the test cannot replace the behavioral judgement of the real action. |
| A246 / 40 | if (typeof meta !== "object" \|\| meta === null) return null; | Type passes; test fails: parseGoalPromptControl > rejects metadata that cannot name a goal action | Keep: needed by metadata/slash routing or input validation; a green run after deleting the test cannot replace the behavioral judgement of the real action. |
| A247 / 42 | if (typeof lody !== "object" \|\| lody === null) return null; | Type / tests pass | Keep: legitimate non-goal metadata may have no `lody`; deleting this throws when reading goalControl. |
| A248 / 44 | if (typeof control !== "object" \|\| control === null) return null; | Type passes; test fails: parseGoalPromptControl > rejects metadata that cannot name a goal action | Keep: needed by metadata/slash routing or input validation; a green run after deleting the test cannot replace the behavioral judgement of the real action. |
| A249 / 46 | if (version !== GOAL_EXTENSION_VERSION) return null; | Type passes; test fails: parseGoalPromptControl > rejects metadata that cannot name a goal action | Keep: needed by metadata/slash routing or input validation; a green run after deleting the test cannot replace the behavioral judgement of the real action. |
| A250 / 47 | if (action === "pause" \|\| action === "resume" \|\| action === "clear") { return {version: GOAL_EXTENSION_VERSION, action}; } | Type passes; test fails: parseGoalPromptControl > reads a resume action from prompt metadata | Keep: needed by metadata/slash routing or input validation; a green run after deleting the test cannot replace the behavioral judgement of the real action. |
| A251 / 50 | if (action !== "set") return null; | Type / tests pass | Keep: an unknown action must not become a set even when it carries an objective; there is no test for that combination today. |
| A351 / 41 | const lody = (meta as Record<string, unknown>)["lody"]; | Type fails; tests not run: error TS2304: Cannot find name 'lody'. | Keep: needed by metadata/slash routing or input validation; a green run after deleting the test cannot replace the behavioral judgement of the real action. |
| A352 / 43 | const control = (lody as Record<string, unknown>)["goalControl"]; | Type fails; tests not run: error TS2304: Cannot find name 'control'. | Keep: needed by metadata/slash routing or input validation; a green run after deleting the test cannot replace the behavioral judgement of the real action. |
| A353 / 45 | const {version, action, objective} = control as Record<string, unknown>; | Type fails; tests not run: error TS2304: Cannot find name 'version'. | Keep: needed by metadata/slash routing or input validation; a green run after deleting the test cannot replace the behavioral judgement of the real action. |
| A354 / 52 | return typeof objective === "string" && objective.trim().length > 0 ? {version: GOAL_EXTENSION_VERSION, action: "set", object | Type passes; test fails: parseGoalPromptControl > reads a set action with its objective | Keep: needed by metadata/slash routing or input validation; a green run after deleting the test cannot replace the behavioral judgement of the real action. |

### `packages/acp-extension-codex/src/__tests__/CodexACPAgent/goal-prompt-lifecycle.test.ts`

| ID / original line | Item deleted or reverted | Type / related tests | Conclusion and constraints |
| --- | --- | --- | --- |
| A127 / 12 | async function startPrompt(prompt = "Pursue the test goal", meta?: Record<string, unknown>) { | Type fails; tests not run: error TS2304: Cannot find name 'meta'. | Keep: still depended on by an executed test fixture or assertion; the legitimate combined simplification is B002/B004, and the reference target alone must not be deleted. |
| A128 / 41 | const response = agent.prompt({sessionId, prompt: [{type: "text", text: prompt}], ...(meta ? {\_meta: meta} : {})}) | Type passes; test fails: Goal continuation through ACP v1 prompt > resumes from prompt metadata without command text or a duplicate turn | Keep: still depended on by an executed test fixture or assertion; the legitimate combined simplification is B002/B004, and the reference target alone must not be deleted. |
| A129 / 85 | test: resumes from prompt metadata without command text or a duplicate turn | Type / tests pass | Keep: still depended on by an executed test fixture or assertion; the legitimate combined simplification is B002/B004, and the reference target alone must not be deleted. |
| A252 / 88 | test: resumes from prompt metadata without command text or a duplicate turn | Type / tests pass | Keep: behavioral coverage of an independent input/path; the remaining tests staying green after deletion does not prove that coverage is replaceable. |
| A355 / 89 | const run = await startPrompt("Continue working toward the active goal.", { lody: {goalControl: {version: 1, action: "resume" | Type fails; tests not run: error TS2304: Cannot find name 'run'. | Keep: still depended on by an executed test fixture or assertion; the legitimate combined simplification is B002/B004, and the reference target alone must not be deleted. |

### `packages/acp-extension-codex/src/__tests__/CodexCommands.goal.test.ts`

| ID / original line | Item deleted or reverted | Type / related tests | Conclusion and constraints |
| --- | --- | --- | --- |
| A130 / 1 | import {parseGoalPromptControl} from "../GoalExtension"; | Type fails; tests not run: error TS2304: Cannot find name 'parseGoalPromptControl'. | Keep: still depended on by an executed test fixture or assertion; the legitimate combined simplification is B002/B004, and the reference target alone must not be deleted. |
| A131 / 41 | test: reads a resume action from prompt metadata | Type / tests pass | Keep: still depended on by an executed test fixture or assertion; the legitimate combined simplification is B002/B004, and the reference target alone must not be deleted. |
| A253 / 46 | test: reads a resume action from prompt metadata | Type / tests pass | Delete: the resume parser coverage duplicates the retained prompt lifecycle test; the remaining tests kill a resume parsing mutation. |
| A254 / 51 | test: reads a set action with its objective | Type / tests pass | Keep: behavioral coverage of an independent input/path; the remaining tests staying green after deletion does not prove that coverage is replaceable. |
| A255 / 56 | test: reads status-only actions for sessions with no running prompt | Type / tests pass | Keep: behavioral coverage of an independent input/path; the remaining tests staying green after deletion does not prove that coverage is replaceable. |
| A256 / 63 | test: rejects metadata that cannot name a goal action | Type / tests pass | Keep: behavioral coverage of an independent input/path; the remaining tests staying green after deletion does not prove that coverage is replaceable. |
