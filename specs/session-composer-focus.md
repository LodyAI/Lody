# Session composer focus

Status: draft
Translation: pending

## Interaction

When a user clicks the bottom blank space of the desktop Session composer,
the prompt receives focus and accepts typing. This space belongs inside the
visible input card. Buttons, menus, and other editable controls retain their
own interactions; a disabled prompt does not receive focus.

Mobile bottom spacing and the native safe-area/keyboard offset remain intact.

Clicking Edit on a sent message focuses its inline editor with the caret at
the end. Clicking Edit on a queued message focuses that row's editor with the
caret at the end once it becomes editable, including when the synchronized
editing flag appears before the start-edit operation completes. Ordinary text
changes do not refocus the editor. Clicking the queued editor's footer blank
space focuses the field, moves the caret to the end of the entire text, and
scrolls the last line into view while keeping editing active. Confirm and clicks
outside the editor still finish editing.

## Evidence

- [Composer and editor decision](../.agents/notes/implemented/bug-fix/2026-09-12-composer-click-focus.md)
- [Browser interaction coverage](../packages/components/tests/e2e/composer-submission-focus.spec.ts)
- [Queue editing lifecycle coverage](../packages/components/tests/message-queue-row-editing.test.tsx)
