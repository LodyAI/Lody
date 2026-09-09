# Identify senders in shared conversations

Status: implemented
Translation: pending

## Abstract

Shared conversations could render messages from several people while showing only
a small avatar, leaving the sender ambiguous. In multi-member workspaces,
user-message metadata now displays the resolved sender name to the right of its
timestamp, and desktop users can open a compact contact card from the avatar. Solo
workspaces retain the previous row. The card reuses the existing identity data and
avatar renderer, while mobile keeps the avatar non-interactive to avoid adding a
small popover interaction to the phone layout.

## Decision

The production session interface enables both identity affordances only when the
active workspace has multiple members. The user-message row also requires that
explicit gate, in addition to the sender resolved from each history entry's
`userId`. A name is rendered only when resolution supplies one; solo workspaces and
unresolved entries retain the previous avatar and timestamp behavior rather than
inventing an identity. The metadata row keeps its existing reversed layout, so
placing the name first makes it the rightmost item beside the avatar and puts the
timestamp immediately to its left.

On desktop, a sender with a resolved name or email gets a real button around the
avatar. Its popover opens to the left and shows the existing avatar at a larger size,
the sender name, and the email when available. The trigger supports keyboard focus
and activation. Mobile deliberately continues to render a plain avatar because this
request covers the desktop interaction and the narrow row does not need another
popover target.

## Evidence and limits

`user-message-sender-identity.test.tsx` verifies the multi-member metadata order,
the click-opened name/email card, and the absence of both affordances when the gate
is disabled. `SessionConversationPage.stories.tsx` adds a synthetic conversation
with two named senders and a second story whose play function opens Maya Chen's card.
The component package typecheck passes, and both stories were rendered in Chromium
at a 1400 by 900 viewport. The fixtures use avatar initials, so image loading is not
part of this verification; the card delegates real images to the existing
`UserAvatar` path.
