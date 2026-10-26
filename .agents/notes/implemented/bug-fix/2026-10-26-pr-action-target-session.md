# Keep PR data ownership separate from action dispatch

Status: implemented
Translation: current
Pull request: https://github.com/LodyAI/Lody/pull/1908

[中文](2026-10-26-pr-action-target-session.zh.md)

## Abstract

The PR view used the workspace-owner session ID both to load PR data and to find the live conflict-resolution action. For a child conversation, that sent the prompt to the root conversation. `PrTabContainer` now receives a separate action target from the selected conversation while retaining the owner ID for GitHub queries and analytics. A missing target disables the action. The component suite passes for root, child, and absent targets, and ablation reproduces the child and missing-target failures. A full session UI capture remains unavailable because the required ACP extension submodules are absent from this checkout.

## Decision

In `SessionDetail`, preserve `prSessionId` as the PR data owner and pass
`activeTabSession?.id ?? null` separately as `actionSessionId` to both PR-view
surfaces. `PrTabContainer` reads the conflict action only from that target.
This keeps GitHub query ownership stable and makes a missing execution target
fail closed instead of falling back to the root.

## Evidence and limits

The existing `session-chat-interface.tsx` publishes the action under its own
`session.id`, while `getSessionGitHubState` resolves `sourceSessionId` to the
workspace owner. Those are different identities for a child tab. The existing
`pr-tab-container.test.tsx` now asserts the selected target and retained query
owner through the rendered conflict action. With preinstalled dependencies from
the identical lockfile, that suite passed all 7 tests. Temporarily restoring the
owner-keyed action lookup made the child-target and missing-target tests fail,
while the root-target case remained green. A full UI screenshot was unavailable:
the Storybook preview cannot resolve the absent ACP extension submodules, and the
conflict-resolution target itself appears only when the prompt is appended in a
conversation, which the PR-only story does not render.
