# UI overlay primitives: the popover, the modal rung, and the one thing that inverts

Status: implemented
Translation: pending

## Abstract

`@lody/ui` owned the floating surface a list and a menu open. This note records
the things that sit over a page and were still Radix with Tailwind classes:
`Popover`, `Dialog`, `AlertDialog`, `Drawer` and `Tooltip`. It records why the
popover joins the `popup` group instead of opening a second floating surface;
why the three modal surfaces are one family under one new `dialog` group; why the
tooltip is the one floating part that does **not** read `popup`; and the defects
found in the primitives as they were first written — two by the tests, three more
only by opening the board in Chromium. It also records
why there is deliberately no `Sheet`; and what this change does not do: the
`Drawer` is migrated and the Radix `sheet.tsx` deleted, while the Popover,
Dialog, AlertDialog and Tooltip call sites are not.

## Problem

The five deleted-or-doomed files reached for a vocabulary the token rules do not
have. `tooltip.tsx` was `border border-border shadow-md bg-popover` with
`zoom-in-95`; `popover.tsx` the same plus a `useSafeAreaInsets` merge into
Radix's `collisionPadding`; `dialog.tsx` `border border-border bg-background
shadow-lg rounded-lg` at `max-w-lg`; `alert-dialog.tsx` shadcn's default with a
`zoom-in-95` the dialog beside it had already been changed to drop;
`sheet.tsx` `border-l border-border` with a `cva` for its four sides. Two of them
carried a hairline border in a system whose first rule is that no border token
exists, and the dialog and the alert dialog disagreed about their own animation.

`dialog.tsx` also carried the one piece of real design in the set: it named its
own panel to `PopupContainerProvider`, because a modal traps focus and locks the
scroll by DOM position and a Select portalled to the body is "outside" the dialog
to the dialog. That belongs in the primitive, not in a product file.

## Decision

**A popover is the surface a list already opens.** `popup` covers every floating
surface, and `src/popup/surface.ts` already held the popup, the rows, the group
label and the separator. A popover reads all of it and replaces five
declarations: the `--anchor-width` a list takes because its control shows the
value it holds, the 4px inset that lets a row bleed to the surface's edge, and
the three that make the type a control's rather than prose. Two tokens are added
to `popup` rather than a `popover` group being opened beside it —
`panelPadding` and `panelGap` — plus `description`, which resolves to the same
colour as `groupLabel` today and means something else. `test/popover.test.tsx`
pins the five as a count, the way `test/menu.test.tsx` pins a menu's one.

The count was wrong when it was written. The first draft of this note, the doc
comments and the test all said "exactly two", counting only the layout pair and
forgetting that stepping from the control type rule to the prose rule replaces
three more declarations. The test failed, and the claim was corrected rather than
the test loosened.

**Dialog, AlertDialog and Drawer are one family, not three components.** They
share `src/dialog/surface.ts` and one `dialog` token group for the reason `field`
serves the whole control family: the three differ in how they arrive and in what
may dismiss them, not in what they are made of. A dialog carries a cross; an
alert dialog does not, and a press beside it is not an answer; a drawer arrives
from an edge and can be dragged back out of it.

**There is no `Sheet`, and the first version of this change was wrong about
that.** It shipped a `Sheet` built on Base UI's `Dialog` with a `side` prop —
which is Base UI's `Drawer` reimplemented out of the wrong primitive. Base UI's
own subtitle for Drawer, *"a panel that slides in from the edge of the screen"*,
is word for word what that `Sheet`'s documentation said. That is the mistake the
menu note already recorded under a different name: a second name for the same
component and a second thing to keep in step.

The behaviour is the real argument, not the naming. A panel that slides in from
an edge promises that it can be sent back, and on a touch screen a person will
try; a dialog cannot answer that gesture at all. The repository had already voted
on this — 23 files reach for `vaul` precisely because the Dialog-based sheet was
not enough — and every one of the five callers this change migrates is a mobile
bottom or side panel. The `Sheet` migration would have made five surfaces worse
on touch than the vaul drawers beside them.

**A drawer is laid out by a viewport, not positioned by itself.** That is the
mechanical reason the two cannot be the same component. A dialog centres itself
with `translate(-50%, -50%)`, which spends the one property CSS has for movement;
Base UI's Drawer puts the panel inside a fixed `Viewport` whose alignment picks
the edge, leaving the panel's `transform` free to carry the drag from
`--drawer-swipe-movement-x/y`. `test/drawer.test.tsx` pins that the drawer panel
never carries the dialog's centring class.

**The edge is stated in writing direction; the swipe is derived from it.** Base
UI names a swipe physically, because a finger moves in physical space, while this
package names an edge as `start`/`end`. `drawerSwipeDirection` resolves between
them and flips only the inline pair, so a drawer on the start edge is swiped away
leftwards in a left-to-right document and rightwards in a right-to-left one. The
direction is read from the document rather than taken as a prop.

**Flush or inset is the second axis.** A flush drawer is part of the window: it
meets the edge, squares the two corners that touch it, and pads its own content
clear of the safe area. An inset one is an object resting over the page: the
viewport pads it off every edge by `dialog.drawerInset`, it keeps all four
corners, and it has to travel that gap as well on its way out. The gap is the
viewport's padding rather than a margin on the panel for the same reason the
position is — a margin would be one more thing competing with the drag.

**A drawer crosses the window, so it takes a new motion step.** The scale gains
`duration.slow` at 320ms: 180ms over 600px reads as a snap rather than a slide.
The backdrop lifts with `--drawer-swipe-progress` rather than only at the end, so
a half-dismissed drawer shows a half-lit page and the gesture reads as
reversible.

Escape still closes an alert dialog. The first draft claimed it did not — that
was an assumption about Base UI, and `test/dialog.test.tsx` showed it false. It
is also the right behaviour: Escape is the platform's cancel, and removing it
leaves a keyboard user holding a panel they have no way to put down. What an
alert dialog actually refuses is the outside press, which is the thing a stray
click produces.

**An alert dialog's answers are Buttons, not parts.** Which variant an answer
takes is the surface's decision — "Delete" is the destructive variant in one
place and an ordinary primary in another — so the footer writes
`AlertDialog.Close render={<Button variant="destructive" />}`. That is the same
reasoning `Menu.Trigger` already follows, and it drops the old
`AlertDialogAction`/`AlertDialogCancel` pair, which decided both.

**The panel is held in state, not in a ref.** `usePanelContainer` began as the
callback ref the deleted `dialog.tsx` used, and `test/dialog.test.tsx` caught it:
React attaches a child's refs before its parent's, so a Select rendered open
inside a dialog rendered open reads the ref while it is still null and portals
itself to the body — precisely the case the whole mechanism exists to prevent. In
the product this only shows when both open in one commit, which is why five
months of the ref version looked fine. Holding the element in state costs one
extra render when the panel mounts and makes the container a fact rather than a
race.

**Safe areas are read with `env()`.** The deleted dialog used `--safe-area-top`,
a variable the desktop shell publishes. A shared package cannot depend on a host
publishing one, and `env(safe-area-inset-*)` is standard CSS that resolves to 0
everywhere it does not apply, so the panel's cap and centre are stated with it.

**A tooltip does not read `popup`.** This is the one place the elevation ladder
names something apart, and it is worth restating why: the ladder puts a menu, a
popover and a list on `raisedBackground` under `shadow.popover`, and then says
"tooltip is `label` with `shadow.medium`". That is an inversion. A popup is a
place to act; a tooltip only names what is already under the pointer, and has to
read at a glance over whatever it covers without becoming another surface. So
`tooltip` is its own group, and the chip carries the page's text colour as its
fill and the page's background as its ink — the same two colours, in the same
order, that a primary button and a checked box take.

Two things about it are behaviour rather than appearance and are pinned as such.
It never takes the pointer: one that landed under the cursor and accepted it
would take the pointer off its own trigger and flicker itself closed and open
again. And it sits above every popup, because what it names may itself be in one.

## The tooltip's accessibility contract, which the migration must carry

Base UI 1.7 makes a tooltip **visual only**: the popup has no `role="tooltip"`,
and no `aria-describedby` is wired onto the trigger. Its own documentation says
so — a tooltip reaches neither touch nor a screen reader, and a role that
promised otherwise would be a lie. The trigger must therefore carry an
`aria-label` that matches what the tooltip says.

This is the sharpest edge in the work still owed. Radix wired `aria-describedby`,
so a Lody control whose only accessible name came from its tooltip is named today
and would be nameless after a mechanical port. There are 75 files importing
`@/ui/tooltip`; each has to be read for that, not swapped.
`test/tooltip.test.tsx` pins the contract so it cannot be forgotten.

## Found by opening it, not by a test

Four defects survived a green suite. Three did so for the reason the menu note
already recorded: the tests run in jsdom, where StyleX's compiled CSS is never applied,
so no test here can see a layout or a colour.

**Every edge-anchored panel collapsed to the height of its own content.** The
first version composed the centred dialog panel, a reset that set `top: auto`,
and an edge style that set `inset-block: 0`. StyleX keeps one class per property *key* and
has no idea that `top`, `inset-block-start` and `inset-block` are three names for
one thing, so both declarations survived into the stylesheet and the cascade, not
the author, picked the winner. It picked `top`, leaving `top: auto` with
`bottom: 0`: a 380px panel 158px tall, sitting on the bottom edge. Every inset in
`dialog/surface.ts` is now a logical longhand, and each edge states all four
rather than relying on a reset before it — "the last style wins" is only true
between styles that use one vocabulary. This is a general hazard for this
package, not a detail of drawers.

**The board's dialog stand-in ran off its column, twice, for two reasons.**
First `width: 100%` on a flex item resolves against the whole row rather than the
room left in it. Then, once the stand-in was made `position: relative` so the
cross had something to pin to, it started honouring the panel's own
`inset-inline-start: 50%` and sat half a column to the right of itself. A
stand-in that drops `position: fixed` inherits every inset the real part set.

**The overlay painted over the drawer.** The panel rendered greyed under its own
backdrop, which is the whole surface looking subtly wrong rather than obviously
broken. `position: fixed` creates a stacking context, so the `z-index: z.dialog`
on the panel ordered it only against its own siblings inside the viewport; the
viewport itself had no `z-index`, counted as `auto` against the page, and the
backdrop at `z.dialogBackdrop` won. The rung's stacking belongs to the viewport,
because the viewport is the element that stacks against the product shell, and
the panel now states none. This one *was* checkable without a browser — it is a
fact about which classes compile onto which part — and `test/drawer.test.tsx`
pins it now: the viewport carries the same z-index class the dialog panel does,
the backdrop carries the other, and the drawer panel carries neither.

**The board's dimension probes reported the width they were given, not the one
they declared.** `dialog.width` read back as 167.5px because the probe was a flex
item in the metrics row. It is out of flow and hidden now, the way the rise probe
already was: a probe that participates in layout measures the layout.

One more was an error in the examples rather than in the primitives.
`tone="destructive"` on a `Button` is deliberately a no-op when the variant is
already `primary` or `destructive` — the destructive *variant* is the destructive
primary — so the alert dialog's answer rendered as an ordinary primary button in
the gallery, the README, this note and the component's own doc comment. All four
now say `variant="destructive"`.

## The naming collision this leaves behind

Eleven of the 23 vaul files are *named* `*-sheet.tsx` — `mobile-new-chat-sheet`,
`mobile-session-tab-sheet`, `mobile-acp-history-sheet` and so on. The product's
word for a vaul drawer is "sheet", and this package now says a panel from an edge
is a Drawer. Naming the primitive `Drawer` is what resolves that rather than
deepening it: when those files migrate they become drawers in both the import and
the filename. `session-detail.tsx` imports both today, so the new primitive is
aliased `UiDrawer` there until the vaul one goes.

## Deliberately not done: four of the five migrations

`Drawer` is complete: all five callers are on `@lody/ui/drawer`, the Radix
`sheet.tsx` and its barrel export are deleted. `sidebar.tsx`'s
`[&>button]:hidden` became `closeButton={false}`, and its `side` moved from
`left`/`right` to the writing-direction `start`/`end`. The 23 vaul drawers are
untouched; Base UI's Drawer is what they eventually migrate to, and this change
makes that a rename rather than a third vocabulary.

One test moved with it, and the way it had to move is worth recording.
`tests/path-launchers-setting.test.tsx` asserted `bottom-0` and
`slide-in-from-bottom` on the panel — the class names the deleted `cva`
produced, which is a description of the component rather than of what a person
sees. It now asserts `data-side="bottom"`, which is the fact the primitive
states and from which the pinning, the radius and the slide are all derived. Any
other test reaching for a Radix class name will need the same treatment.

The other four are not migrated, and the reason differs by component.

**Popover** is 14 files, and the blocker is not size. The deleted
`PopoverContent` folded `useSafeAreaInsets()` into Radix's `collisionPadding` on
every popover in the app — a product policy about a device, which `@lody/ui`
cannot hold and should not. Two call sites also use `PopoverAnchor`, one of them
with a `virtualRef`, which becomes Base UI's `anchor` prop on the positioner.
Both want a decision per surface rather than a rename: most likely a thin
`@lody/components` wrapper that keeps the safe-area policy and re-exports the
rest, which is where that policy belongs anyway.

**Dialog** (34 files), **AlertDialog** (19) and **Tooltip** (75) are together
about a thousand usage sites, and none is an import swap: `asChild` becomes
`render`, `AlertDialogAction`/`Cancel` become a `Close` around a `Button` whose
variant each surface has to choose, `DialogContentWithoutClose` becomes
`closeButton={false}`, the `noAnimation` escape hatch the command palette uses
has no equivalent yet, and every tooltip trigger has to be given a name. Landing
that with the primitives would put the whole shell behind one unreviewable diff.

Until those land, two vocabularies are alive at once, which is the same cost the
menu change accepted and the same reason not to leave it open indefinitely.

## Evidence

Intended behavior: [Shared UI primitives](../../../../specs/ui-primitives.md),
which stays `draft` with the popover, the modal rung and the tooltip stated.

Inspected implementation: `packages/ui/src/popover`, `packages/ui/src/dialog`,
`packages/ui/src/tooltip`, `packages/ui/src/popup`, and the deleted
`packages/components/src/ui/sheet.tsx`.

One limit of the browser pass is worth stating: a drag cannot be synthesised
from JavaScript here — Base UI reads real pointer input, and dispatched
`PointerEvent`s leave `data-swiping` unset. What was verified instead is this
package's half of it: setting `--drawer-swipe-movement-y` moves the panel by
exactly that much, and setting `--drawer-swipe-progress` fades the backdrop to
match. The gesture itself is Base UI's tested code; that it is wired to these
styles is what was checked.

Executed validation: `pnpm --filter @lody/components test` under
`NODE_ENV=development` (3306 tests, all passing; the root `pnpm check` does not
set that variable and every React test fails there with `act is not a function`,
which is a pre-existing gate problem rather than one this change introduced).
The board opened in Chromium under both palettes and every
part driven there — all eight drawer configurations measured against the
viewport, flush and inset on each of the four edges, with the derived
`data-swipe-direction` read off each,
the dialog and the alert dialog opened and read for fill, padding, radius and
answer variant, the popover for its panel padding and prose type, the tooltip
hovered for its inversion — plus `pnpm --filter @lody/ui typecheck` and
`pnpm --filter @lody/ui test` (141 tests, 23 of them new across
`test/popover.test.tsx`, `test/dialog.test.tsx` and `test/tooltip.test.tsx`,
plus three new board assertions), and `pnpm --filter @lody/components typecheck`
for the Drawer migration.

The same limit the menu note recorded applies here and is worth repeating: these
tests run in jsdom, where StyleX's compiled CSS is never applied, so
`getComputedStyle` returns the empty string for every property this package sets.
Every visual assertion is therefore made against the classes a style compiles to,
and the gallery test renders the board to static markup, where a portalled popup
is closed and unmounted — nothing inside a `Dialog.Content`, `Popover.Content` or
`Tooltip.Content` is in that markup, which is why the board carries stand-ins for
all three. A defect in what a person actually sees can still survive a green
suite; the board has to be opened in Chromium under both palettes.
