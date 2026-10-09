# apps/cli/src/session

`CLAUDE.md` is a symlink to this file. Edit `AGENTS.md` only.

Module map and contracts: [README.md](README.md).
Worktree rules: [worktree/AGENTS.md](worktree/AGENTS.md).

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
- Machine/Provider credentials stay host-scoped. Attribution, authorization and commits
  use the frozen Turn identity; GitHub network auth uses the trusted conversation owner.
- Git: owner uses local config, no profile query; others never read it.
  `CloudPort` profiles: 60s deadline, retry failures, reject placeholders.
  Commit attribution never restarts ACP; owner changes retire the runtime.

## Dispatch

- Queue promotion preserves frozen fields; remove its row only after history and activation succeed.
- Absent session meta is "unknown", not foreign: hold the TTL-bounded RPC stash until meta lands;
  drop it only on a definitive verdict.
- Subscribe to RPC offers BEFORE awaiting Doc Room join/sync and never dispatch from the RPC
  handler; history sync is the durable fallback, not a fast path.
- Missing-history recovery never advances `lastHandledUserMsgId`: set the permanent one-shot
  `lastMissingHistoryUserMsgId` ack for that turn and surface `chat_failed`.
- Retire an already-terminal stale activation into `settledActivationUserMsgId`; never claim the
  marker or rewrite `latestUserMsgId`, and report settled only if none survives.
- Never replay late history; recovery is a new send. Use last row per ID; stop no-progress repairs.
- `hasPendingUserTurnActivation` is the ONLY pending-turn predicate; never compare those two
  pointers in a consumer.
- Never inspect historical Session documents to infer work, or publish or clear active presence
  here (`../lib/loro/session-active-presence.ts`).
- Keep bootstrap and live reconciliation bounded as README describes; add no per-trigger scan or
  extra throttle.

## Turn execution

- Gate turn-scoped LIST writes on user-entry sync (`turn-history-gate.ts`, 20s), never status/meta.
- Goals obey [this contract](../../../../specs/session-goal-control.md).
- Stop ends local steer waits, not the owner fiber. Drain raw prompt/steer/config work before
  reuse, or confirm termination. Assistant ids use `userTurnId`.
  `invocation` owns source Turn, requester and config atomically; steer replaces it before tools.
- Publish `latestUserMsgId` in the SAME write as the history append (`appendUserTurn`). Only
  dispatch producers publish it. Renderer sends and queue promotion retain the missing-history
  tombstone; CLI dispatch producers keep their own marker policy.
- Ordinary turn execution writes only `processingUserMsgId` and `lastHandledUserMsgId`; no start
  or terminal path may read-await-rewrite the other slots.
- Never steer after cancellation or infer delivery from it. Stop uses
  `pendingInput: promote` / `prePromptSession: discard`; Edit & Resend uses preserve/keep,
  access revocation preserve/discard. Limit create/restore fences to initialization.
- Promote only proven non-delivery via `steerTurnStatuses`, never producer pointers.
  Unknown never replays; RPC ACKs never revive history. Surface recovery errors.
- Foreground/steer config uses its owner signal; fence mutations after interrupt.
- Resume must REOPEN the in-progress assistant entry, clearing
  `finished`/`endedAt`/`permissionWaitMs` there only; never write `finished=false` from teardown.
- Keep JSON-RPC/transport matching in `acp-error-classification.ts`: disposed/stale `-32603` is
  `agent_disconnected`, Harness compression mismatch is `acp_session_storage_incompatible`.
- Continue-session recovery may restore the ACP session and retry the same prompt once, only
  while that turn has no ACP output.
- A turn with no ACP updates takes `recordSilentTurnFailure`, not `setDispatchHandled`.
  Read `turnProducedVisibleOutput` before `finalizeTurn` clears it; still finalize, advance
  the pointer, and fail open.
- Diff content comes only from the CLI-local ACP evidence store; GitHub `diffStats` use PR compare
  semantics, and `session-diff-stats-target.ts` skips rather than overwrites a good total.

## Lifecycle

- For Roost reads, follow [paging rules](README.md#roost-history-paging).

- `Session.createAgent` gates each ACP spawn; failed spawns reject JSON-RPC. Terminals spawn
  protocol argv (`sh -c` only for unsplit commands). Managed Codex reused-refresh startup
  retries once after process cleanup, delay, and live Provider recheck; other auth errors do not.
- Child tabs reuse the parent workspace. Never write per-session paths into `MachineMeta`:
  the machine publishes `['dotlodyPath']` for frontends to derive them.
- INVARIANT: any `sandbox.spawn` whose OUTPUT is the result must pass `captureOutput: true` (ACP
  stdio deliberately does not), and the capture buffer stays capped at 4 MiB.
- Shutdown is two-phase: `cleanUp({ keepWorkspaceDocumentOpen: true })`, then plain `cleanUp()`
  after MessageHandler's final flush. Never tear the document down first.

## Sagas

- Preparation peek/claim are synchronous; peek never transfers ownership. Cold/replacement starts
  await same-session cleanup, even after lease removal or late creation. Publish before `start()`.
  Before adoption: marked worktree creation and `newSession` only; no doc, setup, history or events.
- Dispatch/claim rescan current config using canonical `buildSessionLaunchConfig`; reject changed
  compatibility and await incompatible-resource cleanup.
- Nested child Sessions are rejected: ownership resolves one parent hop only.
- Fork and continuation share `resolveSessionAcpTargetId`; source runtime config copies only at its matching user-turn fence.
- Fork commits at `persistPendingChanges()`, never cloud sync. Persist its placeholder
  before ACP; failed commits terminate and durably delete the target. Post-commit
  display projections stay outside compensation.
- Active-turn fork requires advertised `_meta.lody.forkAtTurn = { version: 1 }`; pass adapter
  `_meta.lody.turnId` unchanged as `acpTurnId`, and reuse source Git identity only for an exact requester.
  New-worktree forks require native support, persist target-doc `forkOperation` before return,
  publish target meta only after final commit, clean ACP/worktree/branch with a durable failed
  receipt, and stay idempotent on retry.
- Fork recovery fail-closes interrupted operations and finds them ONLY in machine-local markers
  under `withForkOperationLock`; never enumerate rooms/open docs for candidates or clean an unowned doc.
- Edit-and-resend prepares `forkAtTurn` (`session/new` for the first User), cancels the exact
  turn, waits for release, then commits history/meta. Its barrier excludes queue promotion,
  dispatch and steer. Keep the queue, User attribution/config/attachments; use new turn/ACP ids.
  Never replay transcript or roll back files.

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
