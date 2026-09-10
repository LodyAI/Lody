# Conversation context copy

Status: draft
Translation: pending

## Scenario

A user wants to continue a conversation with a different Agent, model, machine,
or workspace, including when the source ACP provider cannot fork. Copying a
readable history prefix provides a manual handoff without transferring provider
session state or project files.

## Copy boundary

Every user and assistant message exposes a fork menu with Copy context as Markdown.
Native fork destinations retain their capability and completion restrictions;
copying is independent of those restrictions. Copy includes the selected message
and all preceding history, never subsequent messages. The session menu copies all
history. A missing selected message fails visibly rather than expanding the range.
A generating response is copied as a point-in-time partial response and marked so.

User and assistant prose remain complete. Existing Markdown export budgets may
reduce tool details, with an explicit notice. Attachment names and image counts
are included with a notice that their bytes are not copied. No file migration,
provider state transfer, or automatic target-session creation is implied.

## Interaction

Desktop user-message fork buttons follow the neighboring copy/pin controls: reveal
on message hover or keyboard focus, and stay visible while their menu is open.
Touch layouts retain visible actions. Assistant fork buttons leave space before
the timestamp. Sender names inherit the timestamp color.

Pasting and submission retain their existing behavior. Automatic text-file
conversion, editable text attachments and send-time upload feedback are excluded.

## Acceptance

- Copy includes the selected message and excludes later history.
- Unsupported native-fork providers and streaming replies can still copy context.
- Streaming copies carry an incomplete-response marker.
- Native fork destinations retain their existing capability/completion gates.
