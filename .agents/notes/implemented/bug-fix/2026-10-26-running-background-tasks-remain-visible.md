# Running background tasks stay below the answer

Status: implemented
Translation: current
PR: [#1912](https://github.com/LodyAI/Lody/pull/1912)

[中文](2026-10-26-running-background-tasks-remain-visible.zh.md)

## Abstract

When an assistant turn answered before its background tasks settled, the finished-turn fold hid the task panel even though the panel itself is designed to stay open while work is active. The virtual-row builder now leaves the task panel after the answer whenever any task is pending or running, and returns it to the existing worked details after all tasks settle. Task identity, order, and the fold decision for other work remain unchanged. A deterministic Storybook scene and virtual-row tests cover the transition and history reconstruction.

## Decision

`buildChatVirtualRows` owns placement of the message-scoped task row. It already puts the task row in the final segment's worked details when a finished turn folds, so `SubagentTaskPanel` never mounts and cannot apply its running-state expansion rule. The builder now checks the existing `isRunning` predicate: a pending or running task moves the whole task row after the segment's visible answer and before its footer. Terminal task rows keep their former placement inside the worked details. The task row keeps its existing message-derived key and `collectSubagentTasks` ordering.

The foldability predicate remains unchanged. This preserves existing worked-group headers and keeps the fix limited to task-row placement. No new state, abstraction, or persistence behavior was added.

## Evidence and verification

At baseline `91fa467a`, the added virtual-row acceptance failed because the running-task row was absent from visible rows (`taskRowIndex === -1`). After the placement change, all eight tests in `tests/plan-turn-virtual-rows.test.ts` passed. The `FinishedAnswerWithRunningBackgroundTasks` Storybook scene uses a synthetic prompt, one running task, and one completed task; an `agent-browser` screenshot pair shows the missing panel at baseline and the panel below the answer after the fix. The history-rebuild assertion preserves the row key and task ids in first-seen order.

## Trade-offs and limits

When a row contains both running and terminal tasks, the existing panel renders the entire group below the answer until every task settles; it does not split one message-scoped panel into separate rows. Once all tasks are terminal, the group follows existing worked-detail expansion behavior. The change does not alter provider task merging or reload semantics.
