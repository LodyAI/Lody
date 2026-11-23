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
the conversation. The card is now one template with four choices, none of which
can change its layout — the card's size, how much ground shows around it, which
ground, and which palette — issued in a chat size and a post size; every
band shares one horizontal inset, turns are left-aligned with an unequal vertical
rhythm instead of right-hung bubbles, and the preview is a preview with two
actions rather than a control panel. The card still grows without a height limit,
so a large selection still makes a very tall image; that was kept deliberately,
because eliding selected messages would make the image disagree with what the
user picked, and a whole conversation meant for reading belongs in a share link.

## Decision

The card has two sizes: `chat` is 360pt wide, `post` is 560pt. They differ in
measure and interior scale only — type sizes are shared and are pinned rather
than read from the reader's conversation font setting — so a chat card and a post
card set the same words at the same size.

Size is asked as where the image is going, because that is what the answer
depends on and what the person exporting knows. It sets the measure: how much
prose fits on a line, whether a line of code survives without wrapping. Two
answers are enough, so it is a switch rather than a dimension to nudge.

That axis started as the device: `useIsMobile()` picked the width, on the
reasoning that the device you are exporting from stands in for where the image is
going. It does not. A desktop user sending a card into a group chat got the wide
one and a handset user posting to a feed got the narrow one, and neither could
say so. The device now seeds nothing but the opening guess, which one tap
overrides, and decides nothing else about the image — only whether this surface
is a dialog or a drawer.

Both cards' dimensions live in one `LAYOUT` table rather than in the markup, so
"a post breathes more than a message" stays a single decision. One `gutter` value
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

The backdrop stayed a choice, and that is a correction: the first cut of this
change deleted all six grounds and hardcoded the signature gradient, on the
reasoning that a choice which cannot make the card better is only noise. That
reasoning was wrong about one of them. `welcome` is a hand-built export-safe still
of the opening ceremony's shallow-water field — the live scene is a WebGL shader
that a DOM capture cannot serialize — and it lives nowhere else in the product, so
deleting it destroyed an asset rather than removing an option. It is also the only
light ground, which the sign-off now has to ink against. `aurora`, `ocean` and
`sunset` survive in the usage card either way. The distinction that holds is
between a choice that changes how a card _reads_ — footer layout, padding, which
turns are hung where — and one that only changes what it reads _against_; the
former is the editor this change removes, the latter is taste and belongs to the
user. `none` keeps its place in that set and takes the sign-off into the caption's
left column, the same fallback the usage card already documents, rather than
earning a band of its own.

The mat is a slider over pixels, and it is the one place this surface asks for a
measurement instead of an intent. Two earlier attempts were wrong about it, in
opposite directions, and both were corrected.

The first deleted the control outright and derived the mat from the card's size,
on the argument that nobody can judge 32pt against 56pt. That argument describes a
settings form. It dissolves next to a live preview: the person does not read the
value, they drag and watch the picture, which is a better answer than any name can
give. Direct manipulation is exactly the case where exposing the quantity is
right, and quantising a continuous dimension into named buckets there is the
product deciding for someone who can already see the result.

The second, in between, bound the mat to the size and claimed that "a 560pt card
in a thin bleed and a 360pt card in a deep mat are combinations nobody wants".
That was an assertion, and it was false in both halves: a wide card flush is
exactly what pasting into a README or a document wants, and a narrow card in a
deep mat is exactly what a phone post wants. The width and the mat are genuinely
independent — one is a content decision about the measure, the other a
presentation decision about the frame — so they are two controls. Size seeds the
mat with an ordinary value for that size, which is what makes them read as "pick
a starting point, then adjust" rather than as unrelated knobs.

Picking a size always re-seeds the mat, with no "has the user touched the slider"
flag behind it. A hidden bit that sometimes keeps a value and sometimes does not
is harder to predict than a preset that always resets, and the preview shows the
result immediately either way.

Zero is reachable. Below `MIN_SIGN_OFF_MAT` the ground stops being a margin, so
the sign-off moves into the caption — the same fallback a card with no ground
takes — and the card's drop shadow goes with it, because a shadow needs a ground
to fall on.

Code soft-wrapping became unconditional. An image has no horizontal scrollbar, so
an unwrapped line is a line the reader cannot see; that is a property of the
medium, not a preference. Making that true took two declarations, not one, and
the second was missed until review: a fenced `diff` renders through
`MarkdownDiffBlock`, whose `pre` sets `width: max-content` so a wide patch can
scroll inside the app. Relaxing only `min-width` left that `width` standing, and
`max-content` under `pre-wrap` is still the widest line, so a diff block kept its
full unwrapped width, pushed past the card's fixed edge and was clipped by the
card's own `overflow-hidden`. The claim "code never overflows a share card" was
therefore false for one fence type while it was being written. Stories now carry a
`diff` fence in both sizes; none did before, which is exactly why screenshots did
not catch it. The paired `collapseAfter` control went with it, and
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

`ui/slider.tsx` is new, and it is the native range input rather than a library:
the platform supplies keyboard stepping, Home/End, the ARIA role and value, and an
OS-correct touch target, so only the track and thumb are ours. Two global rules in
`tailwind/index.css` had to be worked around and are recorded in
[the primitive's rules](../../../../packages/components/src/ui/AGENTS.md) — the
"Pro focus style" outlines the whole control, and the `*:focus-visible` reset kills
`ring-*` utilities on the thumb through inherited custom properties.

The two actions take the `sm` button size in the dialog and the default size in
the drawer. `sm` is also `text-xs`, which every other control in that footer
already uses, so at the default size the buttons were the only `text-sm` thing in
it; on a handset they are the primary touch targets instead, and `h-9` is already
under the 44pt guidance without shrinking it further. Do not unify the two for
consistency — the inconsistency is the point.

Finishing the share ends the flow. The preview closes and the chat drops the
selection behind it, because leaving a surface armed behind a task the user has
completed is just state they have to clear by hand. Dismissing the preview still
retains the selection — that is the case where someone wants to go back and adjust
it — so the two are distinguished by a completion callback rather than by
`onOpenChange`, which cannot tell them apart.

That exposed a defect in `exportShareImage`: it swallowed a cancelled save dialog
and resolved exactly like a successful one, so closing on "export resolved" would
have torn the flow down under someone who had only backed out of the file picker,
against a guarantee the Spec already made. It now returns `{ saved }`. A browser
download has no cancel signal to read and always reports a save, which is honest —
the browser owns the transfer from the click onward.

The completion callback carries which action finished, because the two leave
different feedback behind. A save has the native dialog or the browser's download
UI; a copy has nothing once the preview is gone, so the host toasts for it and
only for it.

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
thread and one pasted into a post are read at different widths. Deriving which of
those two forms to use from the exporting device was implemented and then
corrected: it is a guess at the destination, and the destination can simply be
asked.

Naming the mat instead of measuring it — "Compact / Regular / Spacious", or
folding it into the size preset — was implemented twice and reverted twice. Both
forms are defensible on a settings screen and neither survives a live preview,
which answers "how much" better than a vocabulary can.

Fixing every ground into one — the signature gradient, chosen by the light/dark
switch — was implemented and then reverted on the requester's judgement. It would
have been the tidier rule and would have paired a light card with a light ground
automatically, but it still ends with five grounds deleted and one of them
unrecoverable, to save a control that costs one row of swatches.

## Evidence and limits

[The draft specification](../../../../specs/chat-share-image.md) owns the
intended behavior and was updated in the same change, including the stale
sentence in [the usage card spec](../../../../specs/usage-share-image.md) that
described this card as justifying a large set of appearance controls. Stories
cover both sizes in both palettes, both ends of the mat slider, every ground that
needs its own judgement — the pale one against both card palettes, a saturated one, and no
ground at all in both palettes — an untitled card, and a code block whose signature
line is far wider than either card.

Workspace typechecks, lint, the i18n key check, and the Code Collab, platform and
public-boundary guards pass. The `@lody/components` suite is 474 of 476 files
green; the two failures are `control-plane-mirror` and `conversation-view-hooks`,
both timing-sensitive, both green when re-run alone, and neither reachable from
anything this change touches. This change has no unit tests of its own and adds
none: the card is presentational, the export pipeline it feeds
is unchanged and still covered by
[export tests](../../../../packages/components/tests/share-image-export.test.ts),
and a test asserting class strings or measured jsdom geometry would not detect a
visual regression. The mat's three states were checked in a real browser instead:
at 0 the sign-off is in the caption and the card has no drop shadow, at 56 and 96
it is on the ground and the shadow is present, and exactly one sign-off exists in
every case. Verification was Storybook screenshots of the card stories and of the
dialog at desktop and handset viewports, plus live measurement in the browser of
the label clearance and the hidden copy control. No pixel baseline is
established, and the drawer form was not exercised on a real handset. Extends [the original feature note](2026-09-08-chat-share-image.md) and
its [clipboard follow-up](2026-09-08-chat-share-image-clipboard.md); neither is
superseded, since selection, metadata and the capture pipeline are unchanged.
