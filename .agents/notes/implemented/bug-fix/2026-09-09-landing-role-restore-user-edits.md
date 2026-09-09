# Preserve manual run config during pending Role restoration

Status: implemented
Translation: pending

## Abstract

While a saved Role waits for capability data, a user can already change the landing composer's
model, mode, or config options. Those edits previously left restoration pending, so later capability
arrival applied the saved Role and replaced the user's choices, including permission settings.
The selection hook now reports explicit edits synchronously, and Chat Landing uses that boundary
to finish its pending restore. Capability updates without a user edit still restore the saved Role.

## Decision

`useAcpSessionConfigSelectionState` accepts an optional `onUserChange` callback for its four explicit
edit methods. Chat Landing connects it to `settleAgentRoleRestore`, covering desktop and mobile
menus and keyboard shortcuts through their existing setters. Other consumers omit the callback
and retain their current behavior. Applying a recent run config invokes the same setters after its
user-selection entry already settled restoration; settling again is idempotent.

The event boundary is deliberate: deriving cancellation from a persistent `hasUserEdits` flag could
mistake edits retained across workspace changes for a new user action. Automatic capability and
preference reconciliation must not cancel a pending restore. The existing
[Role selection contract](../../../../packages/components/src/AGENTS.md#acp-selectors) is unchanged.

## Evidence and limits

The regression extends the existing restoration harness with the real selection hook. It changes
model, mode, and effort while availability is unknown, then explicitly supplies available
capabilities and checks both retained values and cleared stored Role identity. All three cases
failed against the old hook with the saved Role's values replacing the edits. The existing
no-edit restoration case remains the control. This is deterministic hook integration coverage,
not a full desktop or Windows runtime test.

The finding belongs to [PR #344](https://github.com/LodyAI/Lody/pull/344#discussion_r3963993909);
[PR #345](https://github.com/LodyAI/Lody/pull/345) carries the same landing behavior.
