# UI Select and Combobox, and the popup token group

Status: implemented
Translation: pending

## Abstract

`@lody/ui` owned every control that sits still. Select and Combobox are the first
that open something, and they made the field family answer three questions it had
never had to: where a floating list gets its colours, where it mounts, and what
the difference is between the row you are on and the row that holds the value.
This note records giving the list its own token group, `popup`, rather than
stretching `field` over the floating rung; deriving both row fills from that rung
because `hoverFill` and `selectedFill` each resolve to invisible there in one of
the two palettes; and letting a host name the container its popups mount into,
which is what makes a Base UI list work inside a Radix dialog. All twelve
`@/ui/select` callers moved and the Radix file is deleted. Three defects were
found by opening the board and the product in Chromium rather than by any test,
and are recorded below. Combobox ships with no in-repo caller.

## Problem

`packages/components/src/ui/select.tsx` was Radix with Tailwind classes reaching
for a vocabulary the token rules do not have: `border-input-border`,
`bg-popover`, `focus:ring-1 focus:ring-ring`, `shadow-md`, `bg-hover` and a
`rounded-xs` row inside a `rounded-md` popup. Twelve files imported it. Its
trigger was `h-9`, the largest step on a ladder whose default is 32.

The interesting part was not the trigger. `field` had covered a family that never
left the well rung, and a Select is two things on two rungs: a control a person
reads at rest, and a list that floats over the page. The rules already said so —
the elevation table puts "menu, popover, select list" on the floating rung — but
nothing in the package had been on that rung yet.

## Decision

**The list gets its own group.** `field` covers the trigger, which is a control
on the well rung and takes the family's size ladder, ring, invalid ring and
disabled opacity unchanged. `popup` covers the list. The alternative — stretching
`field` over both — reads fine for a Select and falls apart for the very next
component: a `Menu` has no field around it and no trigger in the family, and
`field.background` would be the wrong name for the right colour. `popup` is the
group a Menu, a DropdownMenu, a ContextMenu and a Popover will share, so it is
sized for that from the start.

`popup/surface.ts` is to `popup` what `field/well.ts` is to `field`: the rules
both lists apply, in one place, so a row cannot be styled twice. A test asserts a
Select row and a Combobox row carry exactly the same classes.

**Two facts about a row, not one.** `highlighted` is where the keyboard or the
pointer is right now; `selected` is the row that holds the value. Both are a
background colour, so StyleX resolves them to a single class and the one declared
last wins: a row that is both wears the highlight, and the tick keeps saying
which row is current. That is the right way round — the highlight is the thing
that moves.

**Both fills are derived, not borrowed.** The rules name `hoverFill` for "pointer
over a row" and `selectedFill` for "the row that is current", and on the floating
rung both collapse. Measured in Chromium: `hoverFill` renders `rgb(240, 241, 244)`
against a `rgb(238, 240, 243)` popup in Lody Light — two units out of 255 — and
`selectedFill` resolves to `rgb(35, 35, 35)` against a `rgb(35, 35, 35)` popup in
Vesper, which is not a difference at all. Both were tuned against the page and
card rungs, which are at 100% lightness in the light palette; the floating rung
is at 94.3%, below them.

`popup.highlight` and `popup.selected` therefore mix `raisedBackground` toward
`label` by 6% and 3%. Mixing toward `label` moves away from the surface in both
palettes at once — darker in a light one, lighter in a dark one — and it is the
derivation `Button` already uses for a secondary button's hover, so it is not a
new mechanism. Read back off the board, the two rows land at oklab lightness
0.9105 and 0.9325 against a 0.9545 surface in Lody Light, and 0.3008 and 0.2785
against 0.256 in Vesper: the same step in both directions.

**A host names where popups mount.** `PopupContainerProvider` is a container, not
a flag, so `@lody/ui` needs no knowledge of which modal implementation a host
uses. `@lody/components`' `DialogContent` names its own panel once, and every
Select and Combobox under it mounts inside the panel. Without it a Base UI list
portalled to the body is *outside* the Radix dialog: the dialog's focus scope
drags focus back the moment the list opens, and its scroll lock swallows the
wheel before the list sees it.

**The list is anchored under its trigger, not overlapping it.** Base UI's default
overlaps the popup with the trigger so the selected row's text lands on the value,
the way a macOS pop-up button does. The motion rule in this system says something
else — "popups from 4px below at opacity 0" — so `Select.Content` defaults
`alignItemWithTrigger` to `false` and offsets by 4px. A caller can ask for the
overlap back; `surface.popupHiddenInPlace` is kept for it, because a popup that
must not move cannot slide as it fades.

**`Content` assembles the plumbing.** Base UI splits a popup into a portal, a
positioner, the popup, a scrolling list and two scroll arrows. Every caller writes
the same five, so `Select.Content` and `Combobox.Content` write them once and take
the positioning props on the outside. `Select.Item` renders its own `ItemText` and
tick; `endContent` is the one slot for a row that carries an affordance, which the
path-launcher list uses for its edit button.

**Combobox is the same list with a query in front of it.** On its own the input is
the whole control; inside a `Combobox.InputGroup` the group is the well — the ring
follows `:focus-within`, since the element that takes focus is the input — and the
input is bare, so a chevron beside it lands inside one control rather than beside a
second one. Which of the two it is, is read from context rather than taken as a
prop, so the two cannot disagree and draw two wells.

## Migrating the callers

All twelve files import `Select` from `@lody/ui/select`; `select.tsx` and
`@radix-ui/react-select` are gone. `h-9`, `h-8`, `text-xs` and `w-full` are gone
with them: the ladder is `size`, and the trigger is already full width. The
onboarding screen's `h-11` became `size="large"`, which is what the rules give an
onboarding surface.

Three differences from Radix cost real work:

- **`Select.Value` reads its text from `items` on the root, not from the rows.**
  Radix rendered the selected `SelectItem`'s text. Base UI resolves the label from
  `Select.Root items` and otherwise shows the raw value, so ten of the twelve
  callers were briefly showing `machine-macbook` where they had shown
  `Zoe's MacBook Pro`. Each now states its list once and renders both the `items`
  and the rows from it. Two tests pin this, including one that pins the failure
  mode, because it is quiet: the control still works, it just names the value.
- **`null` is the empty value.** Radix's `onValueChange` gave a string; Base UI's
  gives `Value | null`, because a `null`-valued row can clear the select. No
  migrated list has one, so each handler narrows rather than casting. Two callers
  were passing `value={x ?? ''}` to satisfy Radix; `''` matches no row in Base UI,
  so they pass `null` and get the placeholder they meant.
- **A popup inside a dialog needs the absolute positioning strategy.** See below.

`path-launchers-setting`'s edit button was absolutely positioned inside a row with
`pr-14` to clear Radix's tick. Our tick is a flex sibling, so right padding would
push it out of line; the button moved to `endContent` and the positioning hack is
gone.

## Three defects the browser found and the tests did not

Each of these passed every test in the suite and was visible the moment the board
or the product was opened in Chromium.

1. **The invisible row fills**, above. No test asserts a rendered colour, and no
   test could have caught two tokens resolving to the same value in one palette.
2. **The raw value in the trigger.** The unit tests all passed `items`, because
   the fixture was written from the Base UI documentation; every migrated caller
   was written from the Radix code it replaced, which needed no such thing.
3. **The popup landing at the far corner of a dialog.** A `position: fixed`
   element inside an ancestor with a `translate` is positioned against that
   ancestor, not the viewport — and `DialogContent` centres itself with
   `translate-x-[-50%] translate-y-[-50%]`, which Tailwind compiles to the
   `translate` property. Floating UI had computed `left: 519px; top: 547px`
   correctly and the browser resolved it to `(1016, 850)`, offset by exactly the
   dialog's own origin. `Content` now uses the absolute strategy whenever a
   container is in force, which resolves against the offset parent — the panel —
   so the two agree. Anchoring under the trigger rather than overlapping it was
   needed as well: the overlapping mode pins `position: fixed` itself and ignores
   the strategy.

## Correction: four more the board found after review

The slice was opened for review with the board looking right at rest. Pulling it
down and *clicking* the controls found four more, all of them the same class of
bug as the three above — a popup is not where it was written, so anything that
depends on where it is breaks quietly.

**A blank row above every list.** `Combobox.Empty` must stay mounted so a screen
reader has a live region to announce into; Base UI swaps its children rather
than the element. `surface.empty` gave it `min-height: 28px` unconditionally, so
an empty announcement region reserved a row at the top of every popup. It now
collapses through `:empty` — the element stays rendered and in the accessibility
tree at zero height, which `display: none`, `hidden` or `aria-hidden` would not.
Measured on the board: 0px with no padding while empty, 28px with the hint
colour once a query matches nothing, and the first row now sits 4px from the top,
which is `popup.inset` and nothing else.

**A light popup opening from a dark panel.** A forced theme works by cascade, and
a portalled popup is not in the subtree that declares it, so it inherited the
document palette. That contradicts the spec directly: "A forced theme applies to
the subtree it is placed on, including the primitives inside it… so two palettes
can be shown at once on one page." `ThemeRoot` now publishes its mode and
`Content` re-declares the palette on the positioner — the same fix
`componentPaletteThemes` already makes for a custom property declared only at the
document root, applied one level further out. The board's Vesper panel now opens
`rgb(35, 35, 35)` with white text and the dark accent on its focus ring, and the
Lody Light panel opens `rgb(238, 240, 243)`.

**A stray blue ring on the highlighted row.** Measured
`rgba(91, 141, 239, 0.5) 0px 0px 0px 1px inset` on the row Base UI had moved
focus to — not ours. The product shell's "Pro focus style" rings any focused
`[tabindex]` through a zero-specificity `:where()` rule, and its exemption list
already carries `[role="menuitem"]` with a comment describing this exact
failure; an option is the same case and was not on the list. Rather than extend
the shell's list, `surface.item` states `box-shadow: none`: the row owns its
edge, which is no edge, and no host can put one on it. The fill is how this
system marks where the keyboard is.

**The board's stand-in read as a second, different list.** With the palette fixed
the two are now identical, which is the point — but nothing said so. The legend
is `list · stand-in` and a caption under it says that opening a trigger above
shows this same list in this same palette.

The first two are the reason this correction exists rather than a follow-up: a
blank row and a wrong-palette popup are visible to anyone who opens a Select, and
both were invisible to a suite that never opens one in a themed subtree.

## Testing a popup in jsdom

Four things about driving Base UI in jsdom are load-bearing, and `test/dom.tsx`
carries them so no suite has to rediscover them:

- **React 19 ships `act` only in its development build**, and its entry picks the
  build from `process.env.NODE_ENV`, which is `production` under this package's
  vitest config because the StyleX plugin compiles with `dev: false`. The config
  now sets it. Without it every test that drives a control fails with
  `act is not a function` rather than reporting what it asserts.
- **A stand-in `PointerEvent` must default `pointerType` to `''`**, which is the
  spec's default. Base UI reads exactly that to tell a keyboard-generated click
  from a stray pointer one, so a stand-in defaulting to `mouse` makes every
  synthesized Enter look like a mouse click on an unhighlighted row and the item
  refuses to commit.
- **A click is a sequence.** A Select opens on the click and a Combobox on the
  mousedown, and a row is picked where the pointer moved, so a helper that fires
  only one of the three silently tests half the family.
- **Frames have to be drained.** Base UI defers part of opening a popup to an
  animation frame and `act` flushes React's work but not the frame queue, so an
  interaction that follows lands between a popup being asked to open and its
  opening, and the deferred frame then undoes it.

A closed Select also keeps its list mounted and marks the positioner `hidden`, so
"closed" is what the trigger announces rather than the row count, and the helper
that collects elements skips anything inside a `[hidden]` subtree.

## Verification

`pnpm --filter @lody/ui test` (85 tests, 36 of them new) and
`pnpm --filter @lody/ui typecheck` pass, as does
`pnpm --filter @lody/components typecheck`.
`NODE_ENV=development pnpm --filter @lody/components test` reports 3305 passing
and one failure in `tests/avatar-cache.test.ts`, which passes on its own and is
unrelated to this change — it awaits a blob revalidation and loses that race under
a loaded worker pool.

The new tests cover the trigger's element and role, the placeholder giving way to
the value, the label resolved from `items` and the raw value shown without them,
opening on click and closing on Escape with focus handed back, the arrow keys and
Home/End walking the list, Enter taking the highlighted row, the selected row
being the only one that draws a tick, the highlight winning the fill from the
selected row, a disabled row being dimmed and unpickable, groups and separators,
the container a provider names, the query narrowing the list, the empty message,
the input group carrying the well while the input inside it is bare, and a Select
row and a Combobox row being the same row.

Read in Chromium through Storybook at 1440px, values taken off the rendered nodes
in both palettes: the trigger is 28/32/36 at radius 8/10/10 with `corner-shape: squircle`,
`rgb(232, 234, 237)` with the inset shadow in Lody Light, the destructive ring at
`rgb(206, 34, 45)` while invalid at rest, and `opacity: 0.45` when the field is
disabled. The popup is 14px radius with a 4px inset holding 10px rows at 28px,
8px padding, an 8px gap and a 16px tick, group labels at 11/16 and a 20px scroll
arrow, and its hidden end resolves to `matrix(1, 0, 0, 1, 0, 4)`. The Combobox
group carries the well at 32px while the input inside it is transparent with no
shadow. In the bug report dialog the list mounts inside `[data-lody-dialog-content]`,
opens 4px under a 398px trigger at the trigger's own left edge, keeps focus on an
option, and shows the machine name with its online dot. The console reported no
errors.

Limits: no test asserts a rendered colour, which is what let the two invisible
fills ship as far as the board, and what makes the collapsed announcement region
and the absent row edge browser-verified rather than unit-tested — jsdom applies
no stylesheet, so the tests pin the mechanism (one element, one class list, a
declared `box-shadow`) and the board pins the value. Only Chromium was checked and no mobile surface
was opened. `Combobox` has no in-repo caller — `OptionSelector`, the cmdk-based
searchable picker with 61 call sites, is the caller it is for and is a slice of
its own. `pnpm check` was not run to completion for the whole repository in this
session. `THIRD_PARTY_NOTICES.md` still lists `@radix-ui/react-select`.

## Follow-ups

`OptionSelector` is the Combobox migration, and it brings virtualization and a
fuzzy scorer with it. The menus — `dropdown-menu`, `context-menu`, `menubar`,
`popover` — are the next users of the `popup` group and the first test of whether
it was drawn wide enough. Whether `hoverFill` and `selectedFill` should be
retuned so they work on every rung, rather than each component deriving its own,
is a palette question this change deliberately did not answer. `Button` still has
no visible keyboard focus ring in the desktop shell; the two open fixes are in the
[field primitives note](2026-09-09-ui-field-primitives.md).
`THIRD_PARTY_NOTICES.md` and the generated attributions want one regeneration pass
together with the packages the earlier slices removed.
