# Keep forked Codex sessions subscribed

Status: implemented
Translation: current

[中文](./2026-09-09-codex-fork-keep-subscribed.zh.md)

## Abstract

Forking a Codex Session immediately unsubscribed the child thread. The host treats that child as a live Session and waits for `turn/completed` notifications, so the first prompt never finished, Stop reported no active turn, and the next prompt was `already active`. This host change pins `acp-extension-codex` to `fc91dce` (adapter #37) so a successful fork keeps the child subscribed, and pins `acp-extension-core` 0.1.2 because that adapter already requires it. It does not take Lody #534's host worktree-identity changes. Adapter #37 is not merged yet; this pin must not ship until that merge.

## Decision

- Host gitlink `packages/acp-extension-codex` moves from main's `f9dbc8c` to `fc91dce` (open adapter PR #37, based on already-merged #35 / `400384e`).
- Host gitlink `packages/acp-extension-core` moves from `1aa2431` to published 0.1.2 `9c47fec`. Root `pnpm-lock.yaml` stays `workspace:*` and did not need a rewrite; the adapter's own npm lock inside the submodule already names Core 0.1.2.
- Lody #534 also pins Core `9c47fec` plus Codex `89b1208` (#35 plus an unmerged review-fixture test) and host AgentClient/session-manager identity code. This PR shares only the Core 0.1.2 gitlink. It does not copy #534 host files. If #534 merges first, the Codex gitlink will need a rebase onto that sibling (`89b1208` vs `fc91dce`).
- `LODY-FORK-001` remains a runtime-simulator journey (`session-fork-acp.mjs`). It can regress host fork RPC, but it does not execute the real Codex adapter and is not the fix acceptance.

## Evidence and limits

Independent review of adapter #37 (`fc91dce`) used real Codex 0.153.4 and a synthetic model HTTP endpoint: parent, fork first turn, fork second turn, parent after child, and close-child unsubscribe all passed. The same probe against the previous bundled unsubscribe hung on the first child prompt.

The rebuilt desktop CLI (`apps/electron/resources/cli/codex-acp.js` → `chunks/index-DfT2wei0.js`) keeps unsubscribe only in the `assignProject` failure path. Independent bundled-adapter replay of that new chunk passed the same live turns; the old chunk hung.

This does not publish the adapter. Desktop users stay broken until adapter #37 merges and a release includes this gitlink. Isolated Electron UI launch uses `LODY_E2E=1` and unique data/host ports so it does not take the single-instance lock from a developer's existing window. That launch is a desktop boot smoke (it opened `#/local/chat` without touching the developer's instance). It is not an in-window Codex fork. `LODY-FORK-001` was not used as fix acceptance.

Related: [Lody #543](https://github.com/LodyAI/Lody/issues/543), [adapter #37](https://github.com/LodyAI/acp-extension-codex/pull/37), [Lody #534](https://github.com/LodyAI/Lody/pull/534) (not included).
