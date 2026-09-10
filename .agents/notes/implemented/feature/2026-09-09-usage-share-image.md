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

**The graphic follows the range — a reversal.** The first decision here was that
the heatmap is always the past 53 weeks with the range lit inside it, on the
grounds that swapping the block per range doubles the layout surface and destroys
comparability. That reasoning still holds for the day-denominated ranges, and they
keep the lit-window calendar. It did not survive contact with the short ranges: a
24h card drew a year with **one cell lit**, which is not a comparable record, it is
a wasted band.

The Usage screen already speaks three visual languages — an hour skyline for 24h, a
day-by-hour dot grid for 7d, the calendar for the longer windows — so the card now
makes the same split rather than inventing a fourth. Comparability is preserved
where it means something: two 30-day cards still line up, and two 24h cards still
line up, because a card is only ever compared against the same range. The layout
surface is contained by giving the graphic one fixed box (`GRAPHIC_H`) that every
kind fits, so the card's height does not depend on its range.

That box also settled the week grid's labels. Seven days of hour buckets touch
eight calendar days whenever the window does not start at midnight, so a per-row
label has to disambiguate the repeated weekday — but eight rows in a 58px box leave
7px each, which holds no size on the card's own type scale. The first attempt
reached for an off-scale 8px and produced exactly the squeezed left column the
scale exists to prevent. The rows now carry no label at all: they run oldest to
newest, the grid shares the same left edge as every other band, and the headline
already names the span.

**Privacy defaults follow the data, not the gesture.** Sharing activity does not
imply sharing spend, so tokens are the default and naming cost as the measure is a
deliberate act. Cost began as a switch that appended a USD figure beside the token
headline; making it the card's *measure* instead is both better product and a
tighter default, because the two units now substitute rather than accumulate — a
cost card cannot leak a token count alongside the spend. Everything follows the
choice: headline, cells, the heatmap's own intensity scale, and both splits, all
derived once with the metric threaded through `usage-share-stats.ts`. Member identification is a second opt-in, is offered only when the range
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

**The space beside the headline stays empty.** Six attempts went into filling it.
Five were the brand mark: an outline stroked from `lody.svg` (a different jellyfish
than the product icon, so one card carried two), a low-opacity ghost of
`lody-icon.png` (read as a second logo parked in a corner), a full-height silhouette
(a shadow behind the heatmap and the legend, the densest bands), a top-cropped one
(the bell sliced flat into a smudge under the range chip), and a right-bleeding one
that finally looked deliberate but was still decoration. The sixth put the range's
own bucket profile there, which was at least content — and it was still one graphic
too many next to a card that already carries a year heatmap and a model split.

The conclusion is the record here: that space is empty by choice. Whitespace beside
a headline is a normal thing for a poster to have, and every attempt to fill it
either repeated a band below or invented something to occupy the reader.

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

**The footer is a sign-off, and it was measurably thinner than it looked.** Read
against the session card it seemed to be missing things; measured against it, the
usage footer was already identical to that card's `row` variant — 57px, a 33px
mark — and carried one field more, the workspace name. What it was being compared
to was the `stacked` variant at 154px, which a 720px card cannot spend 21% of its
height on and a 396px one cannot fit at all. So the portrait footer takes the
middle: the session card's identity-plus-sub structure (workspace, then `lody.ai`
under it) with a full-size code, 73px, paid for out of the headline band's slack
rather than out of any information band. It deliberately omits that card's EXIF
parameter line, which here would only repeat the bands above. The wide format
keeps the single row.

The session card's `canvas` footer turned out to be worth taking as well, and it is
the only placement that *gives* the card height rather than taking it: the in-card
band disappears and the sign-off prints on backdrop pixels that were empty frame.
It is a sixth knob on a card whose whole argument is few knobs, which is affordable
because it is a placement rather than a style, and because it degrades honestly —
with no backdrop there is nothing to print on, so it falls back to the in-card
footer exactly as the session card does. The other variants were measured and left:
`stacked` does not fit, `row` is what the wide format already is, `minimal` drops
the workspace name and the code, and `exif` would repeat the bands above.

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
