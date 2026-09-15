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
composer. Dismissing the preview retains the selection, so it can be reopened and
adjusted, but finishing the share ends the whole flow: once the image is on the
clipboard or written to disk, the preview closes and the selection goes with it.
Nothing is left armed behind a task the user has completed.

A cancelled save dialog finishes nothing. It closes neither the preview nor the
selection, because backing out of a file picker is not a share, and clearing a
selection under someone who did that would throw away work still in hand. The
export reports whether it actually saved rather than merely whether it failed,
which is what lets the two be told apart.

The card displays prose, while its approximate token count includes stored
thinking, plans, and textual tool input/output from selected messages. This is
not billed usage and cannot account for unavailable output or repeated context.
The model label comes from the last selected assistant message's recorded model,
not the current composer. Multiple-model aggregation is outside this scope.
Custom runtimes use the current session configuration's display name. The date
remains the session creation date; elapsed runtime is not displayed.

The card is a fixed template. Its bands, their order, their gutters and their
type scale are the same on every card, and the preview offers four choices, none
of which can change any of that: the card's size, how much ground shows around
it, which ground, and which palette. The palette opens on whichever appearance
the app is currently wearing.

The card's size is a content decision, because it sets the measure: how much
prose fits on a line, and whether a line of code survives without wrapping. It is
asked as where the image is going, since that is what the answer depends on and
what the person exporting actually knows. A card sent into a message thread is
read at a handset's own content width; a card posted to a feed, a README or a
slide needs room for a line of prose and a genuine line of code. Those are the
two useful answers, so it is a choice between two, not a dimension to nudge.

How much ground shows is the one continuous dimension the template does not
decide, and it is offered as a slider over pixels. This is the single place the
card asks for a measurement rather than an intent, and that is deliberate: the
usual reason to avoid exposing a number — that nobody can judge one against
another — describes a settings form, not a surface with the result rendered
beside the control. Here the person does not read the value, they drag and watch
the picture, which is a stronger answer than any name could be. Quantising it
into named steps would be the product deciding for someone who can already see
the result. The size seeds it with an ordinary value for that size, so an
untouched export is still a considered one.

Zero is reachable, because a card flush to the image's edge is what pasting into
a document wants. Below the point where the ground stops being a margin, the
sign-off moves into the caption rather than sitting on the image's own edge, and
the card's shadow goes with it — a shadow needs a ground to fall on.

The device doing the exporting decides nothing about the image. It is only the
opening guess at the size, which one tap overrides. Using it to pick that size
outright was wrong in both directions — a desktop user sending a card into a
group chat got the wide one, and a handset user posting to a feed got the narrow
one — so the question is asked instead of inferred.

The two sizes differ in measure and interior scale only. Type sizes are shared,
and are independent of the reader's conversation font setting, so a chat card and
a post card set the same words at the same size.

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
exported without a ground, or with too little of one to hold a line of type off
the edge, takes it onto the second line of the caption's left column rather than
a band of its own. Either way it inks for
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

A finished copy is announced outside the preview, because the preview is gone by
then: a save has the native dialog or the browser's own download UI behind it,
while a copy would otherwise complete in silence.

The preview also provides an explicit Copy image action. It captures the same PNG
as export and writes it only to the local system clipboard: Electron delegates the
PNG bytes to its native clipboard bridge, while browsers use the image Clipboard API.
Browsers without image clipboard support report a recoverable failure; a failed
copy leaves the preview open for retry. Copying does not publish the conversation
or change the saved image behavior.

The preview is a preview and not an editor: the palette switch, the ground
swatches, the size switch, the ground slider and the two actions are all it
carries. The controls are grouped by what they do: the card's shape first, then
its surface. The size switch stays live without a ground — it still sets the
card's width — while the slider goes inert, because there is then no ground to
size. It is a dialog on a desktop and a bottom drawer on a
handset, with the same preview, the same control and the same actions in both.

Evidence: [selection tests](../packages/components/tests/message-selection.test.tsx),
[metadata tests](../packages/shared/tests/conversation-markdown.test.ts), and
[export tests](../packages/components/tests/share-image-export.test.ts), and
[interactive story](../packages/components/src/stories/SessionConversationPage.stories.tsx),
and [card stories](../packages/components/src/stories/ChatShareCard.stories.tsx)
covering both forms in both palettes. The redesign is recorded in
[its note](../.agents/notes/implemented/feature/2026-09-14-chat-share-card-fixed-template.md).
This draft does not claim visual acceptance.
