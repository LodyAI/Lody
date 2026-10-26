# Keep PR data ownership separate from action dispatch

Status: implemented
Translation: current
Pull request: https://github.com/LodyAI/Lody/pull/1908

[中文](2026-10-26-pr-action-target-session.zh.md)

## Abstract

The PR view used the workspace-owner session ID both to load PR data and to find the live conflict-resolution action. For a child conversation, that sent the prompt to the root conversation. `PrTabContainer` now receives a separate action target from the resolved selection while retaining the owner ID for GitHub queries and analytics. Tests cover root, resolved child, pending child, draft, and empty selections; ablation makes the three missing-target cases offer the root action. Browser captures show the baseline misroute and the fixed child and no-target outcomes in a synthetic session fixture using the production tab bar, conversation stream, and PR conflict view.

## Decision

In `SessionDetail`, preserve `prSessionId` as the PR data owner and pass
`activeSessionTabId` separately as `actionSessionId` to both PR-view surfaces.
This is the existing resolved selection used by the common desktop/mobile
session shell: it retains the root ID and a visible child ID, while returning
`null` for an unresolved child, draft, or empty tab. Do not use
`activeTabSession?.id`; its display fallback intentionally returns the root
metadata when a child is unresolved. `PrTabContainer` reads the conflict action
only from the execution target, so missing selection remains unavailable.

## Evidence and limits

The existing `session-chat-interface.tsx` publishes the action under its own
`session.id`, while `getSessionGitHubState` resolves `sourceSessionId` to the
workspace owner. Those are different identities for a child tab. The existing
`pr-tab-container.test.tsx` now drives the same active-tab resolver used by
`SessionDetail` into the rendered conflict action and checks the prompt
destination. It covers root, resolved child (while PR queries retain the root
owner), pending child, draft, and empty tabs. With Node 26.12.1 and the identical
lockfile dependency tree, all 9 tests pass. Ablating the resolver's no-target
result to fall back to root makes all three pending/draft/empty cases offer the
root action (3 failures, 6 passed). Browser acceptance used a synthetic session
fixture with the production `SessionTabBar`, conversation page/stream, and PR
conflict view: baseline pending-child dispatch landed in root; fixed child
dispatch landed in child, and fixed pending/draft states showed no resolve
action or root prompt. Screenshots are attached to PR #1908.
