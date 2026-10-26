# Keep PR data ownership separate from action dispatch

Status: implemented
Translation: current
Pull request: https://github.com/LodyAI/Lody/pull/1908

[中文](2026-10-26-pr-action-target-session.zh.md)

## Abstract

The PR view used the workspace-owner session ID both to load PR data and to find the live conflict-resolution action. For a child conversation, that sent the prompt to the root conversation. `PrTabContainer` now receives the existing resolved selection as a separate action target while retaining the owner ID for GitHub queries and analytics. Container tests verify child, root, and missing targets; the session shell keeps its existing inline selection logic. Earlier browser captures show the corresponding outcomes in a synthetic session fixture using the production tab bar, conversation stream, and PR conflict view.

## Decision

In `SessionDetail`, preserve `prSessionId` as the PR data owner and pass
`activeSessionTabId` separately as `actionSessionId` to both PR-view surfaces.
This is the existing resolved selection used by the common desktop/mobile
session shell: it retains the root ID and a visible child ID, while returning
`null` for an unresolved child, draft, or empty tab. Do not use
`activeTabSession?.id`; its display fallback intentionally returns the root
metadata when a child is unresolved. `PrTabContainer` reads the conflict action
only from the execution target, so missing selection remains unavailable.
The selection stays inline in its existing owner; extracting a helper solely
to feed the container tests adds no product behavior.

## Evidence and limits

The existing `session-chat-interface.tsx` publishes the action under its own
`session.id`, while `getSessionGitHubState` resolves `sourceSessionId` to the
workspace owner. Those are different identities for a child tab.
`pr-tab-container.test.tsx` renders the real container with explicit child,
root, or null action targets. It checks the selected dispatch destination,
root-owned PR queries, and the absence of a root action when no target exists;
it does not test the session shell's selection derivation. Removing the helper
leaves all 7 tests passing. Temporarily restoring the owner-based action lookup
makes the child and null-target tests fail (2 failed, 5 passed).

Local verification used Node 26.12.1 and the existing verification checkout's
Vitest 3.2.4. Its lockfile matches this branch, but the installed runner differs
from the declared Vitest 5.0.2, so this is not full locked-dependency validation.
`pnpm check` stops in unrelated `@lody/e2ee-core` typechecking on missing
dependencies. Earlier browser acceptance showed child dispatch reaching the
child and pending/draft selections exposing no root action; its screenshots
remain attached to PR #1908 because this cleanup preserves product behavior.
