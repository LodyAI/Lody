# UI card, badge and separator: three answers to "what is an edge?"

Status: implemented
Translation: pending

## Abstract

`@lody/ui` had every part that reports, acts or opens, and nothing for the
furniture a page is made of while nothing is happening. `card.tsx` was
`rounded-lg border border-border shadow-xs` — a border in a system whose first
rule is that no border token exists — `badge.tsx` was a `cva` whose default
variant filled the chip with the colour these rules give a stored value, and
`separator.tsx` was a Radix wrapper that defaulted to `decorative`, which is
`role="none"`. This note records why the three are three components and not one
family; why Card takes a Dialog's parts and its own token group; why a Badge is
the one part of this system on **no rung**, which makes its tone a film rather
than a fill and keeps its words ink in every tone; why a Separator gets no token
group at all; and what the board showed that the tokens could not. Twenty-nine
surfaces are migrated, `badge.tsx` and `separator.tsx` are deleted, and the four
Card callers that are not cards are recorded rather than forced.

## Problem

Three files, three vocabularies, and each one reaching outside the rules in a
different direction.

`card.tsx` was `rounded-lg border border-border bg-card shadow-xs` with `p-6` on
every section. The border is the thing this system does not have: the first line
of `RULES.md` is "depth without lines", and a card's edge is `shadow.card`. Its
title was `text-2xl font-semibold` — 24px, which is not on this type scale at
all — and its padding was stated three times, once per section, so a card whose
content had to meet its own edge (a table) fought `p-6 pt-0` with `p-0`.

`badge.tsx` was a `cva` with six variants, and the default filled the chip with
`bg-primary text-primary-foreground shadow-sm` plus `hover:bg-primary/80` and a
focus ring. Every one of those is wrong here rather than merely different: ink
is what the rules give a *stored value* — a primary button, a checked box — so a
badge wearing it invited a press it does not answer, and a chip with a hover and
a focus ring claims to be a control. Two more variants, `secondary` and
`outline`, were two answers to a question this system does not ask, because
there is no border to outline with. The product knew it: of 44 call sites, 38
overrode the size (`px-1.5 py-0 text-[10px]`, `h-5`, `text-[9px]`), and the
onboarding screen had grown a `PROVIDER_STATUS_CHIP` constant plus four
hand-mixed colour pairs — `border-amber-500/40 bg-amber-500/10 text-amber-600
dark:text-amber-400` — for statuses the palette now names.

`separator.tsx` defaulted to `decorative`, which renders `role="none"`. That
default is right for a library used to draw lines for looks; it is wrong here,
where the rules allow a line in exactly one place — between the rows of a list
or a table — and that place is structural by definition. Three of its four
callers also restated its colour (`bg-border/60`, `bg-sidebar-border`).

## Decision

**Three components, two token groups, and one with none.** They are not a
family. The family test this package uses is whether what differs is the
arrangement rather than what a thing is made of — the test that makes `field`
cover a checkbox and a Select trigger. A card, a badge and a line fail it in
both directions: they share no colour, no measurement and no state. What they
do share is a question, and three different answers to it. A card's edge is the
shadow that lifts it off the page. A badge has no edge, because it is on no rung
and cannot have one. A separator *is* an edge, and it is the only one the rules
allow.

### Card

**A Card is a Dialog's panel one rung down, and takes the same parts.** A
header, the body a caller writes, the answers; `headerGap` inside the heading
block, `footerGap` between the answers, the footer reversed on a narrow window.
What separates the two is the rung and the heading step, not what either is made
of — which is exactly the argument that made Dialog, AlertDialog and Drawer one
family — so reproducing that structure is cheaper to learn than inventing a
second one.

**It does not read `dialog`, though.** Every value except the title step is
currently identical, and sharing the group would still be wrong for the reason
the rules give for a menu not reading `field.background`: it would be naming the
wrong thing to get the right value, and the day either rung moves, one of the
two surfaces silently follows the other. `card` is its own group.

**The title is `headline`, and the auth pages shrink.** The rules put a dialog's
title at `headline` and reserve `title` for a page that is a page. Seven of the
eight migrated pages set `text-2xl font-bold` on it, and 24px is not a step on
this scale; their headings are now 16px at weight 600. This is the redesign the
spec asks for rather than an accident of migration, and it is the most visible
single change in this diff.

**A card does not nest, and the board proves it rather than claiming it.** In
the light palette `elevatedBackground` and `background` are the same white, so a
card inside a card is one fill twice and a shadow. The board's own sample panels
are cards, which is why the dark screenshot shows the sample card separated from
its panel by nothing but its shadow. A block inside a card is the region rung,
which a surface lays out; it is not a smaller Card.

**`interactive` marks the card; it does not make one.** The card takes the
pointer's fill and a pointer cursor, and the caller still brings the `<button>`
or the link — what a press *does* (navigate, select, open) is a product
decision, and a component that rendered its own control would have made it. Only
the fill changes: a card that lifted on hover would be claiming a rung it is not
on.

**`card.hover` is not the rung the ladder named, and that is measured.** The
elevation table listed "hover on a card" under the region rung, and in the dark
palette `secondaryBackground` and `elevatedBackground` are both `hsl(0 0% 8.6%)`
— the hover would have been invisible in exactly one of the two palettes, which
is the same trap the rules already record for `hoverFill` on the floating rung.
It mixes the rung toward `label` at 4% instead: the derivation `popup.highlight`
uses at 6% for a row and a secondary Button uses at 4% for itself, at the
Button's strength because a card is a large area and a row's step over one reads
as a fill. Measured in Chromium, rest and hover are `#ffffff` and
`oklab(0.9689 …)` in the light palette and `rgb(22,22,22)` against
`oklab(0.2322 …)` in the dark one. The ladder's table was corrected to match.

### Badge

**A badge is on no rung, and everything else follows from that.** It appears on
a page, on a card, inside a menu row a person has opened, and on a modal panel.
Three of those six rungs are surfaces whose named fills the rules already record
as collapsing — `hoverFill` lands 2/255 from `raisedBackground` in the light
palette, `selectedFill` resolves to exactly `raisedBackground` in the dark one —
so a badge that took a background from the ladder would be invisible somewhere
by construction. Its fill is a **film**: the tone at 8% of `label` or 14% of an
outcome colour over whatever is underneath, which is the form
`Button`'s destructive ghost hover already takes. One declaration, every rung,
both palettes. The board carries the same five badges on the page, the card and
the floating rung for exactly this reason.

**The words stay ink in every tone, and that is measured rather than
preferred.** The obvious design is the product's current one: colour the text
with the tone. In the light palette `warning` is `hsl(32 90% 48%)`, which is
2.8:1 on a near-white surface — a colour tuned for a 16px mark, where the
contrast bar is 3:1, used as 11px text, where it is 4.5:1. It would have been
the one place this palette is used below what a person needs. An Alert can
afford a coloured mark because the mark is a graphic; a badge is only words. And
it does not need the colour to be legible as a *kind*, because unlike an Alert's
mark a badge is never wordless: the tint carries the tone and the word carries
the fact. `badge.label` is `secondaryLabel` for all five tones, which is also
what most callers had already written by hand as `text-muted-foreground`.

**Five tones, and the fifth is `running`.** The four outcomes are the message
family's, imported as its type so the vocabulary cannot drift into two; the
fifth is the one `Progress` adds, for the same reason and by the same name. A
machine being reached, a screen being opened, a checkout in flight — that is
live state, which is what the rules give `accent` to. It has real callers: the
onboarding screen's in-progress chip and the desktop hand-off page both said
this in `bg-primary/10 text-primary` before.

**There is no tone mark, and the leading box is the caller's.** An Alert draws
its own mark because a tone is the entire point of a message and a caller free
to choose a glyph can put a tick on a failure. A badge's glyph is doing a
different job: it identifies the *thing* — a lock beside "Private", a laptop
beside an OS, a spinner beside "Opening" — which is what a menu row's leading
box holds, and this is that box at a badge's scale. A tick beside the word
"Verified" would have said nothing the word does not.

**It neither grows nor shrinks, and a surface that must cap one caps the
badge.** This is the rule the menu's trailing shortcut already follows: what is
beside it is the thing, and the badge is the note about it. The board revealed
the consequence — a clamp on a *box around* a badge does nothing, because
`flex-shrink: 0` means the chip keeps its content's width and overflows that box
instead of ellipsing inside it. The board's sample was wrong in exactly that way
and now clamps the badge, where the ellipsis appears (96px box, 138px of text).
The one product caller that caps a badge, `machine-quota-compact.tsx`, had
already put its `max-w-[180px]` in the right place.

### Separator

**It gets no token group.** Every other component in this package derives its
edge from tokens that say which rung it is on. This one *is* the edge:
`separator` is already the semantic name for "the next row starts here", and a
`separator.color` pointing at it would be a second name for one fact — the drift
`RULES.md` warns about — with a `createTheme` entry to keep in step for nothing.
The hairline is the same 1px the popup's own row divider takes.

**It is announced, and there is no `decorative` prop.** Base UI renders
`role="separator"` with the orientation and offers no escape hatch, which is the
right default here rather than a limitation to work around: a line in this
system is never decoration, because the only place it is allowed is structural.

**It carries no margin, and a vertical one stretches.** Where a line sits in a
stack is the surface's layout — the popup's divider has margins only because it
must bleed through an inset the caller cannot see. A vertical line takes
`align-self: stretch` rather than `height: 100%`, because its row is a flex
container and a percentage height there resolves against a height the row has
not got. Measured on the board: 1px wide, 28px tall beside two 28px buttons.

## Migrated

Twenty-nine surfaces, and two Radix files deleted (`badge.tsx`,
`separator.tsx`) with their barrel exports and the now-unused
`@radix-ui/react-separator` dependency.

- **Card** — eight auth, onboarding and hand-off pages, plus the settings
  category grid, which is the one `interactive` caller and dropped
  `hover:bg-hover transition-colors cursor-pointer` for the prop. Two pages also
  dropped bespoke chrome the primitive now owns: `rounded-2xl`,
  `border-border/60`, `shadow-[0_20px_60px_-30px_rgba(0,0,0,0.25)]` and `px-8
  pt-11`. Every `CardContent` wrapper went: the card's own `gap` does what its
  `p-6 pt-0` was for.
- **Card, removed rather than migrated** — `session-conversation-page.tsx` used
  `CardHeader` as a bare flex container with a `border-b`, overriding all four
  of its declarations. It is a `<div>` now. That is not a card, and a component
  used for its layout only is a dependency for nothing.
- **Badge** — twenty-one files, 44 call sites. Every size override went (38 of
  them), `PROVIDER_STATUS_CHIP` and its four hand-mixed colour pairs became four
  tones, and `PRIORITY_META` in the AI GUI lost the three
  `border-status-*/20 bg-status-*/[0.15] text-status-*` triples it was carrying
  for high, medium and low. The `secondary` / `outline` split disappeared
  wherever it was decorative; where it carried meaning it became a tone — a paid
  invoice is `success` and a checkout in flight is `running`.
- **Separator** — four, three of which were restating its colour.

## Deliberately not done

**`billing-setting-pure.tsx` keeps the old Card, and it is the file that needs a
sixth decision.** Its nine cards are four things: sections (`p-5`), a tinted
callout with an icon and a sentence (`border-primary/30 bg-primary/5 p-4`, which
is an `Alert`), a summary row, and three that hold tables with
`overflow-hidden`. The last group needs a **flush** card — no padding, corners
that clip their content — which is a real axis this system does not have yet,
and inventing it for one unreviewed file is how an axis arrives without a rule
behind it. The callouts want the Alert this package already has. Both belong in
a change that can be read against that file.

**Two surfaces use Card for a rung it is not.**
`device-resource-monitor.tsx` builds stat tiles with `bg-card/40 p-2
shadow-none` and `floating-permission-request.tsx` uses it as a conversation
panel with `CONVERSATION_PANEL_FRAME_CLASS`. Neither is on the card rung —
they are the region rung and a product frame — so migrating them to `Card` would
be using the primitive to get a box, which is what the note above says not to
do. They are the next candidates for a region surface, if one is ever worth a
primitive.

**`ChatComposer.stories.tsx`** wraps the composer in a glass card
(`rounded-[32px] bg-white/5 ring-1 backdrop-blur-2xl`) that exists to photograph
the composer on a marketing background. It is a story, not a surface.

**`packages/code-review-helper` keeps its own `separator.tsx`.** It is a
separate package with its own viewer packaging rules and its own Radix
dependency; nothing here reaches into it.

## Verification limits

The two every note in this series records. jsdom applies none of StyleX's
compiled CSS, so `getComputedStyle` returns nothing and every visual assertion
in the suite is made against the classes a style compiles to; the values in this
note were read in Chromium off the rendered board. And a `color-mix` with
`transparent` is resolved by the browser, not by the test — the films are
`oklab(… / 0.08)` and `oklab(… / 0.14)` there, and a test can only pin that the
five tones compile to five different classes over one shared chip.

One limit is specific here. A Card's hover and an interactive card's cursor are
the only states either primitive has, and neither is reachable in jsdom; the
hover was driven with a real pointer on the board instead. Nothing about a Badge
or a Separator has a state at all, which is the point of both.

## Evidence

Intended behavior: [Shared UI primitives](../../../../specs/ui-primitives.md),
which stays `draft` with the block, the standing fact and the line stated.

Inspected implementation: `packages/ui/src/{card,badge,separator}`, the corrected
region row in `packages/ui/src/tokens/RULES.md`, the deleted
`packages/components/src/ui/{badge,separator}.tsx`, and the twenty-nine migrated
surfaces.

Executed validation: `pnpm --filter @lody/ui typecheck` and
`pnpm --filter @lody/ui test` (200 tests, 15 of them new across
`test/card.test.tsx`, `test/badge.test.tsx` and `test/separator.test.tsx`, plus
two new board tests); `pnpm --filter @lody/components typecheck`;
`NODE_ENV=development pnpm --filter @lody/components test` (3306 tests, with one
unrelated teardown race in `tests/acp-inline-selector-group-ui.test.ts` that
passes when run alone — React's scheduler finishing work after the environment
is torn down under parallel load, in a file that touches none of these three);
`pnpm --filter @lody/site-docs typecheck`; `pnpm lint`, `pnpm format`,
`pnpm lint:i18n`, `pnpm check:platform-boundaries`,
`pnpm check:public-boundary` and `pnpm run docs check`. `pnpm check`'s own test
leg fails here for the reason this worktree always does — React 19 exports `act`
only from its development build, so the suite needs `NODE_ENV=development`.

The board was opened in Chromium under both palettes and driven there. The card
measured a 14px squircle on `elevatedBackground` under `shadow.card` with 16px
padding and gap, its title at 16/24 weight 600 and its description at 14/20; the
interactive one measured `#ffffff` at rest against `oklab(0.9689 …)` under a
real pointer in the light palette, and `rgb(22,22,22)` against
`oklab(0.2322 …)` in the dark. The five badges measured 20px tall at a 5px
squircle with 6px inline padding, 11/16 text at weight 500 in
`rgb(107,114,128)`, over films at 8% and 14% alpha, on all three rungs and in
both palettes; a caller's glyph measured 12×12 inside its box; the clamped one
reported 96px of box against 138px of text. The separator measured 1px in both
axes, `rgb(230,232,237)` in the light palette and `rgb(40,40,40)` in the dark,
stretched to its row's 28px when vertical.
