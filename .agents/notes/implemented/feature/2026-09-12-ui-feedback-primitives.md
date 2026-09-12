# UI feedback primitives: what the system says back

Status: implemented
Translation: pending

## Abstract

`@lody/ui` had nothing for the parts that report: an inline message, a toast, a
progress bar, a skeleton and a spinner were still Radix-era files reaching for
colours the package did not have — `text-status-warning` and `bg-primary/20`
against a palette with no success, no warning, and a rule that `accent` is for
live state only. This note records why those five are one `feedback` family; why
the palette gains exactly two semantic colours, taken from the values the
product already ships; why a tone is a tint and a mark and never a fill, and why
the tint is mixed per rung in a style rather than frozen into six tokens; and
why the toast is built here but migrated nowhere — 61 files and 267 call sites
reach for `sonner`, and two toasters alive at once would stack messages in two
places. Alert, Progress, Skeleton and Spinner are migrated across seventeen
surfaces and their four Radix files deleted.

## Problem

Five files, five vocabularies, and three of them reaching outside the token
rules.

`alert.tsx` was a `cva` with `rounded-lg border px-4 py-3` — a border in a
system whose first rule is that no border token exists — and a `destructive`
variant that coloured the whole message red while leaving its surface the card.
`progress.tsx` was `bg-primary/20` with a `bg-primary` child, which no rule in
this system names: `accent` is for live state, and an alpha of the *primary*
colour is neither. `skeleton.tsx` was `animate-pulse bg-primary/10`, where the
rules explicitly say a skeleton is one of the few things that takes a gray.
`loading.tsx` was a lucide spinner in a centring box, which is two decisions —
the mark, and where it goes — welded into one component. `sonner.tsx` was 100
lines of `!important` overrides fighting a third-party toast's own layout.

The product had also grown its own status palette in Tailwind —
`--status-success`, `--status-warning` — which `@lody/ui` could not see. So a
warning in a settings page and a warning in a primitive were two different
oranges by construction.

## Decision

**Five components, one group.** `feedback` covers all of them because what the
system says back has two halves of one sentence — what happened, and that it is
not finished — and the halves share more than they look: the tone that marks a
message is the tone a bar takes when it reports a quota nearly spent, and the
type of a toast's title is the type of an alert's. One group is the same call
`field` makes over a checkbox and a select trigger.

**The palette gains `success` and `warning`, and nothing else.** Their values
are the product's own `--status-success` and `--status-warning` in both
palettes, so a message in a primitive and a status line in a settings page are
finally the same colour. They are named as outcomes rather than actions:
`destructive` stays the colour of an action that destroys *and* of an outcome
that failed, which is why there is no third "danger" colour.

**A tone is a tint and a mark, never a fill.** A filled panel would leave the
elevation ladder and claim the attention a modal is for. The tint is 8% of the
tone mixed into the rung's own background — the mix `popup.destructiveHighlight`
already uses to say "this row is dangerous" — and it is mixed in
`feedback/surface.ts` rather than frozen into tokens, because it is a mix *of a
surface* and the two surfaces are on different rungs. Six tint tokens would have
had to pick one base, and whichever they picked, the other rung would stop
looking like itself.

**The neutral tone tints too, and that was not the first answer.** It began with
no tint at all, on the argument that the card rung is already a surface. Opening
the board showed why that is wrong: in the light palette `elevatedBackground`
and `background` are the same white, so a neutral alert inside a card was a
shadow and nothing else. It now takes 4% of `label` — the derivation a popup's
highlight already uses when a named fill collapses into its surface. A toast
needs none: nothing else is ever on the floating rung beside it.

**The mark belongs to the tone.** There is no `icon` prop. The point of a tone
is that a person knows what kind of message this is before reading a word of it,
and a caller free to choose a glyph can put a tick on a failure. The warning is
deliberately the one mark that is not a circle: a triangle is what separates it
from an error for a person who does not see the two colours apart.

**The role follows the tone.** `alert` for a failure or a warning, which
interrupts what a screen reader is saying; `status` for the rest, which waits
its turn. It is not a prop, because a surface that had to choose would choose
`alert` every time, and that is the version that teaches people to ignore it.

**A toast is the same message on the floating rung.** Not the modal rung: a
toast does not have to be answered, so nothing behind it recedes and nothing
about it holds the keyboard. `Toast.Provider` renders its own viewport, so a
surface wraps its app once instead of keeping a provider, a portal, a viewport
and a list in step — the same call `Select.Content` and `Menu.Content` already
make. The tone travels as Base UI's `type`, which is the field it already
carries from the call that reported to the toast that shows it.

Two things about the toast are corrections to a first draft. Its arrival was
written as a keyframe animation on the `starting` status, which cannot work:
that status lasts one frame, and an animation whose class is removed after a
frame is cancelled. It is a transition between two declared ends now, the way
the popover's rise and the accordion's reveal are. And the viewport's accessible
name was Base UI's English "Notifications", which a translated product cannot
use; it takes the product's word through `label`.

**A bar is `accent`, and a bar with no value is a different report.** The rules
give `accent` to live state and name the running indicator by name; ink there
would say the value is stored, which is the opposite of a bar in motion. A
value of `null` is not a bar at zero — "I do not know how far" and "nothing has
happened" are different things to tell someone — so it becomes the same track
with a band crossing it. The band's sweep ends at 250% of its own width, which
is where its leading edge reaches the end of the track; the first draft used
350% and the bar spent a quarter of every cycle off the track, reading as
stopped.

`Progress` also takes a tone, because two of the three migrated callers needed
one: a quota nearly spent is the warning an Alert would carry, and a usage meter
is not live state at all and gives the accent back. Without it neither caller
could migrate without reconstructing the bar's colours in Tailwind, which is
exactly what the package forbids.

**A skeleton takes its room as props.** `width` and `height` resolve to inline
values through a dynamic style, which nothing has to win a specificity fight
against — and there is a fight to lose: the line shape sets a default height,
and a caller's `h-3` would have to beat it from another stylesheet in another
layer. It is hidden from screen readers, and it stops breathing under reduced
motion, because it reports nothing its own shape does not already say.

**It is a `Spinner`, not a `Loading`.** The mark, not the state: where it goes,
whether what is behind it is dimmed and what it is waiting for are the surface's
decisions, and a component called `Loading` that centres itself in a box has
already made two of them. It is drawn in `currentColor` so the one inside a
ghost button takes the button's ink, and it keeps turning under reduced motion —
it is the only thing saying the work has not stopped, and a still spinner says
it has.

## Deliberately not done: the toast migration

`Toast` is built, on the board, and tested; nothing uses it. 61 files import
`sonner` and 267 call sites call `toast.error`, `toast.success`, `toast.info`
and `toast.warning`. That migration is a single flip — two toasters alive at
once would stack messages in two places on one screen — so it cannot be done a
file at a time, and doing it here would put the whole product behind one
unreviewable diff.

What it needs, recorded so the next change does not rediscover it: a shim that
maps `toast.error(message, { description })` onto `manager.add({ title,
description, type: 'danger' })`, a decision about `toast.promise` (Base UI has
one, with the same shape), and the deletion of `sonner.tsx`, whose 100 lines of
`!important` overrides exist to make a third-party toast lay out the way this
one does natively. The product's `toast.info` maps to the neutral tone, which is
why neutral exists as a tone at all.

## Migrated

Seventeen surfaces, and four Radix files deleted (`alert.tsx`, `progress.tsx`,
`skeleton.tsx`, `loading.tsx`) with their barrel exports.

- **Alert** — four auth and device pages. Each dropped a lucide glyph it was
  passing in beside the message, and `device-auth-page.tsx` dropped a
  hand-rolled success alert built from `border-status-success/30
  bg-status-success/[0.08] text-status-success`, which is the thing the tone now
  is.
- **Progress** — three. `billing-setting-pure.tsx` dropped
  `[&>div]:bg-destructive` for `tone="danger"`; `session-usage-popover.tsx`
  dropped `bg-foreground/10 [&>div]:bg-foreground/55` for `tone="neutral"`.
- **Skeleton** — nine, every one of which was sizing itself with Tailwind and
  three of which were overriding the corner or the fill. Sizes became `width`
  and `height` props; the overrides went.
- **Spinner** — seven call sites across two settings screens, every one of them
  `<Loading size="sm" className="h-5 w-9" />`: a spinner centred in the box a
  Switch would occupy. The box is the caller's now and the spinner is the
  primitive's, and it announces the wait in the product's language rather than
  being a silent icon.

## Verification limits

The same two the menu and overlay notes record. jsdom applies none of StyleX's
compiled CSS, so `getComputedStyle` returns nothing and every visual assertion
is made against the classes a style compiles to. And a portalled toast is not in
the board's static markup, which is why the board carries a stand-in beside the
button that reports a real one.

One limit is specific here: a toast's arrival, its swipe and its five-second
timeout are Base UI's, driven by real pointer input and real timers, and the
jsdom suite drives none of them. What the tests pin is this package's half —
that a message reported through the manager arrives with its tone, that the
title and description are the Alert's own parts rather than a second pair, that
the viewport takes no pointer while each toast takes it back, and that closing
one removes it.

## Evidence

Intended behavior: [Shared UI primitives](../../../../specs/ui-primitives.md),
which stays `draft` with the messages and the waits stated.

Inspected implementation: `packages/ui/src/feedback`, the two new colours in
`packages/ui/src/tokens/colors.stylex.ts`, the deleted
`packages/components/src/ui/{alert,progress,skeleton,loading}.tsx`, and the
seventeen migrated surfaces.

Executed validation: `pnpm --filter @lody/ui typecheck` and
`pnpm --filter @lody/ui test` (182 tests, 15 of them new in
`test/feedback.test.tsx` plus one new board assertion);
`pnpm --filter @lody/components typecheck`; and
`NODE_ENV=development pnpm --filter @lody/components test` (3306 tests, one
timeout outside the changed scope in `tests/path-launchers-setting.test.tsx`
that passes when run alone — the known parallel-load flake).

The board was opened in Chromium under both palettes and driven there: the four
alert tones measured their tints as `oklab()` mixes of the card rung with the
16px mark in the tone's colour; a real toast, reported through the manager,
landed 16px below the top edge at `z-index: 100`, 360px wide, with the popover
shadow, `pointer-events: none` on the viewport and `auto` on itself, and it was
the topmost painted element at its own centre; the bars measured a 6px well-rung
track with the accent in it; the skeleton and the three spinner sizes were read
for fill and measurement.
