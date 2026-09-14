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
margins are the same on every card, and the preview offers exactly three choices,
none of which can change that: where the image is going, the ground it is printed
on, and the palette it is printed in. The palette opens on whichever appearance
the app is currently wearing.

Where the image is going is the card's whole shape — its width and its mat
together, because they answer the same question. A card sent into a message
thread is read inside a conversation the reader is already looking at, so it is
sized to a handset's own content width and matted in a thin bleed; the mat there
is mostly wasted height. A card posted to a feed, a README or a slide stands
alone, so it is wide enough for a line of prose and a genuine line of code, and
its ground has to hold it off whatever is behind it. The two mats are
deliberately not the same fraction of their card: a message wants the least
wasted height that still reads as a card, a post wants presentation.

The device doing the exporting decides nothing about the image. It is only the
opening guess at the destination, which one tap overrides. Using it to pick the
card's shape was wrong in both directions — a desktop user sending a card into a
group chat got the wide one, and a handset user posting to a feed got the narrow
one — so the destination is asked directly instead. Asking it as a destination
rather than as a measurement is the point: the person exporting knows where the
image is going and cannot judge one width or one margin against another.

The two forms differ in measure and margin only. Type sizes are shared, and are
independent of the reader's conversation font setting, so a chat card and a post
card set the same words at the same size.

A chosen ground is part of the exported image rather than a border added around
it, the same as on the usage card. The set is the product's own — its signature
deep-sea night, the opening ceremony's shallow-water field, and three plain
gradients — plus the option of no ground at all, which exports the card on its own
corners. The ground is a choice because it cannot make the card read differently,
only make it read against something different; it is the one place where a shared
image is allowed to be a matter of taste. Removing it entirely was tried and
rejected: the shallow-water ground is a hand-built still of a scene a DOM capture
cannot serialize, and it exists nowhere else in the product.

Every band shares one horizontal inset, so the title, both speakers and the
caption stand on one left edge. No turn is hung from the right: a shared image
has no reader for whom the right side means "me". The human prompt is a tinted
block and the reply is ordinary prose, and vertical rhythm carries the grouping
that alignment no longer does — the gap between two exchanges is twice the gap
binding a prompt to the reply that answers it.

Provenance is one caption band at the foot of the card: the runtime that produced
the conversation, its model, the rough token estimate, and the absolute capture
date. The product sign-off prints on the ground below the card, where it costs the
conversation no room and cannot be mistaken for part of the transcript; a card
exported without a ground has nowhere to print it, so it takes the second line of
the caption's left column rather than a band of its own. Either way it inks for
the ground it sits on. The card carries no QR code, because the code encoded the
product's home page rather than this conversation, which a legible wordmark states
in a tenth of the space.

Code soft-wraps, keeps its language label legible, and draws no copy control. An
image has no horizontal scrollbar, so an unwrapped line is a line the reader
cannot see; and nothing in a picture can be pressed, so an affordance drawn into
one only invites a click that never lands. Both follow from the medium rather
than from a preference.

The card has no height limit and never elides a selected message — a long
selection simply makes a long image — because publishing a whole conversation
for reading is what a share link is for.

PNG export captures the card and its ground, independent of preview scrolling
or scaling. It waits for fonts and images, disables duplicate export or copy
actions, and reports failures for retry. Electron uses its native save dialog;
browsers download the file. Canceling the save dialog preserves the preview.

The preview also provides an explicit Copy image action. It captures the same PNG
as export and writes it only to the local system clipboard: Electron delegates the
PNG bytes to its native clipboard bridge, while browsers use the image Clipboard API.
Browsers without image clipboard support report a recoverable failure; a failed
copy leaves the preview open for retry. Copying does not publish the conversation
or change the saved image behavior.

The preview is a preview and not an editor: the palette switch, the ground
swatches, the destination switch and the two actions are all it carries. The
destination stays live without a ground: it still sets the card's width. It is a dialog on a desktop and a bottom drawer on a
handset, with the same preview, the same control and the same actions in both.

Evidence: [selection tests](../packages/components/tests/message-selection.test.tsx),
[metadata tests](../packages/shared/tests/conversation-markdown.test.ts), and
[export tests](../packages/components/tests/share-image-export.test.ts), and
[interactive story](../packages/components/src/stories/SessionConversationPage.stories.tsx),
and [card stories](../packages/components/src/stories/ChatShareCard.stories.tsx)
covering both forms in both palettes. The redesign is recorded in
[its note](../.agents/notes/implemented/feature/2026-09-14-chat-share-card-fixed-template.md).
This draft does not claim visual acceptance.
