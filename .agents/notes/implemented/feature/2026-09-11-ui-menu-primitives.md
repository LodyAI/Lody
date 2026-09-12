# UI menu primitives: one surface, three ways in

Status: implemented
Translation: pending

## Abstract

`@lody/ui` already owned the floating surface — a Select and a Combobox open one
— but every menu in the product was still Radix with Tailwind classes reaching
for a vocabulary the token rules do not have. This note records adding `Menu`,
`ContextMenu` and `Menubar` to the package as one family rather than three
components: the rows, the groups, the separators and the submenu trigger are
written once and re-exported, and only the way in differs. It records the one
declaration a menu replaces on the shared surface — a list's `--anchor-width` —
and why `DropdownMenu` is not a separate name. It also records what this change
deliberately does **not** do: the 41 files importing `@/ui/dropdown-menu` and the
11 importing `@/ui/context-menu` are not migrated here, and the reasoning for
that is below. The Radix `menubar.tsx` had no caller at all and is deleted with
its dependency.

## Problem

`packages/components/src/ui/menu-styles.ts` computed the menu's edge as
`color-mix(in oklab, hsl(var(--background)) 90%, hsl(var(--foreground)) 10%)`
and painted it as a hairline ring in a `box-shadow` stack, with a comment
explaining that `--border` could not be used because it "can clash hard against
`--background`". That is a workaround for a border token in a system whose rules
say there is no border token: edges are wells, raised shadows, elevation shadows
and the focus ring. Rows were `min-h-8` at `rounded-lg` inside a `rounded-xl`
surface — neither pair is on the nested-radius rule — group labels were 10px at
`tracking-[0.6px]`, and the disabled treatment was 50% where the rules say 45%.

Three files carried the same vocabulary in three copies. `dropdown-menu.tsx` had
grown 630 lines around Radix: a touch workaround that blocks Radix's
`pointerdown` and re-dispatches a synthetic mouse one on `click`, because Radix
toggles from `pointerdown` alone and a scroll starting over a trigger opened the
menu; a whole submenu-level context that exists only to beat Radix's hard-coded
100ms hover delay; and a search field that installs a native `keydown` listener
on the menu content to claim printable keys back from Radix's typeahead.

The fourth, `menubar.tsx`, was shadcn's default with `border border-border`,
`bg-popover`, `rounded-xs` rows and `zoom-in-95` animations. Nothing in the
repository imported it.

## Decision

**A menu is the surface a list already opens, not a new one.** `popup` covers
every floating surface, and `src/popup/surface.ts` already held the popup, the
row, the highlight, the group label and the separator that a Select uses. A menu
reads all of it. Exactly one declaration is replaced: a list states
`min-width: var(--anchor-width)` because the control it belongs to shows the
value the list holds and the two read as one control, while a menu is opened by
whatever the surface already had there — often a 28px icon button — so it states
`popup.menuWidth` and grows past it for its longest row. `test/menu.test.tsx`
pins that as a count: of the classes a list's surface compiles to, exactly one is
missing from a menu's.

Three tokens are added to `popup` rather than a `menu` group being opened beside
it, because a group per component is what the package's rules already rule out:
`menuWidth`, `destructive`, and `destructiveHighlight`. The last is mixed toward
`destructive` for the same reason `highlight` is mixed toward `label` — measured
on the floating rung, the palette's named fills collapse into the surface — so a
row about to delete something stays legible while the keyboard is on it.

**`Menu` is the dropdown menu.** Base UI has no separate part for one; a
`DropdownMenu` export would be a second name for the same component and a second
thing to keep in step. `ContextMenu` restates its root and its trigger — a right
click or a long press over a region — and `Menubar` restates the bar and the
names on it; both re-export `Menu`'s rows. The alternative, four components with
four row implementations, is exactly the shape the deleted files had, and it is
why `menu-styles.ts` existed at all: three copies that had already drifted, since
`menubar.tsx` never imported it.

**The bar is rows laid sideways.** A menubar trigger takes `popup.itemHeight`,
`popup.itemRadius`, `popup.text` and `popup.highlight` — a menu row turned along
a bar — rather than a token group of its own. The bar itself declares no
background and no edge, because a menubar is not a surface: it sits on whatever
rung the shell put it on, and giving it a fill would put a second surface inside
the one already holding it.

**The rise is measured against the anchor, not the page.** The motion rule says a
popup rises from 4px below, which was written when the only popup was a list that
always opens below its trigger. A menu flips to stay on screen and a submenu
opens beside its row, so the rule is restated as a distance from what opened it:
the popup starts one step further away on whichever side it landed and closes
that step as it arrives. `hiddenSurfaceForSide` reads Base UI's resolved side,
because StyleX cannot express `[data-starting-style]`. A context menu is anchored
to the pointer rather than to a control, so `ContextMenu.Content` states no offset
at all and lets Base UI place its corner under the click.

**A row's leading box holds one thing.** A plain row's box holds a caller's
glyph; a checkbox or radio row's box holds its mark and nothing else. Base UI
unmounts the mark while the row is unticked, so an icon sharing that box would
slide sideways every time the row was toggled — the row would animate a layout
change to report a state change. A row with no icon takes no box, so an icon-less
menu is not indented for nothing, and a row in a mixed list asks for one with
`inset`.

**Post-close focus is the product's.** `packages/components/src/lib/menu-focus.ts`
holds a real product policy: after a selection, focus belongs in the composer
rather than back on the trigger, or the next Enter reopens the menu instead of
submitting. That is a decision about Lody's composer, not about menus, so the
primitive exposes Base UI's `finalFocus` and does not choose. The touch
workaround is dropped: Base UI already distinguishes a tap from a scroll, so the
synthetic-`pointerdown` re-dispatch has nothing left to fix.

## Deliberately not done: the migration

The established shape for this series is that a primitive lands with its callers
moved and the Radix file deleted. That is not what happened here, and the reason
is size rather than difficulty. Radix's menus have about a thousand usage sites
in this repository — 283 `DropdownMenuItem`, 162 `DropdownMenuContent`, 150
`DropdownMenuTrigger`, and so on across 41 files, plus 11 for the context menu —
and unlike the field family this is not an import swap. Radix's `onSelect` with
`preventDefault` to keep a menu open becomes `closeOnClick={false}`; `asChild`
becomes `render`; `align` and `side` move from the content to the positioner;
`Sub` becomes `Submenu`; and `DropdownMenuSearchInput`, which exists only to
fight Radix's typeahead, has to be re-examined against Base UI rather than
ported. Landing that in the same change as the primitives would put the
Electron shell's menus behind one unreviewable diff.

So this change lands the primitives, the tokens, the board and the tests, and the
migration follows per surface. `Menubar` is the one piece that is complete: it
had no caller, so its Radix file, its barrel export, its `@radix-ui/react-menubar`
dependency and its attribution entry are gone.

Until the migration finishes, two menu vocabularies are alive at once — the new
one in `@lody/ui` and `menu-styles.ts` in `@lody/components`. That is the cost of
splitting it, and it is why the migration should not be left open indefinitely.
One thing the migration must carry: `@lody/ui` has no descendant selector, so a
menu row's leading box cannot size a lucide icon the way
`menuItemIconClassName`'s `[&>svg]:size-full` did. Each migrated call site — or
one shared wrapper in `@lody/components`, which is a Tailwind package and may
still write that rule — has to make the glyph fill its box, or it renders at the
icon library's 24px default.

## Found by opening it, not by a test

Three defects survived a green suite and were caught in Chromium. All three are
the same shape: the board is rendered to static markup in the gallery test, and a
menu is portalled and unmounted while it is closed, so nothing a test could reach
was ever the thing a person sees.

**A group label outside a group throws.** `Menu.GroupLabel` is Base UI's, and it
reads a context only `Menu.Group` and `Menu.RadioGroup` provide; a bare one takes
the whole subtree down with `Base UI error #31`. The suite had not caught it
because its only group label was inside a `RadioGroup`, which supplies the same
context. This is the migration's sharpest edge: Radix's `DropdownMenuLabel`
rendered anywhere, and there are 52 of them. `test/menu.test.tsx` now pins both
halves — that a label names the group it is in, and that one outside a group
throws rather than quietly labelling nothing.

**`popup.menuWidth` read back as `0px` on the board.** The stand-in reused the
list stand-in's style, which sets `min-width: 0` to neutralise the
`var(--anchor-width)` a popup has outside a positioner. That is right for a list
and wrong for a menu, whose width floor is the one declaration it states for
itself; the menu stand-in keeps it and now reports `200px`.

**Two strings rendered as their own escape sequences.** A JSX attribute value
is not a JavaScript string literal and does not process backslash escapes, so
the section heading read `Menu \u00b7 dropdown, context menu and menubar` on the
page and a shortcut read `\u2318N`. The same text inside braces is a JS literal
and resolves; the two written as plain attributes did not.

## Evidence

Intended behavior: [Shared UI primitives](../../../../specs/ui-primitives.md),
which this change returns to `draft` with the menu family stated.

Inspected implementation: `packages/ui/src/menu`, `packages/ui/src/popup`, and
the deleted `packages/components/src/ui/menubar.tsx`.

Executed validation: `pnpm --filter @lody/ui typecheck` and
`pnpm --filter @lody/ui test` (112 tests, 25 of them new in
`test/menu.test.tsx`), and the board opened in Chromium under both palettes —
the tests run in jsdom, where StyleX's compiled CSS is never applied, so no test
here can see a layout or a colour. Every visual assertion in `test/menu.test.tsx`
is therefore made against the classes a style compiles to rather than against
`getComputedStyle`, which returns the empty string for all of them.
