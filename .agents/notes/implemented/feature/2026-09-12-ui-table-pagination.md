# UI table and pagination: records, and the way to the ones that did not fit

Status: implemented
Translation: pending

## Abstract

`@lody/ui` had no way to show records, and the first attempt at one was a styled
`<table>`: parts mirroring the HTML elements, with the design work all in the
skin. It was rejected on review as conventional, and this note records the
design that replaced it. **A column is stated once** — `Table` takes
`columns: TableColumn<Row>[]`, and from that one fact it owns the width, the
ordering, the selection, the empty row's span, the head that stays, and the
stack a table becomes when its own container is too narrow. The evidence for
that shape is in the repository: every surface here that draws a table writes
its column template as a literal `grid-cols-[…]` string in the header and again
in the row, by hand, and one of them renders every cell a second time for a
narrow window. This note also records why a table is the only part of this
package with no surface of its own; why `border-collapse: separate` is what lets
its line, its sticky head and a row's focus ring all be box-shadows; why the two
row fills are the palette's `hoverFill` and `selectedFill`; and why `Pagination`
is one control with the windowing rule inside it. Base UI ships neither
component. Both Radix files are deleted and three callers migrated.

## Problem

Two files, one of them a design the package had already outgrown and the other
dead.

`table.tsx` gave every row `hover:bg-muted/50` and every cell
`p-2 whitespace-nowrap`, with `[&_tr]:border-b` on the head and
`[&_tr:last-child]:border-0` on the body — Tailwind reaching into descendants
for what a part should own. The always-on hover is the interesting defect: its
one in-repo caller, the onboarding summary, is a two-column list of facts that
nothing can be done to, and it had to pass `hover:bg-transparent` on every row
to put the default back. A default a caller has to undo is the wrong default.

`pagination.tsx` had **no callers**. It was already half-migrated — its
`PaginationLink` rendered `@lody/ui`'s `Button` — and the pieces it exported
(`Root`, `Content`, `Item`, `Link`, `Previous`, `Next`, `Ellipsis`) put the part
that is actually hard back on the caller: deciding which pages to list, and
where to put the gaps. The repository does have a pager, and it is hand-rolled:
`paged-file-viewer.tsx` has two ghost buttons and a number `<Input>` for a file
of up to 49,000 pages, and it navigates on every keystroke, so typing `45` reads
and throws away page 4 on the way.

Neither file could state any of this in tokens: `@lody/ui` had no token for a
row's height, the line between rows, the colour of a column's name, or the two
fills a row takes.

### And the first attempt was not a design

The first version of this work shipped `Root / Head / Body / Foot / Row /
ColumnHeader / Cell / Caption` — the HTML element list with React casing — and
put every decision into the skin. Reviewed, it was "very standard, and very
ordinary", and that was right. A caller assembling those parts still has to keep
the head and the body in step, still has to work out which pages of a column's
width belong where, still has to count the columns an empty row must cross, and
still has to hand-roll the narrow layout. The parts are kept, because a table
that is *not* a list of records needs them, but they are no longer the thing a
caller reaches for.

## Decision

**One group, `table`, for both.** A pager exists because a table did not fit,
the two sit on the same rung, and they state the same size; how dense a list of
records is has one place to change rather than two. This is the call `dialog`
makes over the Drawer — a drawer is not a dialog either, it shares the rung and
the construction. The pager's own tokens are prefixed inside the group
(`pagerGap`, `pagerHint`, `pagerJumpWidth`) the way `feedback` carries
`toastWidth` beside `spinnerSmall`.

**A column is stated once, and everything follows from it.** This is the design.
A table's hard parts are facts about a *column* — how wide it is, which way it
aligns, whether it holds figures, whether the table can be ordered by it, what a
totals row holds under it — and a column written twice can drift. The evidence
is not hypothetical: `device-resource-monitor.tsx` and
`account-machines-overview.tsx` each write
`grid-cols-[minmax(160px,40%)_minmax(0,1fr)…]` in the header and again in the
row; `review-policy-setting.tsx` hand-rolls `role="table"`, `role="row"` and
`role="columnheader"` around a template written twice. What the table can do
once the columns are stated, and a caller cannot:

| it owns | because |
| --- | --- |
| the widths | a `<colgroup>` reaches cells the caller never writes |
| the ordering | one column at a time is unrepresentable per column |
| the selection | the head's box is *derived* from the rows, mixed and all |
| the empty row | only the table knows how many columns to cross |
| the head that stays | it is the root that knows there is a box to stay in |
| the stacked layout | a cell can carry its column's name when the head is gone |

**The rows are never reordered.** The table owns the control, the arrow,
`aria-sort` and the shape of the state; the surface owns the data, because a
server sorts, a comparator breaks ties and a page is one slice of many. A table
that quietly sorted what it was handed would be wrong exactly once — on the
surface that had already sorted it.

**Selection is a tick, and the fill is second.** `aria-selected` on a `<tr>`
inside a `<table>` is an ARIA violation, so the table puts a `Checkbox` in the
row: the thing a person presses and the thing a screen reader is told are then
the same thing. The box over that column is derived rather than passed — none,
some (`mixed`), or all — and a select-all keeps keys the table is not currently
showing, so one page of a long selection does not drop the other pages.

**A table has no surface.** No background, no shadow, no radius. Every other
part in this package names a rung; a table deliberately names none, because it
is rows on whatever was already there, and a table that drew a card inside a
card is the same fill twice — the defect the feedback family's neutral tint had
to fix. The one exception is a head that *stays*: that is no longer a row but a
band over the rows moving under it, and the ladder already has a rung for a band
over the page. A transparent one is not a quieter design — the records are
painted through the column names, which is legible in a screenshot.

**`border-collapse: separate`, and the border exception is gone.** The first
version claimed a table had to draw its line as a border, "the one place in the
package where it has to be". That was wrong, and a Chromium probe of six cases
showed why: the inset shadow had been hidden by an opaque cell background in the
test, not by the table model. Under `separate` a row's inset shadow paints, a
row can carry an outer focus ring, and a sticky head keeps its line — while
under `collapse` a sticky head's border does **not** travel with it, which is a
real defect rather than a preference. So the table went back to the
`inset 0 -1px 0` every other row in this package draws, and a row keeps one
`box-shadow` in which its line and its ring compose.

**The pointer is answered only where pressing a row does something.** `interactive`
on the root became `onRowPress`, which is the same default made honest: the hover
now arrives with the thing that justifies it, and the row takes the keyboard with
it (Enter and Space press it, and the ring says where the keyboard is).

**A table too narrow for its columns becomes a list of records.** This was
deliberately not done in the first version, on the argument that a breakpoint is
the wrong unit — a table in a 360px side panel on a 27-inch screen is narrow, and
a media query calls it wide. That argument was right and the conclusion was
wrong: the correct unit exists. StyleX supports `@container`, so the table asks
about **its own** width. Each record becomes a stack of label-and-value lines
where the label is the head's own words — only reachable because the columns were
stated. The width belongs to the system rather than a caller: a caller choosing
it is a caller deciding how wide a record may be. Without this the primitive
could migrate nothing: all three of the repository's real tables collapse on a
narrow window today, by hand.

**`Pagination` is one control, not parts.** The window is what a caller would
otherwise get wrong, so `pageWindow(page, pages, siblings, boundaries)` is a
pure function with its own tests: one fixed width from the first page to the
last, so the buttons do not move out from under the pointer; a gap only where it
stands for more than one page, since a gap hiding a single page is wider than
the page it hides; and against either end, the gap that is not needed spent on
listing more pages instead.

**Two layouts, because nine thousand pages are not a list.** `numbered` lists
them; `compact` says where you are. `compact` is not a lesser version — it is
what the one real caller in this repository needs, and `jump` gives it the
typed page the hand-rolled pager already had. It commits on Enter or on leaving
the field rather than on every keystroke, which is the second defect this change
fixes: page 4 is no longer read and discarded on the way to 45.

**Base UI ships neither part.** `@base-ui/react` 1.7.0 has no table and no
pagination, and there is no behaviour here to import: a table's semantics are
the platform's `<table>`, and a pager is a `<nav>` of buttons. So these are
written the way `Skeleton` and `Spinner` are — plain `forwardRef` parts over
real elements — and Base UI enters where it has something to give: every button
in the pager is this package's `Button`, which is Base UI's, and the jump field
is `Input`, which is Base UI's. No `render` prop was added to the table parts,
because nothing in the repository needs to swap those elements and a speculative
escape hatch on eight parts is eight more contracts to keep.

**The size is stated once**, on the root, and reaches the cells through context
— the call `Tabs.List` makes for the same reason: a row's height and a cell's
padding are one decision, and stated per cell two of them could disagree inside
one row.

## Deliberately not done

**No virtualisation.** The table owns the row loop now, and the row height is a
token, so a windowed body is implementable — but it needs a caller with enough
rows to prove it, and none of the three migrated here has one. The shape it
would take is recorded rather than guessed at.

**No `Table.Empty` part, and no loading state.** The empty row is a prop because
only the table can count the columns; a *loading* table is the same row with
different words, which is what `review-policy-setting.tsx` passes. A spinner
inside a table would be this package deciding what waiting looks like in a place
`Spinner` already answers.

**The markdown renderer's table is not migrated.** `markdown-renderer.tsx`
renders `<table>` through Streamdown's component map, where the rows and cells
are produced by the Markdown AST and never pass through a React component this
package could supply. Migrating it means replacing the `td`/`th`/`tr` handlers
as well, which is a change to how agent output is rendered rather than to a UI
primitive, and it belongs with whoever owns that surface.

**`device-resource-monitor.tsx` and `account-machines-overview.tsx` are not
migrated here.** They are the two biggest wins — ~115 and ~100 lines of row
markup, a duplicated column template each, and a duplicated mobile cell block in
the first — and that is exactly why they are not being folded into the PR that
introduces the primitive. They are recorded as the next callers.

## Migrated

Three callers, and both Radix files deleted.

- **`review-policy-setting.tsx`** — `ReviewerMachineConfigTable` was a
  hand-rolled `role="table"` / `role="row"` / `role="columnheader"` over a
  `grid-cols-[minmax(150px,0.75fr)_minmax(0,1.75fr)]` template written twice,
  with `hidden … sm:grid` on the header and `flex flex-col … sm:grid` on the row
  to collapse it on a narrow window. All of that is now two `TableColumn`
  entries; the roles are the elements' own, the collapse is the container query,
  and the loading and empty branches became one `empty` prop. The row component
  split into the two cells it always was.
- **`summary-screen.tsx`** — the onboarding summary's two-column list of facts.
  It is *not* a list of records, so it is the demonstration of why the parts are
  still exported: it reads its labels as `scope="row"` headers. It loses
  `hover:bg-transparent` on every row, the three classes that were reproducing
  the head's type, and `py-4` on all three cells (`size="large"` now).
- **`paged-file-viewer.tsx`** — two ghost buttons and a number field become one
  `Pagination layout="compact" jump size="small"`. The words stay the product's
  through `labels`, with two keys added for the sentences the pager needs. The
  keystroke-navigation defect goes with it.

## Verification limits

jsdom applies none of StyleX's compiled CSS, so `getComputedStyle` returns
nothing there and every visual assertion in `test/table.test.tsx` is made
against the classes a style compiles to. What the board in Chromium is for is
the other half, and this change needed it twice: the first measurement run read
the wrong `<table>` in the document and reported a head with no line at all, and
the board then caught a **real** defect the tests had not — a table that renders
its own rows applies `last` explicitly, so the `:last-child` style no longer
applied and *no* body row drew a line. Both are now pinned in tests.

The container query is also beyond jsdom: the tests pin that the stacked classes
are applied and that `stack={false}` withholds them, and Chromium is where the
layout itself was read, at 320px and 640px, against the same markup.

`ReviewerMachineConfigTable`'s own story cannot render in Storybook — it reaches
`useCloudQuery` through the run-config menu and the story carries no
`PlatformContext`, which is true of it before this change as well — so that
migration was verified by the type checker and the suite rather than on screen.
What was read in a browser is the primitive it now uses.

`pageWindow` is pure and is tested as one: every page of a 40-page pager is
checked for a constant width, for containing the page you are on and both ends,
and for never hiding a single page behind a gap.

## Evidence

Intended behavior: [Shared UI primitives](../../../../specs/ui-primitives.md),
which stays `draft` with the records and the pager stated.

Inspected implementation: `packages/ui/src/table` (`table.tsx` for the columns,
`parts.tsx` for the elements, `surface.ts`, `pagination.tsx`), the two new
glyphs in `packages/ui/src/internal/glyphs.tsx`, the deleted
`packages/components/src/ui/{table,pagination}.tsx`, and the three migrated
surfaces. The table-shaped surfaces this repository holds were surveyed before
the API was chosen; the survey is what the `columns` decision rests on.

Executed validation: `pnpm --filter @lody/ui typecheck` and
`pnpm --filter @lody/ui test` (209 tests, 26 of them new in `test/table.test.tsx`
plus a new board assertion in `test/gallery.test.tsx`);
`pnpm --filter @lody/components typecheck`;
`NODE_ENV=development pnpm --filter @lody/components test`; `pnpm lint`; and
`pnpm run docs check`.

Two Chromium passes, both load-bearing. A six-case CSS probe settled the
mechanism before any of it was written: a row's inset box-shadow paints under
`border-collapse: separate` and is hidden only by an opaque cell background; a
row carries an outer focus ring; a sticky head keeps a shadow line and **loses a
border** under `collapse`; and a transparent sticky head has the rows painted
through it. A second probe read the stacked layout at 320px and 640px from one
markup.

The board was then opened under both palettes and read back off the rendered
nodes: the three row sizes measured 28 / 32 / 36 with 8 / 10 / 12px of inline
padding; a body row's line measured
`rgb(230, 232, 237) 0px -1px 0px 0px inset` and the last record `none`; the
sticky head measured `position: sticky`, `z-index: 1` and a
`rgb(247, 248, 250)` fill, which is the region rung; the head's box measured
`mixed` with one row taken and the row's fill `rgb(232, 234, 239)`; the scroller
measured `container-type: inline-size`, and at 320px the head measured
`display: none` while a cell measured `display: flex` with its label visible at
12px in `rgb(107, 114, 128)` — the same cell measuring `display: none` on its
label in the wide table. The pager was read at the start, the middle and the end
of a 40-page run and listed seven items in each.
