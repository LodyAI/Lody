# apps/cli/src/session

`CLAUDE.md` links here; edit this file.

[Docs](README.md); [worktree rules](worktree/AGENTS.md).

## Authorization and identity

- Authorize target machines via injected access with the source CLI token. MCP delegation
  verifies the frozen Turn requester; Rules:
  [../mcp/AGENTS.md](../mcp/AGENTS.md).
- Never send an untrusted requester through workspace Machine RPC: it authenticates no member identity.
- Live status is a target-daemon Machine RPC read; durable metadata never substitutes for it.
- Require frozen human identity and pre-launch `humanInputReceipts`; recover via receipts,
  never role/author. [Rules](../orchestration/AGENTS.md).
- Host-scope Machine/Provider credentials. Use frozen Turn identity for attribution,
  authorization and commits; trusted conversation owner for GitHub network auth.
- Git: owner uses local config, no profile query; others never read it.
  `CloudPort` profiles: 60s deadline, retry failures, reject placeholders.
  Commit attribution never restarts ACP; owner changes retire the runtime.

## Dispatch

- Queue promotion preserves frozen fields; remove only after history+activation succeed.
- Absent meta is unknown, not foreign: hold the TTL-bounded RPC stash until meta lands or
  a definitive verdict.
- Subscribe to RPC offers BEFORE awaiting Doc Room join/sync and never dispatch from the RPC
  handler; history sync is the durable fallback.
- Missing-history recovery never advances `lastHandledUserMsgId`: set that turn's permanent
  one-shot `lastMissingHistoryUserMsgId` ack and surface `chat_failed`.
- Retire a terminal stale activation into `settledActivationUserMsgId`; never claim the
  marker or rewrite `latestUserMsgId`, and report settled only if none survives.
- Never replay late history; recovery is a new send. Use last row per ID; stop no-progress repairs.
- `hasPendingUserTurnActivation` is the ONLY pending-turn predicate; consumers never compare
  pointers.
- Stop data: control doc; meta: pointer. Never scan old docs for work or change active presence
  here (`../lib/loro/session-active-presence.ts`).
- Bound reconciliation per README (no per-trigger scans/throttles); close
  [dead turns](README.md#dead-turns); ack empty queues only with causal proof.

## Turn execution

- Gate LIST writes on user-entry sync (`turn-history-gate.ts`, 20s), never status/meta.
- Goals obey [this contract](../../../../specs/session-goal-control.md).
- Stop ends steer waits, not the owner fiber. Drain raw ACP or confirm termination, then clear
  presence before reuse. [Inbox admission](../orchestration/AGENTS.md); execution IDs stay fixed.
  Assistant ids use `userTurnId`; `invocation` owns source/requester/config; steer replaces it.
- Only dispatch producers publish `latestUserMsgId`, with history in `appendUserTurn`
  or Roost's `accept_input_and_dispatch` writer queue. Save human provenance first;
  guard live history/meta and newer activation; keep producer-specific tombstones.
- Turn execution writes only `processingUserMsgId` and `lastHandledUserMsgId`; no start
  or terminal path may read-await-rewrite the other slots.
- Never steer after cancellation or infer delivery from it. Stop uses
  preserve/discard and cancels pre-Stop queued eligibility; Edit & Resend uses preserve/keep,
  access revocation preserve/discard. Limit create/restore fences to initialization.
- Promote only proven non-delivery via `steerTurnStatuses`, never producer pointers.
  Unknown never replays; RPC ACKs never revive history. Surface recovery errors.
- Config uses its owner signal; fence mutations after interrupt.
- Resume must REOPEN the in-progress assistant entry, clearing
  `finished`/`endedAt`/`permissionWaitMs` there only; never write `finished=false` from teardown.
- Keep JSON-RPC/transport matching in `acp-error-classification.ts`: disposed/stale `-32603` =
  `agent_disconnected`, Harness compression mismatch = `acp_session_storage_incompatible`.
- Stale ACP: retry once before any event; retire, retain cleanup, keep the turn. Never retry submitted
  Inbox inputs (human-plus-batch too).
- Completion publication follows [notification ownership](../lib/notifications/AGENTS.md).
- No content: `recordSilentTurnFailure`, not `setDispatchHandled`. Await
  `turnProducedVisibleOutput` before `finalizeTurn`; finalize, advance pointers, fail open.
- Diff content comes only from the CLI-local ACP evidence store; GitHub `diffStats` use PR compare
  semantics; `session-diff-stats-target.ts` skips, never overwrites, a good total.

## Lifecycle

- [Roost](README.md#roost-history-paging): gate owner/backend. No keyring/rotation/fallback,
  removed-history revival, uncertain steer replay/retry or log/receipt pruning. Atomic edits/digests/metadata;
  agent v2/renderer v3. SDK owns input/permission/branch; local causes+RPC stage/code/ID.
  Native proofs gate path reuse/goal read elision; head/watch replaces Loro cursor.
- `Session.createAgent` gates ACP spawn; failures reject JSON-RPC. Terminals: argv (shell for
  unsplit lines only), direct exit and bounded drain. Managed Codex reused-refresh retries once after process cleanup, delay and live Provider recheck; other auth errors do not.
- Child tabs reuse parent workspace. No per-session paths in `MachineMeta`:
  machines publish `['dotlodyPath']`; frontends derive them.
- `sandbox.spawn` returning OUTPUT requires `captureOutput: true` and a 4 MiB buffer cap;
  ACP stdio does not capture.
- Keep startup stderr: [rules](README.md#start-failures).
- Shutdown: `cleanUp({ keepWorkspaceDocumentOpen: true })`, MessageHandler's final flush,
  then `cleanUp()`; never close the doc first.

## Sagas

- ACP processes and worktrees start at dispatch, never while a draft is typed. Answer
  `session/prepare`/`-cancel` at once as no-ops (prepare: accepted duplicate), with no access check
  ([decision](../../../../.agents/notes/implemented/simplification/2026-10-16-remove-draft-session-preparation.md)).
- Credentials are runtime leases: a failed creation releases that generation; local has none.
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
- Dispatch access: local policy, then optional-cloud three-state. The owner cache or a member
  allow confirmed <1h ago may allow offline; `remote_missing`/definitive `denied` fail the turn;
  `indeterminate` stays pending behind `verifyMachineAccessWithRetry()`. A throw is never denial.
- Only confirmed backend verdicts write caches (allow refreshes `verifiedAt`, deny clears,
  `indeterminate` nothing). Owner hits recheck with `forceBackendVerification`; member
  entries bind requester, project, CLI account and Machine.
