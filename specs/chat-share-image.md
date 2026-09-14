# Chat image selection and export

Status: draft
Translation: pending

A user can select messages directly in a session conversation and preview them
as one image card, then save it as PNG. Selection belongs to the chat surface;
the preview owns the capture. This feature operates locally and does not publish
the conversation.

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

The card is a fixed template. Its bands, their order, their type scale and their
margins are the same on every card, and the only appearance choice the preview
offers is light or dark, opening on whichever the app is currently wearing.
The template exists in two forms, and the device being shared from picks one: a
phone form sized to a handset's own content width, and a desktop form wide enough
for a line of prose and a line of code. They differ in measure and margin only —
type sizes are shared, and are independent of the reader's conversation font
setting — so two cards taken from two devices set the same words at the same
size. Nothing in the product selects the form, and the backdrop is part of the
template rather than an option, so a card always has one.

Every band shares one horizontal inset, so the title, both speakers and the
caption stand on one left edge. No turn is hung from the right: a shared image
has no reader for whom the right side means "me". The human prompt is a tinted
block and the reply is ordinary prose, and vertical rhythm carries the grouping
that alignment no longer does — the gap between two exchanges is twice the gap
binding a prompt to the reply that answers it.

Provenance is one caption band at the foot of the card: the runtime that produced
the conversation, its model, the rough token estimate, and the absolute capture
date. The product sign-off prints on the backdrop below the card, where it costs
the conversation no room and cannot be mistaken for part of the transcript. The
card carries no QR code, because the code encoded the product's home page rather
than this conversation, which a legible wordmark states in a tenth of the space.

Code soft-wraps, keeps its language label legible, and draws no copy control. An
image has no horizontal scrollbar, so an unwrapped line is a line the reader
cannot see; and nothing in a picture can be pressed, so an affordance drawn into
one only invites a click that never lands. Both follow from the medium rather
than from a preference.

The card has no height limit and never elides a selected message — a long
selection simply makes a long image — because publishing a whole conversation
for reading is what a share link is for.

PNG export captures the card and its backdrop, independent of preview scrolling
or scaling. It waits for fonts and images, disables duplicate export or copy
actions, and reports failures for retry. Electron uses its native save dialog;
browsers download the file. Canceling the save dialog preserves the preview.

The preview also provides an explicit Copy image action. It captures the same PNG
as export and writes it only to the local system clipboard: Electron delegates the
PNG bytes to its native clipboard bridge, while browsers use the image Clipboard API.
Browsers without image clipboard support report a recoverable failure; a failed
copy leaves the preview open for retry. Copying does not publish the conversation
or change the saved image behavior.

The preview is a preview and not an editor: the palette switch and the two
actions are all it carries. It is a dialog on a desktop and a bottom drawer on a
handset, with the same preview, the same control and the same actions in both.

Evidence: [selection tests](../packages/components/tests/message-selection.test.tsx),
[metadata tests](../packages/shared/tests/conversation-markdown.test.ts), and
[export tests](../packages/components/tests/share-image-export.test.ts), and
[interactive story](../packages/components/src/stories/SessionConversationPage.stories.tsx),
and [card stories](../packages/components/src/stories/ChatShareCard.stories.tsx)
covering both forms in both palettes. The redesign is recorded in
[its note](../.agents/notes/implemented/feature/2026-09-14-chat-share-card-fixed-template.md).
This draft does not claim visual acceptance.
