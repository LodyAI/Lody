# The conversation share card becomes one fixed template

Status: implemented
Translation: current

[中文](2026-09-14-chat-share-card-fixed-template.zh.md)

## Abstract

The conversation share card shipped as an appearance editor: six backdrops, five
footer layouts, three frame paddings, a three-way palette, four toggles and a
numeric code-collapse field, roughly a thousand reachable combinations of which
only a few produced an image worth sending. The controls also hid two defects —
the default footer printed the agent's name with no Lody mark anywhere on the
image, and the default QR code always encoded the product home page rather than
the conversation. The card is now one template with a single light/dark switch,
issued in a phone form and a desktop form that the sharing device selects; every
band shares one horizontal inset, turns are left-aligned with an unequal vertical
rhythm instead of right-hung bubbles, and the preview is a preview with two
actions rather than a control panel. The card still grows without a height limit,
so a large selection still makes a very tall image; that was kept deliberately,
because eliding selected messages would make the image disagree with what the
user picked, and a whole conversation meant for reading belongs in a share link.

## Decision

The template's only variable is the device. `phone` is 360pt wide inside a 16pt
backdrop; `desktop` is 560pt inside 32pt. They differ in measure and margin only
— type sizes are shared and are pinned rather than read from the reader's
conversation font setting — so two cards taken from two devices set the same
words at the same size. `ChatShareImageDialog` derives the form from
`useIsMobile()` and exposes no control for it; `formatOverride` exists for
stories alone.

Both cards' padding lives in one `LAYOUT` table rather than in the markup, so
"the desktop card breathes more" stays a single decision. One `gutter` value
serves the title band, the conversation and the caption, which is what the
previous card could not do: it mixed `px-5` and `px-6` between bands and hung
user turns from the right edge, so nothing in the card shared a left edge. Turns
are now left-aligned — a shared image has no reader for whom the right side means
"me" — with the human prompt as a tinted block and the reply as ordinary prose.
The grouping that alignment used to carry moved into the vertical rhythm: the gap
between two exchanges is twice the gap binding a prompt to its reply. That is
what lets the card work without speaker labels.

Provenance stays in the camera-caption band the previous design had already got
right — runtime, model, token estimate, absolute date — and the Lody sign-off
moved out of the card onto the backdrop beneath it, where it takes no room from
the conversation and cannot be read as part of the transcript. That also resolves
the missing-brand defect without spending card height on a second mark.

The QR code was removed rather than fixed. No caller ever passed `shareUrl`, so
every exported card encoded `https://lody.ai`; a legible `lody.ai` wordmark
states the same thing in a tenth of the area. Removing it also removed the
asynchronous asset it introduced — export no longer needs an `assetsReady` gate,
because the remaining assets are fonts and one bundled image, which the capture
pipeline already awaits.

Code soft-wrapping became unconditional. An image has no horizontal scrollbar, so
an unwrapped line is a line the reader cannot see; that is a property of the
medium, not a preference. The paired `collapseAfter` control went with it, and
with it a `MutationObserver` that rewrote Shiki's code DOM after every render to
clip over-tall blocks and inject a "+N lines" pill — a mechanism that fought the
renderer for ownership of nodes it did not own.

Unconditional wrapping exposed three things the option matrix had been hiding,
all found by screenshotting the stories rather than by reading the diff. The
floating language label is an opaque mask parked over a code block's top-right
corner, which works in the app because a long first line scrolls out from under
it; a wrapped line never scrolls, so it stayed masked. Moving that clearance onto
the `pre` rather than the block body is not a style preference: the app's code
rules live in `@layer components`, and an important declaration inside a layer
outranks an unlayered one, so the body's important `padding-block` cannot be
overridden from a component-local `<style>` at all — its ordinary declarations
can. The block's copy control was also rendering at full opacity in the preview
and would have been captured into the image, so the card hides it. Last, the
preview pane took its height from a percentage that does not resolve against a
flex item, which left its scroller unbounded and let a tall card paint straight
over the action row; it now takes `flex-1` and `min-h-0` instead.

The preview surface follows: one palette switch, `Copy image` and `Export PNG`.
It opens on whatever appearance the app is currently wearing, reset in a
render-phase branch rather than an effect so a reopened dialog never paints the
previous run's palette or result banner for a frame. On a handset the same
preview and actions render in a bottom drawer instead of a dialog, which is the
only place the two ends differ in chrome.

Twenty-one locale keys for the removed controls were deleted from both
translations. `chatShareCard.qrAlt` stays: the usage card still draws a QR.

## Alternatives

Capping the card's height with a fade and an "N more messages" line was
considered and rejected by the requester: an image that silently drops selected
messages states something other than what the user selected, and the product
already publishes whole conversations as static share links. A single card size
with the surrounding UI adapting per device was also considered and rejected in
favour of two image forms, on the grounds that a card pasted into a phone chat
thread and one pasted into a post are read at different widths.

## Evidence and limits

[The draft specification](../../../../specs/chat-share-image.md) owns the
intended behavior and was updated in the same change, including the stale
sentence in [the usage card spec](../../../../specs/usage-share-image.md) that
described this card as justifying a large set of appearance controls. Stories
cover both forms in both palettes, an untitled card, and a code block whose
signature line is far wider than either card.

Workspace typechecks, lint, the i18n key check, and the Code Collab, platform and
public-boundary guards pass. The `@lody/components` suite is 474 of 476 files
green; the two failures are `control-plane-mirror` and `conversation-view-hooks`,
both timing-sensitive, both green when re-run alone, and neither reachable from
anything this change touches. This change has no unit tests of its own and adds
none: the card is presentational, the export pipeline it feeds
is unchanged and still covered by
[export tests](../../../../packages/components/tests/share-image-export.test.ts),
and a test asserting class strings or measured jsdom geometry would not detect a
visual regression. Verification was Storybook screenshots of the card stories and of the
dialog at desktop and handset viewports, plus live measurement in the browser of
the label clearance and the hidden copy control. No pixel baseline is
established, and the drawer form was not exercised on a real handset. Extends [the original feature note](2026-09-08-chat-share-image.md) and
its [clipboard follow-up](2026-09-08-chat-share-image-clipboard.md); neither is
superseded, since selection, metadata and the capture pipeline are unchanged.
