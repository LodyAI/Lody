# Ignore unread output from closed conversations

Status: implemented
Translation: current

[中文](2026-09-21-closed-conversation-unread.zh.md)

## Abstract

Closed conversations still showed unread dots and contributed to unread summaries.
Unread presentation now derives from the existing close/archive flags before comparing
message and read timestamps. No read receipt or additional state is written, so existing
closed conversations and subsequent background output stay quiet. Reopening restores
normal unread comparison; working and permission indicators remain visible.

## Decision and evidence

This extends [shared tab closure](../feature/2026-09-16-shared-tab-closure.md) and its
[draft Spec](../../../../specs/session-tab-closure.md). Marking read once on close would
not suppress later output or fix previously closed tabs. `sessionHasUnreadMessages`
owns the rule for tabs, closed lists, sidebar/task summaries, project counts and window
badges. Open children still contribute unread when their parent conversation is closed.

Regression cases cover close/reopen, later output, parent aggregation, permission
status, and the rendered closed list. The focused Vitest suite and components typecheck
could not start because this worktree has no dependencies (`vitest` and `tsgo` missing).
An isolated Vitest 3.2.4 run passed all nine read-receipt tests; direct Node assertions
also validate the production helper. Formatting and `git diff --check` passed. Documentation checking
reports existing links into absent ACP submodules; native visual validation remains undone.

## Closed-list unread marker

Suppressing everything left new output in a closed tab undiscoverable. The closed-list
trigger in the top bar now carries a small unread dot whenever a listed conversation
has output newer than its `lastReadAt`, and that row shows the unread dot in place of
its agent icon. `closedSessionHasUnreadMessages` applies the same timestamp comparison
only to closed/archived conversations; `sessionHasUnreadMessages` keeps suppressing
them everywhere else, including the desktop sidebar and the mobile session list. A never-read closed conversation with messages counts as unread,
matching open tabs. Covered by the read-receipt and tab-bar suites and the
`Unread output in a closed tab` story, checked in Storybook in both themes.
