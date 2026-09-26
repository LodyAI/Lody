# The session info card on a v2 preview card

Status: implemented
Translation: current

[中文版](2026-09-26-session-preview-card.zh.md)

## Abstract

The card that opens when the pointer rests on a sidebar conversation was the
last floating surface still drawn outside `@lody/ui`: a Radix popover with the
sidebar's grey fill, a 0.5px hairline, a pill for "Worktree" and tinted boxes
around CI. Beside the v2 menus and popovers it read as another material. `@lody/ui`
gains `PreviewCard`, Base UI's hover card on the popover's surface, and the
session card moves onto it in StyleX: one fact per row and one status
line, with no border, pills or fills. The hover timing the sidebar
depends on stays in the product component unchanged, and `@radix-ui/react-popover` leaves `@lody/components`.

## Problem

`session-info-hover-card.tsx` drew its own surface: `--sidebar-background`, an
edge mixed from it, and a two-step drop shadow. Every other floating part reads
`popup` from `@lody/ui` (the raised background, `shadow.popover`, 14px corners,
no line), so the most frequently seen popup in the app was the one that did not
match. Inside it, the worktree state was said twice (the glyph and a `Badge`),
the visibility row was the only bold one, and CI sat in a
`bg-muted-foreground/[0.06]` box, which on a floating surface is a second surface.
It was also the only remaining importer of `@radix-ui/react-popover` in the
package.

## Decision

**A preview card is a popover's surface opened by a resting pointer.**
`PreviewCard.Content` assembles Base UI's `preview-card` portal, positioner and
popup with exactly the popover's classes (`surface.popup` + `surface.popupPanel`),
the forced-palette handoff and the popup-container mount point. No token was
added. It differs from `Popover` only in the way in: it takes no focus and has
no dialog role, since a pointer sweeping a list passes over it.

**The hover intent stays the product's.** Base UI's trigger has per-trigger
delays, but the sidebar needs a warm-up only on the first hover, instant opens
while warm, a single open card across the app, and press suppression. The
press suppression prevents a card from mounting in the commit that switches
conversations (see the existing test). The component keeps those timers,
controls `Root open`, and names its row with `Content anchor={ref}`. The
`PreviewCard.createHandle` pattern (one card, many triggers) could replace the
single-card bookkeeping. It would need every row caller to change, so it is not
done here.

**The machine card shares the shell.** `SidebarHoverCard` (the timers above,
controlling `Root open`) is shared by conversation rows and machine group
headers, so one card is open across both. Both cards now sit on the preview
card's surface: the machine card dropped its own sidebar-grey frame and lays
out its rows only. Its contents are not restyled here.

**A run down the list swaps cards in place.** Every row owns its card, so
moving from row to row closed one card and opened the next. On the popover's
surface both faded, and the owner found that running the pointer over several
rows made the card fade in and out without end, so it could not be read.
`PreviewCard.Content` gained `noAnimation` (as Dialog has): no hidden end and
`transition-property: none`. A zero duration was not enough, because a card
replaced during its own fade-in kept that fade running and stayed on screen
beside the next one. `SidebarHoverCard` sets it for a warm open and for the
card handed off to another. Only the first card after the warm-up fades in,
and only the last one, left for empty space, fades out. The Storybook story
`HoverAcrossRows`, sampled in Chromium, shows one card at full opacity 30ms
after each row change.

**The card's contents: one kind of fact per row, in reading order.** Each row
has a 14px mark in one column and its value in ink at the footnote step:

1. Where the work lives: the repository behind its owner's avatar, or the
   local folder behind a folder glyph.
2. The branch, in the monospace face and copyable. Its glyph says worktree or
   plain branch, so there is no "Worktree" word or `Badge`.
3. Whose it is and on which machine, as one row: the author behind their
   avatar, then the machine behind a small monitor glyph in the secondary
   label. A solo workspace passes no author and the row is the machine alone.
4. Who may open it: the visibility word behind its glyph. Its explanation is
   the word's `title`, not a second line.

Under the one `Separator` is **one status line**: the PR glyph in its state's
tone, `#128` and the state word (pressing it opens the PR), the CI verdict as
one tone-coloured mark with its words, and the diff at the end. CI jobs are
not listed; the PR tab owns them. While jobs run, the settled count replaces
the words ("CI 1/3" behind the amber mark), so the line fits in English too.

**Why it felt cramped, and what changed.** The owner said the card felt
局促. Measured, it was not the row count: the card was sized to its content
(`max-content` between 15rem and 21rem), so its right edge hugged the longest
row and the diff ran into the CI verdict; rows sat at 12px on a 16px leading
(1.33), where Han text closes up; the machine followed its author 6px away.
The card is now a fixed 18rem, rows take an 18px leading (1.5) with the same
4px gap, the title sits 12px above the rows, and the machine sits 12px after
its author. Putting the diff on the branch's row was tried and dropped: it
truncated the branch, the fact a person copies.

**What the owner rejected on the way.** The first pass kept every row but
listed CI jobs under "CI passed 3/3" (one fact said three times) and kept a
"Worktree" word that truncated the branch. The second joined repository and
branch into one path line (`repo ⑂ branch`), which read as long and messy. The
third put the branch alone and folded author, repository, machine and
visibility into one grey `a · b · c` line; the owner pointed out that a reader
then has to work out which word is which, and that author came before the
repository. Unlabelled words in a row cost more than the marks they replaced.
The marks stay because each names the kind of its row; what was dropped is
the decoration around them (the pill, the visibility paragraph, the tinted CI
box, the per-job list).

## Alternatives

- **Reuse `Popover` with a controlled `open`.** This was rejected because a
  popover is a dialog that manages focus, and every row would announce itself
  as one on hover.
- **Restyle the Radix card in Tailwind.** This was rejected because the
  components rules make rewritten styling StyleX on `@lody/ui` tokens, and it
  would keep the Radix dependency.

## Verification

- `packages/ui/test/preview-card.test.tsx` covers four things: an anchored
  controlled card opens without a dialog role and without taking focus, Escape
  asks the owner to close it, the popup carries exactly the popover's surface
  classes, and a forced palette crosses the portal.
- The existing `packages/components/tests/session-info-hover-card.test.tsx`
  press-suppression and warm-window test passes unchanged on the new surface.
- Storybook `Sessions/SessionInfoCard` was checked in Chromium, in light and
  dark, with the zh_CN locale. After the redesign, every
  standalone story was shot in light and dark: team with author, merged with CI
  running, closed with CI failing, no CI feed, long branch, local worktree,
  private local project and a bare chat. The token board's new preview-card sample opens on hover.
- `@radix-ui/react-popover` stays in the lockfile as a transitive dependency of
  `@assistant-ui/react`, and therefore in the generated attributions.
