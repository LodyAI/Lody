# Reject Codex compaction waiters when the process exits

Status: implemented
Translation: current

[中文](./2026-09-09-codex-compact-kill-waiters.zh.md)

## Abstract

`/compact` waits on a `thread/compacted` notification. Turn waiters already reject when the Codex process exits; compaction waiters were resolve-only, so a death after `thread/compact/start` left the ACP prompt occupied and the next message `already active`. This host change pins `acp-extension-codex` to `a67f231` (adapter #38 rebased onto current adapter main) so close/dispose rejects those waiters. Healthy compact and mid-turn process death are unchanged. Adapter #38 is not merged yet; this pin must not ship until that merge.

## Decision

- Host gitlink `packages/acp-extension-codex` moves from main's `5f0aab0f` (#554 / adapter #40) to `a67f231` (open adapter PR #38, rebased onto that main).
- Core and other submodules stay on current main. This PR does not touch them.
- `runCompact` keeps registering the waiter first, then `Promise.all`s start + completion, so a vscode-jsonrpc `close` (which does not reject in-flight start RPCs) still finishes the prompt.
- This is not adapter #37 / Lody #544 (fork unsubscribe). It is not open adapter #30 (cancel during compact).

## Evidence and limits

Independent review of adapter #38 used real Codex 0.153.4 and a synthetic model HTTP endpoint: compact-kill returned ACP `-32603` in 10ms with no `already active`; restart + `loadSession` then history, a normal prompt, and another compact all completed. Lifecycle 8/8 included a real vscode-jsonrpc close while start was still pending. Healthy compact and mid-turn kill still completed. Related adapter regression 130 passed; the known `/review` slash-command timeout exists on unpatched `400384e` and is not this pin's regression.

This does not publish the adapter. Desktop users stay on the hang until adapter #38 merges and a release includes this gitlink. No in-window Electron compact-kill was re-run on this host pin; acceptance was adapter protocol plus host error classification (`-32603` should terminate the adapter).

Related: [adapter #38](https://github.com/LodyAI/acp-extension-codex/pull/38), [adapter #37](https://github.com/LodyAI/acp-extension-codex/pull/37) / [Lody #544](https://github.com/LodyAI/Lody/pull/544) (already merged, not this change).
