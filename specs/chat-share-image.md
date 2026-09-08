# Chat image selection and preview

Status: draft
Translation: pending

A user can select messages directly in a session conversation and preview them
as a styled image card. Selection belongs to the chat surface; the preview owns
appearance. This feature operates locally and does not publish the conversation.

The selection unit is a persisted user or assistant message with prose. A folded
assistant turn remains one selectable message even when it occupies multiple
virtual rows. Mouse drag, Shift range extension, Ctrl/Command inversion, and
edge scrolling preserve chronological order. Cancelling selection restores the
composer; closing the preview retains the selection.

The card displays prose, while its approximate token count includes stored
thinking, plans, and textual tool input/output from selected messages. This is
not billed usage and cannot account for unavailable output or repeated context.
The model label comes from the last selected assistant message's recorded model,
not the current composer. Multiple-model aggregation is outside this scope.
Custom runtimes use the current session configuration's display name. The date
remains the session creation date; elapsed runtime is not displayed.

Removing the backdrop retains an opaque card in the chosen theme. PNG rendering,
clipboard image copying, and file export remain outside this preview increment.

Evidence: [selection tests](../packages/components/tests/message-selection.test.tsx),
[metadata tests](../packages/shared/tests/conversation-markdown.test.ts), and
[interactive story](../packages/components/src/stories/ChatMessageSelection.stories.tsx).
Automated screenshots were deliberately not run; this draft does not claim visual acceptance.
