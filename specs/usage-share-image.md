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

The heatmap is always the past 53 weeks and is labelled as such, with month ticks
so a burst can be placed in time rather than only seen. The shared range's window
is lit inside it and the surrounding year recedes. The all-time range lights the
whole calendar, because no part of it is out of scope.

The card is always token-denominated; the screen's tokens/cost toggle is a
reading aid and does not travel into the image. USD spend appears only when the
user turns it on, because a workspace's spend is not implied by a request to
share activity. The card names the workspace and, by default, no one else. The
member mode is an explicit choice, is offered only when the range has more than
one contributor, and identifies members by display name and avatar; an email is
never drawn onto the image.

The model split ranks the range's models largest first and folds everything past
the fourth into one remainder slice, so the legend has the same height at every
range. Each row carries both its absolute tokens and its share: a percentage
alone hides scale, and half of a quiet week is not half of a heavy month. A range
without recorded usage simply has no split block.

The portrait format's headline number leaves a void beside it, and the brand mark
fills exactly that corner: the same mark the brand row and footer carry, flattened
to a monochrome silhouette, oversized and bleeding off the right edge alone so the
mark stays whole and the crop reads as deliberate. It clears the brand row above it
and the rule below it, because the bands below are dense and do not want a shadow
behind them. The wide format has no such void and therefore no mark. It is
atmosphere rather than a second logo, and decoration with a fixed place — never a
layout participant, so it can neither displace a number nor change where anything
sits.

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
