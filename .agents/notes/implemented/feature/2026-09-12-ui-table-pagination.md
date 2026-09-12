# UI table and pagination: records, and the way to the ones that did not fit

Status: implemented
Translation: pending

## Abstract

`@lody/ui` had no way to show records. `packages/components/src/ui/table.tsx`
was a Radix-era file that lit every row on hover — its one caller turned that
off again with `hover:bg-transparent` — and `pagination.tsx` was 90 lines with
no caller at all, left behind when the surface that used it was rewritten. This
note records why `Table` and `Pagination` are one `table` family; why a table is
the only part of this package with no surface of its own, so its single edge is
the `separator` between rows and that edge is a **border** rather than the inset
shadow every other row in the package uses; why the two row fills are the
palette's `hoverFill` and `selectedFill` rather than a mix of the surface, which
is the opposite of the call the popup family made; and why `Pagination` is one
control with a windowing rule inside it rather than a kit of parts. Base UI
ships neither component, so this family is the package's own the way `Skeleton`
and `Spinner` are. Both Radix files are deleted and their two callers migrated.

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

## Decision

**One group, `table`, for both.** A pager exists because a table did not fit,
the two sit on the same rung, and they state the same size; how dense a list of
records is has one place to change rather than two. This is the call `dialog`
makes over the Drawer — a drawer is not a dialog either, it shares the rung and
the construction. The pager's own tokens are prefixed inside the group
(`pagerGap`, `pagerHint`, `pagerJumpWidth`) the way `feedback` carries
`toastWidth` beside `spinnerSmall`. A three-token group of its own was the
alternative, and it would have let a table go quiet while its pager stayed loud.

**A table has no surface.** No background, no shadow, no radius. Every other
part in this package names a rung; a table deliberately names none, because it
is rows on whatever was already there — a page, a card, a dialog — and a table
that drew a card inside a card would be the same fill twice, which is exactly
the defect the feedback family's neutral tint had to fix. The consequence is
stated in the README and the rules: the surface around a table owns its edges.

**The head keeps the line.** The rules say `separator` is "dividers between list
and table rows only. Never around a surface, never under a header." The reading
taken here is that the header in that sentence is a heading over a surface, not
a row of column names: a head row is the row before the first record, and the
line under it is the divider to the next row, which is what the token is for. A
head separated from its records by nothing reads as the first record. This is
the one place in this change where the rules could be read the other way, and it
is written down so it can be argued rather than discovered.

**That line is a border, and only here.** Every other row in the package —
menu, accordion — draws its line with `inset 0 -1px 0`, because a `div` can.
A table is laid out by the CSS table model, where the two modes each forbid one
of the options: under `border-collapse: collapse` a row's own box-shadow is not
painted, and under `separate` a row's border is ignored. Collapse is the mode
that lets the line ride on the **row**, where `:last-child` can take it away
again, instead of on every cell in it. The package rule that "no border token
exists" is about a token and about outlining a surface, not about the mechanism
a row divider uses.

**The two fills are the palette's own.** `hoverFill` and `selectedFill` were
tuned against the page and card rungs, which is where a table sits — the rules
name them "for a row" in the same breath. The popup family derives its own from
the rung instead, and this is not an inconsistency: on the floating rung those
two collapse into the surface (`hoverFill` lands 2/255 from `raisedBackground`
in the light palette), and on the page rung they do not. This change is the
first consumer of either token.

**Hover is opt in.** `interactive` on the root, default off, is the fix for the
defect above: a table of facts is read, not operated, and a row that lights up
under the pointer and does nothing when pressed is a promise the table cannot
keep. `selected` stays a fill and nothing more — `aria-selected` belongs to a
row in a grid, and putting it on a `<tr>` inside a `<table>` is an ARIA
violation, so a table that lets a person select rows puts a `Checkbox` in one:
the thing they press and the thing that announces it are then the same thing.

**Sorting belongs to the part.** `Table.ColumnHeader` takes `sort` and
`onSortChange`; the direction is the caller's state, because only the caller
knows what the rows are actually ordered by, but the arrow, the toggle rule
(turn over the column you are on, start a new one ascending) and `aria-sort`
are the part's. Without it, two tables answer the same press differently and a
sortable header can be assembled with no mark at all — the same argument that
makes `Tabs.List` draw its own indicator.

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

**No sticky head.** A head that stays while the rows scroll needs an opaque
fill, and a table does not know its own rung — it has no background by design,
and `background: inherit` does not reach a `<thead>`. The surface that gives the
table a scrolling box is the one that knows what colour is behind it, so that is
where a sticky head belongs. Adding a `table.headBackground` token would have
given every table the wrong fill inside a card.

**No `Table.Empty`.** `Combobox.Empty` exists because a popup that opens on
nothing is still a popup; a table with no records is usually replaced by an
empty state that is not a table at all, and a row spanning columns the part
cannot count is a `colSpan` the caller has to pass anyway.

**The markdown renderer's table is not migrated.** `markdown-renderer.tsx`
renders `<table>` through Streamdown's component map, where the rows and cells
are produced by the Markdown AST and never pass through a React component this
package could supply. Migrating it means replacing the `td`/`th`/`tr` handlers
as well, which is a change to how agent output is rendered rather than to a UI
primitive, and it belongs with whoever owns that surface.

## Migrated

Two callers, and both Radix files deleted.

- **`summary-screen.tsx`** — the onboarding summary's two-column list. It loses
  `hover:bg-transparent` on every row, which the new default makes unnecessary,
  and the three classes that were reproducing the head's type
  (`text-xs font-medium text-muted-foreground`) by becoming a real
  `Table.ColumnHeader scope="row"`; `text-right` becomes `align="end"` and the
  `py-4` on all three cells becomes `size="large"` on the table. The width and
  truncation classes stay: those are the caller's layout, which the package's
  rules allow.
- **`paged-file-viewer.tsx`** — two ghost buttons and a number field become one
  `Pagination layout="compact" jump size="small"`. The words stay the product's
  through `labels`, and two keys are added for the two sentences the pager needs
  that the viewer did not have (`sessions.fileViewer.pagination` names the
  landmark, `sessions.fileViewer.position` replaces "4212 / 9214" for a screen
  reader). The keystroke-navigation defect goes with it.

## Verification limits

The same limit the menu, overlay and feedback notes record: jsdom applies none
of StyleX's compiled CSS, so `getComputedStyle` returns nothing there and every
visual assertion in `test/table.test.tsx` is made against the classes a style
compiles to. What the board in Chromium is for is the other half, and this
change needed it — the first measurement run read the wrong `<table>` in the
document and reported a head with no line at all.

`pageWindow` is pure and is tested as one: every page of a 40-page pager is
checked for a constant width, for containing the page you are on and both ends,
and for never hiding a single page behind a gap. What is not tested is a
person's finger — the pager's buttons are `Button`s, and Base UI's press
behaviour is theirs.

## Evidence

Intended behavior: [Shared UI primitives](../../../../specs/ui-primitives.md),
which stays `draft` with the records and the pager stated.

Inspected implementation: `packages/ui/src/table`, the two new glyphs in
`packages/ui/src/internal/glyphs.tsx`, the deleted
`packages/components/src/ui/{table,pagination}.tsx`, and the two migrated
surfaces.

Executed validation: `pnpm --filter @lody/ui typecheck` and
`pnpm --filter @lody/ui test` (201 tests, 18 of them new in `test/table.test.tsx`
plus one new board assertion in `test/gallery.test.tsx`);
`pnpm --filter @lody/components typecheck`;
`NODE_ENV=development pnpm --filter @lody/components test`; and
`pnpm run docs check`.

The board was opened in Chromium under both palettes and read back off the
rendered nodes: the three row sizes measured 28 / 32 / 36 with 8 / 10 / 12px of
inline padding and 4px above and below; the head row measured a 1px
`rgb(230, 232, 237)` line and the last record `rgba(0, 0, 0, 0)`, which is the
`:last-child` reading; a head cell measured 12px at weight 500 in
`rgb(107, 114, 128)` against a cell's 13px in `rgb(26, 27, 30)`; a numeric
column measured `text-align: end` with `font-variant-numeric: tabular-nums`; the
selected row measured `rgb(232, 234, 239)`, which is `selectedFill`; the sorted
column's name measured the label colour. The pager was read at the start, the
middle and the end of a 40-page run and listed seven items in each, with the
current page a 32px square on `rgb(238, 240, 243)` and the jump field 72px wide.
