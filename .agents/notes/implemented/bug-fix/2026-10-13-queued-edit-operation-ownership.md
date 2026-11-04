# Preserve the next queued-message edit after an earlier acknowledgement

Status: implemented
Translation: current

PR: https://github.com/LodyAI/Lody/pull/1533

[中文](2026-10-13-queued-edit-operation-ownership.zh.md)

## Abstract

When users edited two queued messages in succession, the first save acknowledgement
could erase the second draft. The editor remained visible but returned to the
second message's original text. Each edit operation now has an identity, and only
the latest operation can update local editor or pending state. Playwright reproduced
the loss before the fix and verified retained text, focus, and both saved messages
afterward; validation used production components with synthetic data, not a built desktop.

## Cause and decision

Clicking the next row saves the current editor on blur. Production save callbacks
write the queue item before awaiting the first row's synchronization acknowledgement.
The next editor can therefore open while the earlier callback is still pending.
That callback previously cleared local editing state unconditionally, causing the
synchronized editing flag to reopen the next row with its original text.

`useMessageQueueEditing` assigns an identity to start, cancel, and save operations.
Completion may change local state only while that identity is current. Unmount
retires the identity; an obsolete start also stops before its next write. Existing
queue writes, synchronization, automatic blur-save, and error feedback remain with
their existing owners. Disabling other rows until acknowledgement would interrupt
successive edits; preserving operation ownership allows the existing flow to continue.

This complements the [editor focus decision](2026-09-12-composer-click-focus.md)
without changing its caret or footer behavior.

## Evidence and limits

- [Editing owner](../../../../packages/components/src/components/sessions/message-queue/use-message-queue-editing.ts)
  and [production callbacks](../../../../packages/components/src/components/sessions/session-chat-interface.tsx).
- [Queue component tests](../../../../packages/components/tests/message-queue-row-editing.test.tsx)
  hold acknowledgements explicitly, including completion while the next start is pending.
- [Browser regression](../../../../packages/components/tests/e2e/composer-submission-focus.spec.ts)
  uses the real queue through its
  [deferred story](../../../../packages/components/src/stories/MessageQueueDisplay.stories.tsx).
  Four focused queue browser cases passed in Chrome. Before/after screenshots are
  ignored review artifacts under `artifacts/usability/`.
- Modified source passed Oxlint. Package typecheck and desktop build were attempted
  but blocked by missing or mismatched dependencies in unmodified modules, including
  Office/PDF viewers and CLI MCP/WebRTC dependencies. Installed desktop and real daemon
  synchronization were not exercised.
