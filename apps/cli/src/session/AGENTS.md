# apps/cli/src/session

`CLAUDE.md` is a symlink to this file. Edit `AGENTS.md` only.

[README.md](README.md); worktrees/git:
[worktree/AGENTS.md](worktree/AGENTS.md). context/message-flow.md.
specs/session-orchestration.md.

## Authorization and identity

- Authorize the target machine via the injected access capability with the source CLI token.
  MCP delegation verifies the frozen Turn requester; Operations: [../mcp/AGENTS.md](../mcp/AGENTS.md).
- Workspace Machine RPC authenticates no member identity; never send untrusted requesters through it.
- Live status requires target-daemon Machine RPC, not durable metadata.
- Derive human identity from active dispatch/execution runtime; fail closed without it. Retries and
  recovery never reread mutable history. Host-scoped Machine/Provider credentials differ
  from attribution, authorization, GitHub and Git identity: use the frozen identity, never Session owner.
- Every minting path resolves `CloudPort.access.resolveWorkspaceUser` before host git
  config; missing-email placeholders are not identities.
- Account switch needs local dispatch plus an out-of-band verifier before
  reads and handoff; never trust serialized requester/source.
- Restart/fork/edit/helpers use installation-local `session-account-binding-store.ts`, keyed by
  workspace/machine/session. Synced fields/receipts are display-only; missing managed/corrupt
  records fail closed; legacy uses `system-default`.

## Dispatch

- Queue promotion preserves frozen Turn fields, including Role id/revision (`agentRoleId`/`agentRoleRevision`).
- Absent meta is unknown, not foreign: hold the TTL-bounded RPC stash; drop only
  on a definitive verdict. Subscribe to RPC offers BEFORE Doc Room join/sync. Never dispatch from
  the RPC handler; history sync is durable fallback, not fast path.
- Missing-history recovery never advances `lastHandledUserMsgId`: set the turn's permanent one-shot
  `lastMissingHistoryUserMsgId` ack and surface `chat_failed`.
- Retire terminal stale activation into `settledActivationUserMsgId`; never claim the marker or
  rewrite `latestUserMsgId`. Report settled only if none survives.
- Never redispatch late history; recovery is a fresh send. `hasPendingUserTurnActivation` is the
  ONLY pending-turn predicate; never compare pointers in consumers.
- Metadata is the activation index: never inspect historical Session docs to infer work or publish/
  clear active presence here (`../lib/loro/session-active-presence.ts`). Keep bootstrap and live
  reconciliation bounded as README describes; add no per-trigger scan or extra throttle.

## Turn execution

- Gate turn-scoped history LIST writes on user-entry sync (`turn-history-gate.ts`, 20s), never status/meta.
- An `active` goal cannot suppress completion/notification.
- No second visible turn while `TurnRuntimeState` exists. Assistant entry ids derive from
  `userTurnId`; `invocation` atomically owns source Turn, requester and input config. Steer replaces
  it before tool execution.
- Only dispatch producers write `latestUserMsgId` atomically with history (`appendUserTurn`).
  Renderer sends/queue promotion retain the missing-history tombstone; CLI producers keep their marker policy.
- Ordinary execution writes only `processingUserMsgId`/`lastHandledUserMsgId`; start/terminal paths
  never read-await-rewrite other slots.
- Unaccepted steer must not remain `pending_apply`: requeue via pointer, never entry status, only
  for pre-submission rejection or `AgentSteerNotDeliveredError`; skip active/already-handled entries.
- Resume REOPENS the active assistant entry; clear `finished`/`endedAt`/`permissionWaitMs`
  there only; teardown never writes `finished=false`.
- JSON-RPC/transport matching stays in `acp-error-classification.ts`: disposed/stale `-32603` maps to
  `agent_disconnected`, Harness compression mismatch to `acp_session_storage_incompatible`.
- Continue-session recovery may restore ACP/retry the same prompt once before any ACP output.
- Resolved prompt is not success proof. No ACP update means `recordSilentTurnFailure`, not
  `setDispatchHandled`; read `turnProducedVisibleOutput` before `finalizeTurn` clears it. Still
  finalize, ADVANCE the pointer and fail open.
- Diffs use only CLI-local ACP evidence. GitHub `diffStats` use PR compare;
  `session-diff-stats-target.ts` skips rather than overwrites a good total.

## Lifecycle

- `Session.createAgent` acquires the shared ACP start gate before spawn. ACP terminals pass executable/
  argv directly to `SessionSandbox.spawn`, not a rebuilt shell command.
- Child tabs reuse the parent workspace. Never write per-session paths into `MachineMeta`; publish
  `['dotlodyPath']` and let frontends derive them.
- Output-returning `sandbox.spawn` requires `captureOutput: true` (ACP stdio does not); cap at 4 MiB.
- Shutdown: `cleanUp({ keepWorkspaceDocumentOpen: true })`, MessageHandler's final flush, then plain
  `cleanUp()`. Never tear down documents first.

## Sagas

- Handoff holds the rewrite barrier through validation, local checkpoint, teardown,
  replacement/`persistPendingChanges`. Refuse pending/running exec/ACP terminals after
  turn end. Pending intent never overrides the committed pair on restart; candidates
  defer binding persistence and notifications/interactive requests until commit.
- Fresh sessions retain `accountContinuation` until prompt output consumes bounded
  history replay; preserve full Lody history. Auth: `agent/account-profiles.ts`;
  System Default preserves the environment. No prepared defaults for managed accounts.
- Managed processes hold the provider's process-wide account lease across startup/lifetime;
  sign-in holds the matching exclusive lease. Rate-limit events carry session and account identity.
  Transition receipts retain switch request ids; old replay cannot undo later choices.
- Preparation peek/claim never delay cold fallback; peek transfers no ownership. Publish
  resource BEFORE `start()`. Preparation may create the marked worktree and finish `newSession`,
  but cannot create docs, setup, history or events before adoption.
- Dispatch/claim rescan the current row under canonical `buildSessionLaunchConfig`; reject changed
  compatibility and clean published incompatible resources first. Reject nested children; one parent hop.
- Fork commits at `LoroDocumentManager.persistPendingChanges()`, never cloud `waitUntilSynced()`.
  Persist target placeholder before ACP; failed commit terminates it and durably deletes target.
- Active-turn fork requires `_meta.lody.forkAtTurn = { version: 1 }`; pass adapter
  `_meta.lody.turnId` unchanged as `acpTurnId`. Reuse source Git identity only on exact requester match.
  New-worktree forks require native fork, persist target `forkOperation` before
  returning, publish target meta only at final commit, clean ACP/worktree/branch with a durable
  failed receipt, and keep retries idempotent.
- Fork recovery fail-closes using ONLY local markers under
  `withForkOperationLock`; never enumerate rooms/open docs to discover candidates or `cleanSessionDoc`
  an unowned doc. Mark before same-worktree preparation; journal through commit.
- Edit/resend prepares `forkAtTurn` (`session/new` for first User), cancels the exact turn and awaits
  release. Journal before history/meta flush, promote after; recovery matches local source/target
  history hashes. Pending journals block resume; failed rollback keeps them.
  Barrier excludes promotion/dispatch/steer. Keep queue, User attribution/config/attachments;
  use new turn/ACP ids, never replay transcripts or roll back files.

## Access

- Never write per-session `sessionLaunchConfig`: `session/create` is transient; resume/dispatch
  resolve agent config/project, with legacy row fallback only.
- Access checks local policy then optional-cloud three-state. Owner cache may allow offline;
  `remote_missing`/definitive `denied` fail; `indeterminate` stays pending behind
  `verifyMachineAccessWithRetry()`. Never turn a thrown check into denial.
- Owner-allowed dispatch fires `fireOwnerAccessRecheck` with `forceBackendVerification`.
  Only online allow writes snapshot/`verifiedAt`; deny clears it; indeterminate writes nothing.
