# Cancel compaction through the native turn

Status: implemented
Translation: pending

## Abstract

Manual Codex `/compact` was treated as a command without a native turn, so Stop
could return an ACP cancellation while Codex kept compacting. The adapter now
captures the native turn and interrupts it through the ordinary cancellation
path, retaining ownership until terminal confirmation. Lody sends provider cancel
without interrupting an in-flight prompt's owner fiber, so normal cancellation
finalizes history only after ACP returns. PR #618 removes its automatic historical
reconciliation protocol and fixes these execution boundaries.
Existing stale histories are not migrated by opening a conversation.

## Decision

Codex 0.153.4 emits standard turn and item notifications for manual compaction.
`thread/compact/start` acknowledges submission with an empty result; the turn id
arrives through `turn/started`. The previous assumption that compaction had no
interruptible turn confused an empty acknowledgement with an absent lifecycle.

The app-server client registers an owner before submission and resolves only on
the matching `turn/completed`. Start failure and connection closure reject the
owner. The command routes the native id and terminal result through the same ACP
command lifecycle used by other native turns. Stop and request cancellation both
interrupt the captured turn. A cancellation before its id arrives stays pending
until the turn starts; the ACP prompt remains occupied while cancellation drains.

Lody records `runtime.cancelRequested` and sends provider cancel while the prompt
is in flight. It retains the existing owner fiber and runtime until ACP returns;
the scope then runs cancellation finalization and releases ownership. A new user
message remains pending and cannot reach ACP during that interval. Steer admission
also checks the existing cancellation flag, including after asynchronous preparation,
so a handoff cannot submit a second prompt while the cancelled provider drains. Cancellation
before prompt submission and finalization teardown retain their existing paths.

The earlier CLI code already retained the runtime through `pendingPromptCompletion`
inside its scope finalizer; it did not unconditionally release ownership at Stop.
It nevertheless interrupted the owner fiber and finalized history before draining
the provider. Normal Stop now waits in the prompt itself. External owner interruption
still uses that existing raw-request drain and termination fallback. A provider
that never completes after normal Stop keeps ownership; this change adds no timer
or forced-termination policy to that path.

After ACP completion, the existing CLI finalization from
[provider-failure settlement](2026-09-10-context-compaction-terminal-state.md)
then persists unresolved compaction as failed before releasing execution ownership.
Explicit provider terminal item updates remain authoritative.

The Session view does not initiate data repair. The branch's new reconciliation
capability, both transport methods, renderer retry hook, and daemon history repair
are removed. Historical unresolved records are a separate maintenance concern;
neither hiding progress nor rewriting history can interrupt native execution.

## Evidence and verification

- [Pinned native protocol](https://github.com/openai/codex/blob/rust-v0.153.4/codex-rs/app-server/README.md#example-trigger-thread-compaction).
- Adapter owner: `packages/acp-extension-codex/src/CodexAppServerClient.ts`;
  command and cancel routing: `CodexCommands.ts` and `CodexAcpServer.ts` in that directory.
- Deterministic tests cover Stop and request abort before/after native start,
  rejection of a second prompt while draining, successful continuation after
  interruption, failure, terminal events before the start ACK, start rejection,
  unrelated turn completion, and process exit before/after native start.
- The Lody execution suite uses the real `AgentClient` with a controlled ACP
  transport: cancel ACK leaves the prompt signal live and history unfinished,
  a second dispatch stays pending, and native terminal evidence enables the next
  prompt. External-interruption coverage retains raw completion, process termination,
  and failed-termination cases.
- Steer coverage retains undelivered history and its dispatch pointer when Stop
  precedes the request or arrives while prompt blocks are being built.
- Contract: [Session history writes](../../../../specs/session-history-writes.md).
- Pull request: [Lody #618](https://github.com/LodyAI/Lody/pull/618).
- Adapter implementation: [Codex adapter #41](https://github.com/LodyAI/acp-extension-codex/pull/41).

Adapter typechecks and all 617 enabled adapter tests passed; 27 tests are skipped
by their existing environment gates. Real Codex smoke checks completed manual
compaction normally and confirmed that Stop produces native `interrupted` before
the ACP prompt returns `cancelled`.

Root typechecks, lint, formatting, i18n, documentation and boundary checks passed.
The targeted Lody execution, dispatch-watcher and AgentClient suites pass 203 tests.
The full `pnpm check` reached Electron tests: 103 passed, while the relay suite
could not load because this checkout lacks the installed Electron binary. All
preceding workspace test suites passed. Documentation translation remains pending.
