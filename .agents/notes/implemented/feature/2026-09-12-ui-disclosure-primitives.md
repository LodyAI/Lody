# UI disclosure primitives: one family for the three ways of showing one thing

Status: implemented
Translation: pending

## Abstract

`@lody/ui` had no answer for the parts that show one thing out of several, so
`Tabs`, `Accordion` and `Collapsible` were still Radix with Tailwind classes that
reconstructed a segmented control by hand — `data-[state=active]:bg-background
data-[state=active]:shadow-xs` repeated in four places, each at a slightly
different height. This note records why the three are one family under a single
new `disclosure` token group rather than three components; why the strip's
indicator is drawn by `Tabs.List` rather than by a caller; why a revealed
panel's padding has to ride on a child of the panel; and the one defect that a
green test suite could not see — a disabled tab that was not dimmed, because
neither a Base UI tab nor an accordion row carries the native `disabled`
attribute that `:disabled` needs. Seven surfaces are migrated and the Radix
`accordion.tsx` and `collapsible.tsx` are deleted; `tabs.tsx` survives for
`ContextSwitch`, whose dark-hero `tone` prop is a decision about the landing
page rather than about a tab.

## Problem

Four files were assembling the same segmented control out of Tailwind, and
disagreeing while they did it. `tabs.tsx` gave a list `h-9 bg-muted p-1` with
`data-[state=active]:bg-background data-[state=active]:shadow-sm` on the
trigger; `context-switch.tsx` restated all of it at `h-10` with a `border` and a
second version for a dark tone; `chat-landing.tsx` restated it again at `h-10`
with `shadow-xs`; `mobile-stats-settings.tsx` used `grid-cols-4` and no height
at all. Two of them carried a border in a system whose first rule is that no
border token exists, and the four heights — 28, 32, 36, 40 — included one that
is not on the control ladder.

`accordion.tsx` was shadcn's default: `border-b` on every item, `hover:underline`
on the trigger, and a pair of keyframe animations (`accordion-up`/`down`) that
exist nowhere in the token rules. `collapsible.tsx` was three re-exports of Radix
with no design in it at all, which meant every caller wrote its own reveal — and
two of the three wrote none, so a panel appeared instantly.

## Decision

**Three layouts of one idea, one token group.** A tab strip lays the choices
side by side and swaps the panel under them; an accordion stacks them and opens
one in place; a collapsible is a single one of those rows with no list around
it. Each is a trigger and the thing it shows, so `disclosure` covers all three
for the reason `dialog` covers three modals: what differs is the arrangement,
not what either is made of. The colour a closed row's label takes and the colour
a tab you are not on takes are one decision, not two that can drift.

The group is deliberately *not* `field`. None of the three holds a value — a tab
picks what is shown, not what is stored — so none takes a name, answers to a
`Field.Root`, or has an invalid state. A strip borrows the well the controls sit
in because the elevation ladder puts it there, not because it is one of them.

**The strip is the ladder read twice over.** A well-rung track with one thing
raised out of it is the same pair a `Switch` takes, and it says the same thing:
the track is where something sits, and the thing sitting in it is the one you
can press. The indicator therefore takes `raisedBackground` under
`shadow.raised`, which is what the Edges rule already gives "you can press
this", and what a secondary `Button` already uses.

**The indicator is one element that moves, and `Tabs.List` draws it.** A fill on
each tab would light up and go out; one pill that slides between the choices
says that the strip is a single control. Base UI publishes the selected tab's
box on the indicator as physical pixels from the list's own top-left corner, so
the pill is anchored physically with `left`/`top` and moved with `translate` —
reading those offsets from the inline edge would put it on the wrong tab in a
right-to-left document. The list renders it rather than the caller for the
reason a submenu's chevron is drawn by its row: a strip assembled without one is
a segmented control with nothing segmented.

**The size is stated once, on the strip.** A tab's height, corner and share of
the width all follow from the track's, so `Tabs.List size` carries them through
context and no two tabs can disagree. Nested radius applies as everywhere else —
a 28px track at `radius.small` holds a 4px tab, a 32 or 36px one at
`radius.medium` holds a 6px tab — and `test/disclosure.test.tsx` pins the pair
that shares a corner, which is the corner rule's own "medium 10 for 32 and 36px
controls".

**`stretch` is one prop because it is two facts.** Three of the migrated
surfaces want a strip that takes the width on offer with the choices splitting
it, and they each wrote it twice: `w-full` on the list and `flex-1` or
`grid-cols-4` on the triggers. A surface that stated only the first would get a
full-width groove with its choices huddled at the start, so the primitive takes
one named choice and applies both.

**Arrow keys move without taking.** This is Base UI's default and it is also the
right one here: a tab swaps a panel that may be expensive to build — a settings
tab that syncs history, a file preview that renders Markdown — and arrowing to
the fourth tab should not build the second and third on the way. APG allows
either; a surface whose panels are cheap says `activateOnFocus`, and the board
shows one that does.

**A row has no fill, so the line is the separator.** An accordion's rows are its
own children, which leaves nowhere for a caller to put a separator part and
nothing to stop them forgetting it, so the line is an inset `box-shadow` on the
item and the last row draws none. That is the `separator` token used for exactly
what the rules name it for — a divider between list rows — rather than a border
reintroduced under another name.

**A revealed panel's padding rides on a child.** Base UI animates the panel's
height from a size it measures with `scrollHeight`, which counts padding. A
padded panel is therefore cropped by exactly its own padding under `border-box`
and overshoots by it under `content-box`. `Accordion.Panel` holds its prose in
such a child, and the one migrated caller that had padding on the old Radix
content — `session-plan-bar.tsx`, with `border-t pt-2` — has it moved inwards.
This is the trap in the migration, because at rest the height is `auto` and the
mistake only shows while the panel is moving.

**A `Collapsible`'s trigger is Base UI's, unstyled.** A lone disclosure is
opened by whatever the surface already had there — a card header, a row of a
table, a button that also says how many files changed — so handing it a styled
control would be a second thing to keep in step with `Button`. What the
primitive owns is the panel: the measured height, the transition, and the
overflow that hides what is arriving. Both migrated callers keep the trigger
they had and gain the reveal they never wrote.

## Found by opening it, not by a test

**A disabled tab was not dimmed.** The strip was written with the family's usual
`opacity: { ':disabled': … }`, the suite was green, and the board reported
`disclosure.disabledOpacity 1`. Base UI does not put the native `disabled`
attribute on a tab or an accordion row: both stay focusable so a keyboard
reaches them and hears `aria-disabled`, which is the accessible behaviour and
the opposite of what the field family does. `:disabled` therefore never matched,
and neither did the `cursor` beside it. Both parts now take the dim from Base
UI's state in the `className` callback, the way the field family reads validity
in JS, and the tab also freezes its hover colour — a tab that cannot be taken
should not light up under the pointer. `test/disclosure.test.tsx` pins the
reason rather than the symptom: the element carries no `disabled` attribute,
carries `aria-disabled`, and carries the state's classes.

The jsdom limits the menu and overlay notes recorded apply here too, and two
more are specific to this family. StyleX's compiled CSS is never applied in the
test environment, so `getComputedStyle` returns nothing and every visual
assertion is made against classes. And because no CSS is applied, no transition
duration exists: Base UI reads `transition-duration` off the panel to decide how
to reveal it, finds `0s`, and takes the no-motion path — so the two ends of a
reveal never occur in a test at all. `isCollapsed` is exported and asserted
directly for that reason, and the reveal itself was verified in Chromium, where
the panel measures `height: 32px` with `transition: height 0.18s` and its child
holds the 12px padding.

Taking a tab with Enter is also unverifiable here: it is the platform's own
activation of a real `<button>`, which jsdom does not synthesise.

## The one test that had to move

`tests/agent-config-dialog.test.tsx` selected a tab by dispatching `mousedown`
alone, because that is when Radix committed. Base UI commits on the click, so
the helper now performs a whole press. That is the same treatment the drawer
note recorded for a test asserting Radix class names: a test written against a
library's internal moment has to be rewritten against what a person does.

## Deliberately not done

**`ContextSwitch` stays on Radix, and so does the story that mimics it.** It is
not a rename: the component takes a `tone` prop and paints a different tab strip
for the landing page's dark hero, which the whole landing shares with its
selectors and its chips. The right migration is for that hero to declare a
palette with `ThemeRoot` and let the primitive resolve against it, which is a
decision about `chat-landing-view.tsx` rather than about tabs. Its second
complication is a "disabled" tab that must still answer a click, to open a
tooltip explaining why it is unavailable — a Base UI tab will not, so that
surface needs a control beside the strip rather than a tab in it.

**`tree-view.tsx` keeps `@radix-ui/react-accordion`.** It builds a file tree out
of accordion primitives rather than using the shadcn wrapper; it is a component
of its own, not a caller of this one. `@radix-ui/react-collapsible` also stays,
for `collapsible-card.tsx`. Both dependencies therefore remain in
`packages/components`, while `src/ui/accordion.tsx` and `src/ui/collapsible.tsx`
are deleted with their barrel exports.

`packages/ui/AGENTS.md` is 266 bytes from its 8 KiB gate after this change. The
Drawer and Tooltip bullets were compressed into their binding rule to make room,
with the explanation left where it already was in the README; the next family to
land will have to route a topic out rather than add a bullet.

## Evidence

Intended behavior: [Shared UI primitives](../../../../specs/ui-primitives.md),
which stays `draft` with the disclosure family stated.

Inspected implementation: `packages/ui/src/disclosure`, the deleted
`packages/components/src/ui/accordion.tsx` and
`packages/components/src/ui/collapsible.tsx`, and the seven migrated surfaces.

Executed validation: `pnpm --filter @lody/ui typecheck` and
`pnpm --filter @lody/ui test` (166 tests, 18 of them new in
`test/disclosure.test.tsx` plus one new board assertion);
`pnpm --filter @lody/components typecheck`; and
`NODE_ENV=development pnpm --filter @lody/components test` (3306 tests; the one
failure outside the changed scope, `tests/avatar-cache.test.ts`, passes when run
alone and is the known parallel-load flake).

The board was opened in Chromium under both palettes and driven there: the three
track heights measured 28/32/36 with corners 8/10/10 and their tabs 20/24/28 at
corners 4/6/6; the indicator measured `raisedBackground` under `shadow.raised`
and moved from `translate: 4px 4px` to `137.6px 4px` when a third tab was taken;
the accordion's first two items carried the inset separator and the last carried
`none` in both palettes; and an open panel measured `overflow: hidden`,
`height: 32px`, `transition: height 0.18s` with `padding-bottom: 0`, its child
carrying the 12px. Three migrated surfaces were opened the same way — Project
Settings, the DeepSeek provider dialog with its stretched strip and its two
collapsibles, and the expanded session plan bar — plus the open-source notices
accordion with both of its rows open.
