# Usage card image export

Status: draft
Translation: pending

From the workspace Usage screen a user can turn the range they are looking at
into one shareable image. This feature operates locally and publishes nothing:
the card is rendered from data the screen already holds and leaves only as a PNG
the user saves or copies.

The card is a fixed-format report, not an editor. Its blocks, their order, and
their proportions are the same on every card, so two cards taken a month apart
can be laid side by side and read against each other. The user chooses the frame
— portrait or wide, a backdrop, a pinned or app-following palette — and two
content questions; nothing else about the layout is adjustable. This is the
deliberate difference from [chat image selection and export](chat-share-image.md),
where content of unpredictable shape justifies a large set of appearance controls.

The period the card describes is the range selected on the Usage screen, and the
headline total is that range's own total, so the card cannot disagree with the
tile the user pressed Share from. The card names that period twice: once as the
range's own words, and once as the absolute dates it covers, because a shared
image outlives the day it was taken and "last 30 days" alone does not survive it.

Four headline cells carry the same four facts at every range — how often, how
consistently, how much on a typical unit, how much at the best one. Hourly ranges
count active intervals; day-denominated ranges count active days, and their
average is taken over elapsed days including quiet ones.

The card's graphic follows the range, in the same three visual languages the Usage
screen speaks: an hour skyline for the last 24 hours, a day-by-hour dot grid for
the last 7 days, and the 53-week calendar for the longer windows. A range that has
no hour-granular series falls back to the calendar, which is the one series always
present. Every graphic occupies the same fixed box, so the card's height never
depends on which range it describes.

The calendar carries month ticks so a burst can be placed in time rather than only
seen, lights the shared range's window and lets the surrounding year recede. The
all-time range lights the whole calendar, because no part of it is out of scope.
The hourly graphics carry an hour axis. The week's rows run oldest to newest and
carry no per-day label: seven days of hours touch eight calendar days whenever the
window does not begin at midnight, and eight rows inside the shared box leave no
room for a legible one. The headline already names the span.

The card is denominated end to end in one measure, tokens or USD: the headline,
the four cells, the graphic's shading and the split all read the same unit, so no
band can disagree with another and a reader never has to work out which number is
the subject. Tokens are the default, because a workspace's spend is not implied by
a request to share activity; naming cost as the measure is a deliberate act, and it
substitutes for tokens rather than joining them. A deployment that reports no
per-model cost simply has no split block on a cost card, the same as any range
without recorded usage.

Money is stated compactly above a thousand and exactly below it. A fixed layout
budgets a fixed width for its headline, and a figure written out in full grows
without bound; below a thousand the cents are the point and the string is short
anyway. The card names the workspace and, by default, no one else. The
member mode is an explicit choice, is offered only when the range has more than
one contributor, and identifies members by display name and avatar; an email is
never drawn onto the image.

The model split ranks the range's models largest first and folds everything past
the fourth into one remainder slice, so the legend has the same height at every
range. Each row carries both its absolute tokens and its share: a percentage
alone hides scale, and half of a quiet week is not half of a heavy month. A range
without recorded usage simply has no split block.

The headline number owns its band alone. The space beside and around it is left
empty on purpose: everything the card has to say is already said by the bands below
it, and the alternatives — a brand watermark, a second chart — either repeat what is
there or stand in for content that does not exist.

The sign-off can sit inside the card or on the backdrop beneath it. On the
backdrop it costs the card nothing — the in-card band goes away and those pixels
were empty frame — so the data gains room; it needs a backdrop to print on, and a
card without one keeps the sign-off inside. Either way it names the workspace it
belongs to, where it came from, and carries a code that opens it.

The in-card footer is a sign-off rather than a status bar: It borrows the session card's
identity-and-sub structure without that card's parameter line, which would only
repeat numbers the bands above already carry. The wide format keeps the same
content on one row, having no height to spare.

A chosen backdrop is part of the image, not a border added around it, so a framed
card has less room for its content than an unframed one. The layout is sized for
the framed case, and only the headline band absorbs spare height; every other band
keeps its natural size so a card that cannot fit says so rather than compressing.

Export and copy reuse the session card's pipeline: both wait for fonts and
images, disable duplicate actions while running, and report a failure that
leaves the preview open for retry. Electron uses its native save dialog and
clipboard bridge; browsers download the file and use the image Clipboard API.
Cancelling the save dialog preserves the preview.

Evidence: [share statistics tests](../packages/components/tests/usage-share-stats.test.ts),
[export tests](../packages/components/tests/share-image-export.test.ts), and
[card stories](../packages/components/src/stories/UsageShareCard.stories.tsx).
Automated screenshots were deliberately not run; this draft does not claim visual
acceptance.
