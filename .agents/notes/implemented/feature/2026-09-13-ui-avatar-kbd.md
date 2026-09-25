# UI avatar and kbd: two parts that stand for something outside the interface

Status: implemented
Translation: pending
PR: https://github.com/LodyAI/Lody/pull/678

## Abstract

`@lody/ui` had every part that acts, reports or opens, and nothing for the two
things an interface has to name but does not own: a person, and a key on their
keyboard. `avatar.tsx` was a Radix wrapper with one size, `size-8`, and of its
twenty-seven call sites twenty-one named a box and fifteen also named a type
step for the letters — `h-5 w-5 text-[9px]`, `h-7 w-7 text-[11px]`, `h-16 w-16
text-xl` — which is two facts a surface had to keep in step, at eight different
sizes. `kbd.tsx` reached the surface it sat on with a descendant selector
StyleX cannot express. This note records why both take the gray ramp; why an
avatar's rung picks its own letters and why those letters take `label` rather
than `secondaryLabel`; why a person is a circle and a workspace is a tile; why
a component token group, not a selector, is how a tooltip tells a key cap that
it has inverted; and the layout defect the board found that no unit test in
this package could have. Twenty-seven avatar call sites and four key-cap files
are migrated, `avatar.tsx` and `kbd.tsx` are deleted, and one Radix tooltip
moved with them because the cap inside it would otherwise have gone unreadable.

## Problem

Two files, and each reaching outside the rules in a different direction.

`avatar.tsx` was `relative flex size-8 shrink-0 overflow-hidden rounded-full`
with a `bg-muted` fallback. One size, so every caller brought its own: of
twenty-seven call sites, twenty-one named a box inline and fifteen also named a
type step for the letters — `text-[8px]`, `text-[9px]`, `text-[10px]`,
`text-[11px]`, `text-[12px]`, `text-[0.55rem]`, `text-[0.6rem]`,
`text-[0.72rem]`, `text-[0.82rem]`, `text-xs`, `text-xl` — the rest passing one
through a variable or a second wrapper. That is not a missing size prop; it is
two facts a surface had to keep in step, and the sizes themselves had drifted
into 16, 18, 20, 24, 28, 32, 36 and 64 with no decision behind the gaps. Four
callers also restated the fill through `fallbackClassName` (`bg-muted` twice,
`bg-sidebar-hover/60`, `bg-primary/10 text-primary`), the last of which put the
accent — which these rules reserve for live state — under a static portrait.

`kbd.tsx` was closer to right: a gray chip, no hover, no focus ring. Its one
problem was the one that does not survive the move off Tailwind. A cap on a
tooltip has to invert, because the tooltip is the one surface in this system
that does, and it said so with
`[[data-slot=tooltip-content]_&]:bg-background/20`. StyleX has no descendant
selector, so the rule had to be re-founded rather than translated.

## Decision

**Two components, two token groups, one question.** They are not a family: they
share no measurement, no state and no structure. What they share is that
neither stands for anything *in* this interface — one stands for a person, the
other for a piece of hardware — and that is exactly the condition the rules
already attach to the gray ramp: "`gray…gray6` only for things with no role."
`Skeleton` was already there. These two join it, and the rule's list grew by
one rather than the palette growing.

### The avatar

**The rung picks the letters.** Five rungs — 16, 20, 24, 32, 64 — and each
carries its own type step and its own glyph box. This is the whole reason the
size is a prop rather than a class: a box and a type step stated separately are
two facts that can disagree, and across twenty-seven call sites they had. The
ladder is deliberately not the control ladder's 28/32/36: an avatar in a row is
a mark beside text rather than a control, and the sizes the product had reached
for between 32 and 64 (36, and a 28-vs-32 conditional in the AI GUI) were a row
avatar that had drifted rather than a third kind of thing. Everything at 28 and
36 landed on `large`; 18 landed on `small`.

**A person is a circle, a thing is a tile.** `WorkspaceAvatar` was a circle
everywhere except the mobile switcher sheet, which passed `rounded-xl`. A
circle around a logo is a crop, and the mark inside one was drawn square, so
the shape follows what is being stood in for rather than the surface it is on.
The tile's corner is the radius-by-size table read per rung — 5, 5, 8, 10, 14 —
rather than a token of its own; the circle takes `radius.full` on
`corner.round`, because the rules already say a squircle at that radius is a
superellipse and would turn a face into a rounded square.

**The letters take `label`, not `secondaryLabel`,** and the board is what
settled it. The first draft copied Badge's reading — metadata is *about* the
thing beside it — but initials are not about a person; they are what is left of
one. Measured on `gray5`, `secondaryLabel` is 3.5:1 in the light palette, under
the 4.5:1 that 8-to-11px letters need. `label` clears it in both palettes.

**The fill is a gray rather than a film.** A Badge can be a tint over whatever
holds it because a word reads through a tint. What an avatar stands in for is a
photograph; a translucent face would show a sidebar row's hover through it and
change colour as the pointer moved.

**An identity colour is the product's.** `WorkspaceAvatar` derives a hue from
the workspace name so one workspace is one colour on every screen. Which hue
belongs to which name is not a token — no palette can hold it, and the recipe
is already shared with the mobile initial-letter avatar — so it arrives as a
`style`, and `Avatar.Fallback` is the one part in this package that *merges* a
caller's `style` rather than replacing it. Unifying the two copies of the hash
recipe is a separate decision and is not made here.

### The key cap

**A cap is not a menu row's shortcut.** The rules give that slot plain trailing
metadata in `popup.hint`, and that stays: a menu row already carries a leading
box, a label and a chevron, and a column of chips down its right edge turns a
quiet list into a keyboard diagram. A cap is for the surfaces where the keys
are the subject — the command palette's footer, a tooltip that teaches one.

**A component token group is how a surface tells what is inside it what it is
standing on.** This is the replacement for the deleted descendant selector, and
it is better rather than merely possible: `Tooltip.Content` declares
`kbdOnInvertedTheme` on its own popup, every cap under it inherits through the
cascade, and unlike a `[data-slot]` selector it also reaches a cap a caller
wrapped in something of their own. It is the same mechanism `ThemeRoot` already
uses to carry a forced palette across a portal. The theme re-declares exactly
two values — the film and the letters — so a cap on a chip is the same cap,
made of different things, rather than a second cap.

**The face is the UI font.** `<kbd>` defaults to monospace, and `⌘`, `⇧` and `↵`
are drawn by the product font here; a cap that fell back to the mono stack
would render a different glyph from the identical character in the label beside
it.

## What the board showed

Both defects below are invisible to this package's tests, because jsdom applies
none of StyleX's CSS. They were found by opening the gallery in Chromium, which
is why that step is not optional for a change here.

**A fixed size is not a fixed size on a flex item.** A 16px circle holding two
initials laid out **20px wide** and stopped being a circle. A flex item's
automatic minimum size is its content's, and an avatar is always in a row of
something; `width` loses to it. The box and the fallback inside it both declare
`min-width: 0`, so the width is the fact and anything wider than it is cropped
— an avatar is a ceiling as well as a floor. `test/avatar.test.tsx` pins the declaration,
which is the most a test in this package can do about it.

**The contrast failure above** was read off the rendered swatches in the light
palette, not reasoned about: the board prints what a token resolved to.

**Two capitals did not fit the smallest circle.** At the first draft's 8px step,
`WW` measures exactly 16px against a 16px circle: the widest pair of capitals
was flush with the crop and lost its outer strokes on both sides. The step
moved to 7px, which measures 14px and leaves a pixel either side. Two letters
barely belong in a circle that small at all — the board's legend and the README
both say a `mini` avatar wants a picture or a mark first — but small beats cut,
and the product's `mini` callers (an archived session's owner, a chat member, a
GitHub login) all pass two characters.

## Migration

Twenty-seven avatar call sites, four key-cap files, and two Radix files
deleted.

`UserAvatar` and `WorkspaceAvatar` keep their names and their blob-cache
strategy, and now take a `size` instead of a box class; `fallbackClassName` is
gone, because everything it carried — a type step, `bg-muted`,
`bg-sidebar-hover/60`, `bg-primary/10 text-primary` — is the package's decision
now. `pr-tab-view.tsx` had a third local avatar with its own `xs`/`sm`/`md`
ladder and three hand-tuned type steps; it now takes the package's rungs.
`usage-calendar-visualization.tsx` and `github-comment-thread.tsx` used the
Radix parts directly and now use `Avatar.Root`/`Image`/`Fallback`.

`components/commands/kbd.tsx` keeps the one thing that is genuinely the
product's — splitting a binding string in Lody's registry syntax into keys —
and draws the caps with the package's.

**One Radix tooltip moved with the caps.** `SidebarNewTaskButton` in
`loro-sidebar.tsx` is the only surface that puts a `Kbd` inside a tooltip, and
that tooltip was Radix's: leaving it there would have left a gray cap on a dark
chip with its letters gone, since only `@lody/ui`'s `Tooltip.Content` declares
the inverted theme. Migrating one tooltip was cheaper and more honest than
shipping an unreadable one or deferring the cap.

### Deliberately not done

- **The hashed identity hue is still written twice**, here and in
  `MobileInitialLetterAvatar`. Moving it into the package would make the
  package own a brand colour, which is a product decision rather than a
  migration.
- **The remaining Radix tooltips stay.** Only the one holding a key cap had a
  reason to move in this change.
- **`ScrollArea`, `Toggle`, `ToggleGroup` and `Toolbar`** are the Base UI parts
  still unmigrated; the scroll area in particular has thirteen callers and a
  wide class-based API, and belongs in its own change.

## Follow-up: CI caught the suite waiting on scheduler luck

`select.test.tsx`'s "End walks to the last row" failed once on CI and passed on
the commit before it, on a change that touched only the gallery and two
documents. It was not a regression and it was not the component: `dom.tsx`
settles every interaction with a **fixed two animation frames**, which is enough
on an idle machine and is otherwise exactly the "scheduler luck" the root
testing rule forbids. Base UI schedules part of a popup's state on its own
animation frame, so how many frames an interaction needs is a property of the
machine that ran it — at one frame a *different* test in the same file fails
than at two, which is how the fragility was measured rather than guessed.

The keyboard tests in that file all press a key immediately after opening the
list; the failing one was the only one that did not first state the precondition
the others assert. A probe showed why that matters: moving focus off a row
clears every `data-highlighted` mark, so a key arriving a beat early finds a
list with no active row and does nothing — which is the failure CI reported.

`dom.tsx` gains `until(ready, what)`, a bounded wait on an explicit condition
that throws with what it was waiting for, and the test states its precondition
and both of its effects through it. Verified by running the suite with the frame
budget cut to one, which is the stress proxy: before, the select file failed
there; after, all 244 pass. At zero frames the menu suite fails wholesale, which
is not load but a popup never opening — the proxy has a floor.

## Verification

`pnpm --filter @lody/ui typecheck` and `pnpm --filter @lody/ui test` (243
tests, including nine for `Avatar`, seven for `Kbd`, and two added board
assertions). `pnpm --filter @lody/components exec tsc --noEmit` and
`NODE_ENV=development pnpm --filter @lody/components test`.

The board was opened in Chromium at both palettes and read back with
`getComputedStyle`: every rung measures square at its stated size, the tile
corners step 5/5/8/10/14, and a cap on the tooltip chip resolves to a film of
the chip's own ink in both palettes. The migrated `AvatarEditor` story was
rendered as well.

Not verified: no product surface was driven end to end in the desktop app, and
the mobile surfaces that changed rung (the workspace switcher sheet, the home
header chip) were read from the code rather than rendered.
