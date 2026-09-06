# apps/cli/src/session

`CLAUDE.md` is a symlink to this file. Edit `AGENTS.md` only.

Rules only; responsibilities and reasoning: [README.md](README.md). Worktrees and git
credentials: [worktree/AGENTS.md](worktree/AGENTS.md). Architecture: context/message-flow.md.
Contract: specs/session-orchestration.md.

## Authorization and identity

- Authorize the target machine through the injected access capability with the source CLI token;
  MCP delegation verifies the frozen Turn requester; Operation-side rules are in
  [../mcp/AGENTS.md](../mcp/AGENTS.md).
- Never send an untrusted requester through workspace Machine RPC: it authenticates no member
  identity.
- Live status is a target-daemon Machine RPC read; durable metadata is not a live-presence
  substitute.
- Derive the human identity from the active dispatch/execution runtime and fail closed when none
  exists; retries and recovery never reread mutable history.
- Machine and Provider credentials stay execution-host scoped; attribution, authorization,
  GitHub, and Git identity use the frozen identity, never the Session owner.
- Commit identity MUST resolve through `CloudPort.access.resolveWorkspaceUser` before host git
  config; a missing-email placeholder is never one, and every minting path resolves it.

## Dispatch

- Queue-to-history promotion preserves every frozen Turn field, `agentRoleId` and
  `agentRoleRevision` included.
- Absent session meta is "unknown", not foreign: hold the TTL-bounded RPC stash until meta lands;
  drop it only on a definitive verdict.
- Subscribe to RPC offers BEFORE awaiting Doc Room join/sync and never dispatch from the RPC
  handler; history sync is the durable fallback, not a fast path.
- Missing-history recovery never advances `lastHandledUserMsgId`: set the permanent one-shot
  `lastMissingHistoryUserMsgId` ack for that turn and surface `chat_failed`.
- Retire an already-terminal stale activation into `settledActivationUserMsgId`; never claim the
  marker or rewrite `latestUserMsgId`, and report settled only if none survives.
- Never re-dispatch a late-arriving history entry; recovery is a fresh send.
- `hasPendingUserTurnActivation` is the ONLY pending-turn predicate; never compare those two
  pointers in a consumer.
- Session metadata is the activation index: never inspect historical Session documents to infer
  work, and never publish or clear active presence here (`../lib/loro/session-active-presence.ts`).
- Keep bootstrap and live reconciliation bounded as README describes; add no per-trigger scan or
  extra throttle.

## Turn execution

- Gate turn-scoped history LIST writes on user-entry sync (`turn-history-gate.ts`, 20s);
  never gate status or meta writes.
- An `active` session goal must not suppress turn completion or its notification.
- Never mint a second visible turn while a `TurnRuntimeState` is registered; derive assistant
  entry ids from `userTurnId`. `invocation` atomically owns source Turn, requester, and input
  config; steer replaces it before tool execution.
- Publish `latestUserMsgId` in the SAME write as the history append (`appendUserTurn`). Only
  dispatch producers publish it. Renderer sends and queue promotion retain the missing-history
  tombstone; CLI dispatch producers keep their own marker policy.
- Ordinary turn execution writes only `processingUserMsgId` and `lastHandledUserMsgId`; no start
  or terminal path may read-await-rewrite the other slots.
- INVARIANT: a steer the agent never accepted must not stay parked in `pending_apply`. Requeue it
  through the pointer, not the entry status, only for pre-submission rejections or
  `AgentSteerNotDeliveredError`; skip active or already-handled entries.
- Resume must REOPEN the in-progress assistant entry, clearing
  `finished`/`endedAt`/`permissionWaitMs` there only; never write `finished=false` from teardown.
- Keep JSON-RPC/transport matching in `acp-error-classification.ts`: disposed/stale `-32603` is
  `agent_disconnected`, Harness compression mismatch is `acp_session_storage_incompatible`.
- Continue-session recovery may restore the ACP session and retry the same prompt once, only
  while that turn has no ACP output.
- INVARIANT: a resolved prompt is not proof of success. A turn that emitted no ACP update takes
  `recordSilentTurnFailure`, not `setDispatchHandled` (read `turnProducedVisibleOutput` before
  `finalizeTurn` clears it); it still finalizes, still ADVANCES the pointer, and fails open.
- Diff content comes only from the CLI-local ACP evidence store; GitHub `diffStats` use PR compare
  semantics, and `session-diff-stats-target.ts` skips rather than overwrites a good total.

## Lifecycle

- `Session.createAgent` acquires the shared ACP start gate before spawn. ACP terminal creation
  passes the protocol's executable and argv straight to `SessionSandbox.spawn`, never a rebuilt
  shell command.
- Child tab sessions reuse the parent workspace directory. Never write per-session workspace paths
  into `MachineMeta`: the machine publishes `['dotlodyPath']` and frontends derive them.
- INVARIANT: any `sandbox.spawn` whose OUTPUT is the result must pass `captureOutput: true` (ACP
  stdio deliberately does not), and the capture buffer stays capped at 4 MiB.
- Shutdown is two-phase: `cleanUp({ keepWorkspaceDocumentOpen: true })`, then plain `cleanUp()`
  after MessageHandler's final flush. Never tear the document down first.

## Sagas

- `session-preparation-service.ts`: peek and claim never delay cold fallback, peek never transfers
  ownership, and the resource is published BEFORE its `start()` hook. Preparation may create the
  final marked worktree and complete `newSession`, but must not create a session doc, run setup,
  append history, or publish events before adoption.
- Dispatch and claim rescan the current row and reject changed compatibility under canonical
  `buildSessionLaunchConfig` semantics; a published incompatible resource cleans up first.
- Nested child Sessions are rejected: ownership resolves one parent hop only.
- Fork commits at `LoroDocumentManager.persistPendingChanges()`; cloud `waitUntilSynced()` is
  never a success condition. Persist the target placeholder before ACP; a failed final commit
  terminates the fork and durably deletes the target.
- Fork an active source turn only on an advertised `_meta.lody.forkAtTurn = { version: 1 }`, pass
  the adapter's `_meta.lody.turnId` through unchanged as `acpTurnId`, and reuse the source Git
  identity only on an exact requester match. New-worktree forks also require native fork support,
  persist a target-doc `forkOperation` before returning, publish no target meta before the final
  commit, clean up ACP and the worktree/branch with a durable failed receipt, and stay idempotent
  on retry.
- Fork recovery fail-closes interrupted operations and finds them ONLY in the machine-local marker
  store under `withForkOperationLock`. Never enumerate rooms or open docs to find candidates, and
  never `cleanSessionDoc` a doc you do not own.
- Edit-and-resend prepares provider `forkAtTurn` (`session/new` for the first User), cancels the
  exact active turn, waits for ownership release, then one durable history/meta commit.
  Its rewrite barrier excludes queue promotion and blocks dispatch and steer; the queue is never
  rewritten. Keep the original User attribution, config, and attachments, use new turn ids and ACP
  identity, and never replay transcript or roll back files.

## Access

- Never write per-session `sessionLaunchConfig`: the first `session/create` payload is transient,
  resume and dispatch resolve from agent config/project, and the legacy row is fallback only.
- Dispatch access is local policy first, optional-cloud three-state second: owner-cached policy
  may allow offline, `remote_missing` and a definitive `denied` fail the turn, `indeterminate`
  leaves it pending behind `verifyMachineAccessWithRetry()`. Never collapse a thrown check into
  denial.
- Every owner-allowed dispatch fires `fireOwnerAccessRecheck` with `forceBackendVerification`; a
  confirmed online allow is the ONLY writer of the access snapshot and `verifiedAt`, a deny clears
  it, `indeterminate` writes nothing.
