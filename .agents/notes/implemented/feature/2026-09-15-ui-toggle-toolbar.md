# UI toggle and toolbar: a control that stays pressed, and the row that holds it

Status: implemented
Translation: pending
PR: https://github.com/LodyAI/Lody/pull/727

## Abstract

`@lody/ui` had a control for every value a form stores and none for the state an
interface holds without storing it — bold, wrapped lines, this filter — so
twenty-two files in `packages/components` each drew their own `aria-pressed`
button, and the fills they chose to mean "on" run to a dozen unrelated washes
(`bg-muted-foreground/20`, `bg-primary/[0.12]`, `bg-white/14`, and several that
change nothing but the text colour). This note records the family that replaces
them — `Toggle`, `ToggleGroup` and `Toolbar`, sharing one `toggle` token group —
and its single real design decision: **on is the well, not ink**, because ink is
what a control that _already sits in a well_ becomes when it is on, and a toggle
rests on nothing. It also records why a set of toggles is not a `Tabs` strip
with the track removed, and why a bar that draws nothing at all is still a
primitive. Two callers are migrated whole and the dead Radix `toggle.tsx` and
its dependency are removed; the rest of the product's pressed buttons are left
to the surfaces that own them, because a half-migrated row of controls is the
inconsistency this work exists to remove. The board showed that in the dark
palette it is the label colour rather than the fill that carries the state.

## Problem

Every rung of this system had a component except the one a person leaves pressed.

`Switch`, `Checkbox` and `Radio` cover a value a form stores. `Tabs` covers one
thing shown out of several. Neither is what a formatting bar, a file viewer's
strip of actions or a row of filter chips needs: a button that is on right now,
that has no name, belongs to no `Field.Root`, and cannot be invalid.

So the product drew its own, twenty-two files of it, and the appearances had
diverged as far as appearances can. A survey of the fills within six lines of an
`aria-pressed` attribute in `packages/components/src` finds `bg-muted`,
`bg-muted/30`, `bg-muted/40`, `bg-muted/60`, `bg-muted/80`,
`bg-muted-foreground/20`, `bg-secondary`, `bg-secondary/50`, `bg-primary/10`,
`bg-primary/15`, `bg-primary/[0.05]`, `bg-white/10` and `bg-white/14` — thirteen
answers to one question. Two of the worst are in
`sessions/session-file-content-view.tsx`, where "wrap long lines is on" and
"annotation is on" are said with `text-foreground` against
`text-muted-foreground` and nothing else: a 24px icon button whose entire state
is a shade of gray, standing in a row of eight that are never pressed.

`packages/components/src/ui/toggle.tsx` — the Radix wrapper with a `cva` of two
variants — had reached zero in-repo callers some time earlier and had not been
deleted, so `@radix-ui/react-toggle` was still a production dependency of a
package that never imported it.

## Decision

One family, one token group, `toggle`: a control that stays pressed, a set of
them answering to one value, and the bar that holds them. They are one family
for the reason `disclosure` covers three layouts of one idea — how far apart two
of these stand, and what "pressed" looks like, cannot become three decisions in
three files.

### On is the well, not ink

This is the decision the rest follows from, and it is the elevation rules read
carefully rather than literally.

`src/tokens/RULES.md` says ink is for a stored state: the primary button,
checked, on. A toggle does store a state, so the literal reading gives it ink —
`label` fill under `background` text. That reading is wrong, and the reason is
visible in the controls the rule was written for. A Switch's **off** state is
already the well: `wellBackground` under `shadow.inset`. A Checkbox's empty box
is the same. On has to leave the well, because the well is taken, and ink is
where it goes. Ink is therefore not "what a stored state looks like" — it is
what a control that already sits in a well _becomes_ when it is on.

A toggle rests on nothing at all. It is a ghost Button when it is off: no fill,
`secondaryLabel`, `hoverFill` under the pointer. The well is free, so it sinks
into it, which is also the most literal thing this system can say about a button
that went down and stayed down — depth without lines, which is the construction
rule at the top of the same file. And it is what keeps a formatting bar of eight
from reading as eight of the most important thing on the screen, which is what
eight ink-filled buttons would be.

The second half of the state is the label: `secondaryLabel` off, `label` on. A
toggle that is off is _about_ the thing it acts on; one that is on **is** the
thing. That pair matters more than it looks — see what the board showed.

A toggle also does not bob. The motion rules give a press `translateY(1px)` and
a dropped `shadow.inkEdge`, which is a raised thing going down and coming back.
This one goes down and stays, so what changes is the surface under it.

### The ladder, and where it comes from

Sizes are `mini` 24, `small` 28, `medium` 32 and `large` 36 — the control ladder
plus the 24px step a file viewer's strip of actions needs, which is the same
ladder `Button` carries. It is taken from `control` in `scales.stylex.ts` rather
than from `button`: a Button and a Toggle in one bar line up because both read
the same scale, not because one component's group reads another's, which is the
rule that keeps a menu from reaching for `field.background`.

### A set is not a strip

`ToggleGroup` and `Tabs` hold the same three words and are not the same part.

A strip picks what a person **sees**. It is a single control, so it can be — and
is — a sunken track with one thing raised out of it and one pill sliding between
the choices. A set stores what is **on**, and two of its members can be pressed
at once, which no single sliding pill can say. So a set has no track and each
member sinks on its own. Asked for one choice out of several, with `multiple`
left off, it _still_ draws no track: the same set with `multiple` on has to look
like itself, and a component that changed its construction with a boolean would
be two components sharing a name.

The size and the shape are stated once on the set and read from a context in
`src/toggle/set.ts`, the way `Tabs.List` states them for its tabs. The context
lives in its own file because both parts need it and either importing the other
to reach it would close a cycle.

### A bar that draws nothing

`Toolbar` has no fill, no shadow, no radius, and not even the line a table
draws. It is a row of controls on whatever surface the product already had
there, so a bar inside a popover is not a second surface inside one.

It is a primitive anyway, and what it is for is the keyboard. A row of eight
icon buttons is eight tab stops unless something says otherwise, and a person
tabbing past a formatting bar should pass it rather than walk it. Base UI's
composite makes the bar one stop, gives the arrow keys the walking, and steps
over a control that cannot be used rather than stopping on it. That is the whole
argument for it not being a `div` with a gap.

Two gaps say what belongs with what: `toggle.groupGap` (4) between the members
of one cluster or set, `toggle.barGap` (8) between clusters and either side of
the line between two. The line is `Separator`'s — the one line these rules allow
— and the bar states its orientation rather than the caller, so a horizontal bar
cannot end up divided the wrong way. `separator.tsx` now exports its styles so
there is one definition of that hairline rather than two.

`Toolbar.Button` is Base UI's, unstyled, the way every trigger in this package
is: joining the walk is all it does, and what arrives is `render={<Toggle …/>}`
or `render={<Button variant="ghost" …/>}`. There is no `Toolbar.Input` or
`Toolbar.Link`, though Base UI ships both: neither has an appearance of this
system's to add, and an unused part is a contract to keep in step for nothing.

### Alternatives considered

**Ink for on.** The literal reading of the rule. Rejected above; a bar of eight
would compete with the page's actual primary action, and the distinction between
"this is the thing to press" and "this option is on" would be gone.

**A `pressed` prop on `Button`.** Rejected because the state is Base UI's —
controlled and uncontrolled `pressed`, `onPressedChange`, `value` inside a
group, and `aria-pressed` — and none of it belongs to a button that acts once.
A Button that could stay pressed would carry a state most of its call sites
never use.

**A `Tabs` strip with its track suppressed.** Rejected because the two are not
one part with a flag: a strip cannot describe two members pressed at once, and
the board row that puts them side by side is there to keep the next reader from
trying it.

**`toggle` as part of the `field` group.** Rejected: nothing here takes a name,
answers to a `Field.Root` or can be invalid, and sharing the group would invite
exactly the confusion between a Switch and a Toggle this note opens with.

## What the board showed

The pressed fill resolves to `rgb(232, 234, 237)` on the light panel and
`rgb(28, 28, 28)` on the dark one, both under `shadow.inset`, measured off the
rendered nodes. Two things follow that no unit test in this package sees.

**In the dark palette the fill is a six-value step.** The board's panel is the
card rung, `hsl(0 0% 8.6%)` — `rgb(22, 22, 22)` — and the well is
`hsl(0 0% 11%)`, `rgb(28, 28, 28)`. With the inset shadow above it that reads as
recessed, but it is not what a person notices first: the label going from
`rgb(160, 160, 160)` to `rgb(255, 255, 255)` is. That is why the state is a fill
**and** a colour rather than a fill alone, and why an implementation that
changed only the background would have looked correct in the light palette and
nearly stateless in the dark one — which is precisely the defect the deleted
callers had, in reverse.

**In the light palette a pressed toggle and a `Tabs` track are the same fill,**
because they are the same rung. That is not a collision to fix; it is the point,
and it is why the board puts a set and a strip on one row. A reader sees that
the strip has a groove around all three choices and the set does not, which is
the one difference between them.

The bar rows confirmed the rest: the bar paints nothing (`background-color:
rgba(0, 0, 0, 0)`, `box-shadow: none`), its gap resolves to 8px with 4px inside
a cluster, and the separator is a 1px hairline stretched to the 28px row in both
palettes.

## Migration

Two surfaces, each migrated whole, and between them they exercise every part of
the family:

- **`tasks/task-body-selection-toolbar.tsx`** — the whole bar. `role="toolbar"`
  and a hand-built `ToolbarButton` become `Toolbar.Root`, two `Toolbar.Group`
  clusters, `Toolbar.Separator`, and `FormatToggle` / `FormatAction` composing a
  `Toggle` and a ghost `Button` through `render`. The link sub-state's bare
  `<input>` becomes an `Input`. The bar is now one tab stop; it was nine.
  `onPointerDown` preventDefault — the thing that keeps the editor's selection
  alive — passes straight through to the composed control.
- **`tasks/tasks-workspace.tsx`** — the set. The "Show" chips in the view menu
  were already commented as "toggles, not menu items"; they are now a
  `ToggleGroup multiple wrap`. `toggleProperty` became `setVisibleProperties`,
  because a set reports every pressed member rather than the one that changed.

`packages/components/src/ui/toggle.tsx` is deleted and `@radix-ui/react-toggle`
removed from `packages/components/package.json`, per the rule that a Radix file
goes when its in-repo callers reach zero. The lockfile entries were removed by
hand rather than by re-resolving: `pnpm install --lockfile-only` on this branch
also re-resolves `esbuild`, `better-auth` and `@stylexjs/unplugin` for unrelated
reasons, and a 137-line lockfile diff for a 3-line removal is not reviewable.
`pnpm install --frozen-lockfile` passes on the hand-edited file.

### Deliberately not done

- **The remaining twenty files that render `aria-pressed`.** Most are not
  toggles wearing a disguise — a selected machine tab, a theme tile, a row in a
  multi-select mode — and each needs its own decision about whether the thing is
  a pressed control, a selected row or a radio. Migrating them by pattern-match
  would put a well under a 200px card.
- **The file viewer's action strip.** `session-file-content-view.tsx` holds the
  two toggles whose whole state is a shade of gray, and they are the clearest
  case this family has. They were migrated and then reverted: they sit in a row
  of eight 24px buttons whose glyphs are 14px, and an icon-only control here
  draws a 16px box, so moving two of eight puts two glyph sizes in one row —
  the inconsistency this work exists to remove. The row has to move together,
  and it cannot yet: its Save button turns `status-warning` while there are
  unsaved edits, and these rules give `warning` to an outcome rather than to a
  control a person presses. What an unsaved save button should look like is a
  product decision, not this package's.
- **The formatting bar's own surface.** `Toolbar` draws nothing, so the
  popover's `rounded-lg border bg-popover shadow-md` stays on the caller. It
  should become the floating rung when ProseKit's `InlinePopover` is reconciled
  with this package's `Popover`; it is a border this system does not have.
- **`open-source-attributions.generated.ts` and `THIRD_PARTY_NOTICES.md`.**
  Removing the dependency makes them stale by two entries, and regenerating them
  produces a 12,484-line diff: the file was last generated on 2026-09-04 and the
  dependency tree has moved a long way since. That regeneration is its own
  change.
- **A focus sample on the board.** The ring is on the board as `toggle.ring` and
  `toggle.ringWidth`; a focused sample would need the board to hold focus, which
  no other section does either.

### The seam this migration sits on

Worth writing down because it will be read as a defect: the package's rungs and
the product's Tailwind surfaces are not the same palette yet, and a well-rung
control placed on a Tailwind surface can land on its own colour.

The "Show" set is inside a Radix `DropdownMenuContent`, whose fill in the
product's dark theme is `--popover: 220 54% 11.5%`
(`packages/components/src/tailwind/index.css`). The package's well is
`hsl(0 0% 11%)`. Those are half a percent of lightness apart, so on that one
surface a pressed chip is carried almost entirely by its label going from
`secondaryLabel` to `label`, plus the inset shadow's top edge — not by the fill.

This is the staged migration's general seam rather than anything this family
introduces: every `Input` already placed inside a Radix popover has it, and it
closes when that menu becomes this package's `Menu`, which puts the chips on the
floating rung (`hsl(0 0% 13.7%)`) where an 11% well reads as sunken. It is also
the second reason the pressed state is a fill **and** a colour: the colour is
what survives a surface the package did not choose.

## Verification

- `pnpm --filter @lody/ui test` — 276 tests, 22 files, all passing, including
  the 13 new ones in `test/toggle.test.tsx` and the board's token coverage.
- `pnpm --filter @lody/ui typecheck` and `pnpm --filter @lody/components
typecheck` are clean.
- The board was read in Chromium at both palettes, and the resolved values above
  were measured off the rendered nodes rather than copied from the tokens.

Limits: the two migrated surfaces were verified by type checking and by the
primitives' own tests, not by driving them in the running app — the formatting
bar lives inside a ProseKit inline popover anchored to a live text selection,
which neither the package's jsdom suite nor its board can produce. The pressed
appearance those callers now get is the appearance the board shows, since it is
the same component; what is unverified is the layout around it, and the fill's
reading on the Tailwind surface described above.
