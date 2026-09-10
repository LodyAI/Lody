# Replace the usage ticket card with a fixed-format usage report

Status: implemented
Translation: current

[中文](2026-09-09-usage-share-image.zh.md)

## Abstract

The previous usage share card was a hand-drawn canvas "cinema ticket": 1446 lines
of bespoke rendering with foil palettes, a VHS filter, an isometric skyline, a
WebM encoder, and its own webfont loader, shipped dark behind `SHOW_SHARE_CARD =
false`. Its failure was a product one rather than a technical one — it treated a
recurring, comparable record as a novelty object, so no two cards looked alike and
none read at feed thumbnail size. It is deleted and replaced by a fixed-format
React card that reuses the session share card's capture pipeline, theme pinning,
and backdrop presets while inverting its configuration model: the session card is
an editor with nine appearance knobs because its content has no fixed shape, and
the usage card is a generator with five because its content does. The main
unresolved limit is visual: no automated screenshot acceptance was run, so the
layout is verified by Storybook and typecheck only.

## Decision

**The period is the screen's range, not a private one.** An earlier draft gave the
dialog its own period selector (30 days / past year / all time). That would have
let the card's headline disagree with the KPI tile the user pressed Share from,
and "all time" could only have been served by numbers the 53-week calendar cannot
support. Instead the card takes the range the Usage screen is already showing, and
its hero number is that range's own timeline total. Hourly ranges count intervals
and day-denominated ranges count days across the same four headline cells — the
same split the on-screen summary already makes, now computed once in
`usage-share-stats.ts` so the page and the image cannot drift apart.

**The heatmap is always the past 53 weeks, with the range lit inside it.**
Swapping the block per range was considered and rejected: it doubled the layout
surface and destroyed the comparability that is the card's whole purpose. Lighting
the shared window inside a dimmed year is an idiom the calendar view already uses
for its 30-day window, is honest at every range, and gives short ranges a genuine
story ("this burst, in my year"). The all-time range lights everything, because
nothing in the calendar is out of scope for it.

**Privacy defaults follow the data, not the gesture.** Sharing activity does not
imply sharing spend, so USD is an explicit opt-in switch rather than a field of
the card. Member identification is a second opt-in, is offered only when the range
has more than one contributor, and carries display name and avatar only — the
timeline also holds emails, and `computeUsageShareMemberSlices` never reads them.
A test asserts no email reaches the slices.

**Density is a correctness property here, not a taste one.** The first layout
distributed its five blocks evenly over the portrait's height and left large voids
— which is what a fixed-format card degenerates into when the content is specified
before the canvas. The fix added information rather than padding: month ticks on
the heatmap (a year of texture with no time scale cannot answer "when"), a fourth
headline cell, absolute dates beside the range's name, and absolute token counts
beside each split percentage.

The brand mark went through three revisions before it stopped being a problem.
Stroking `lody.svg` into an outline put two different jellyfish on one card, since
that vector is not the product icon; there is no vector of the product icon, so CSS
cannot cut a real outline from the raster. Ghosting `lody-icon.png` at low opacity
fixed the identity but still read as a second copy of the logo sitting in a corner.
What works is treating it as a cast shadow rather than a mark: `brightness-0`
flattens the artwork to a pure silhouette (alpha survives, colour does not),
inverted on a dark card so the shadow is light instead of invisible, then scaled
well past the card and clipped by its edge so only a fragment of the bell intrudes
from the right. It is positioned on the card root and every band is positioned
above it, so it is atmosphere and can never displace a number.

**The card declares its own type and spacing scale.** Built element by element it
accumulated ten font sizes (10, 10.5, 11, 11.5, 13, 15px …) whose half-pixel steps
carry no hierarchy, and the portrait band was padded `px-7` against a `px-6`
footer, so the workspace name never lined up with the number above it. An exported
image has no hover state or tooltip to recover a hierarchy that blurred sizes lose,
and two cards a month apart must set the same words identically — so `TEXT` names
five roles and every text node picks one, `PAD_X` is the single horizontal padding
for every band including the footer, and all spacing sits on a 4px grid. Vertical
rhythm is the one permitted divergence, because only the height budget differs
between 4:5 and 16:9; it lives in one `RHYTHM` record of two rows rather than
scattered per element. Both formats are asserted to have zero content overflow.

**Two formats, no more.** Portrait 576×720 and wide 704×396 (1152×1440 / 1408×792
at the pipeline's 2x scale) cover the feed and the inline-preview destinations.
The card is exactly these pixels *including any backdrop* — which is the trap the
first sizing fell into: a framed card is 48px shorter than an unframed one, the
layout had been tuned against the unframed story, and the framed default overflowed
its footer by 23px while flex quietly ate the bottom padding instead of reporting
it. Only the headline band may flex now; every other band is `shrink-0`, so a
layout that does not fit fails visibly rather than silently compressing.

**One capture pipeline for both cards.** `lib/chat-share-image-export.ts` became
`lib/share-image-export.ts` with `copyShareImage` / `exportShareImage(element,
title, fallback)`; `components/chat-share-theme-scope.ts` became
`components/share-theme-scope.ts`. Duplicating ~100 lines of snapdom, font
readiness, and Electron bridge handling into a second module was the alternative
and was rejected. The filename fallback became a required argument so the chat
surface keeps `lody-conversation` while usage gets `lody-usage`.

The share entry sits beside the range selector in `StatsSettingsView` behind an
opt-in `shareCard` prop, and the dialog is lazy-loaded, so the public landing demo
that reuses the same view neither offers an action it cannot perform nor pulls
snapdom and qrcode into its bundle.

## Alternatives not taken

Keeping the ticket renderer behind its flag and restyling it was possible; canvas
was rejected because it re-implements theming, i18n, RTL, and text layout that the
DOM path gets from the design system, and because the exported card cannot then be
covered by Storybook.

Mobile (`MobileStatsSettings`) does not get the entry in this change. It renders
its own layout and would share through `@capacitor/share` rather than a dialog with
a save button, which is a different interaction, not a smaller one.

## Evidence and limits

[The draft specification](../../../../specs/usage-share-image.md) owns the intended
behavior. `tests/usage-share-stats.test.ts` covers window-scoped streaks and
averages, the interval/day trio switch, the all-time lighting rule, the
no-timeline fallback, slice ranking and remainder folding, and the email
exclusion, all on synthetic fixtures with fixed timestamps.
`tests/share-image-export.test.ts` (renamed with its module) continues to cover
browser download cleanup, native save cancellation and failure, and invalid
capture results; it mocks rasterization and establishes no pixel fidelity.
`UsageShareCard.stories.tsx` covers both formats, both subjects, the hourly range,
the cost opt-in, and the bare card; every state was rendered and inspected in
Storybook, and the wide layout was rebuilt after its first version overflowed its
footer. `pnpm --filter @lody/components exec tsgo
--noEmit` passes. No automated screenshot or visual acceptance was run, and the
card has not been exercised against a live workspace.
