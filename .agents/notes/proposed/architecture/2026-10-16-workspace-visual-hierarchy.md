# A hierarchy layer over the existing type roles

Status: proposed
Translation: current

[中文](2026-10-16-workspace-visual-hierarchy.zh.md)

## Abstract

Lody already has size roles, a spacing contract and three inks, but nothing says which
content takes which, so the session page chooses per component and has drifted: 164
product-text sizes ignore the Appearance setting and 54 ink fractions stand in for three
inks. This note proposes a mapping layer, not a new design system: five content tiers
(reading, evidence, process, metadata, chrome) and five rules, recorded in a draft
[Spec](../../../../specs/workspace-visual-hierarchy.md). Two zones of the session page were migrated as a
pilot, the turn's evidence cards and the composer info bar. Nothing has been run: the environment had no Node, so the pilot is unchecked by
typecheck, tests or a visual pass, and the tiers are inferred from code and have had no visual review.

## Decision

The gap is a mapping, not a value. [Interface typography](../../../../specs/interface-typography.md)
forbids a parallel scale or token family, so the layer reuses `text.*` and `colors.*` and adds
only a rule for choosing among them. Each surface names a tier; the tier fixes role, ink and
weight. Rules: every size is a role; neighbouring roles differ in a second channel; three inks; weight
names the thing and never its state; emphasis is spent once per row.

Two of these are not new. The sidebar already dropped its 11px caption because it sat one pixel
under the 12px footnote, and already moved group labels from bold to medium
([interface polish](../../implemented/feature/2026-10-16-interface-latin-font-first.md)).
`components/AGENTS.md` already says a pinned conversation is marked by a glyph, never weight.
The proposal generalises them and tests them against the busiest page.

## Pilot

The premise that Appearance should scale these sizes holds: `applyUiFontSize` sets only
`--ui-font-size`, never the root font size, so Tailwind's rem-based `text-xs` stays 12px. That is
read from code, not measured in a browser.

The session page is the most complex surface (`session-detail.tsx` and
`session-chat-interface.tsx` are about 7,000 lines each, with tabs, info bar, conversation,
composer and a tabbed side panel). The pilot takes both ends of it.

**The turn's evidence tier.** `evidenceSurface` in `ai-gui/surface.ts` holds the tier as StyleX over
existing tokens. `assistant-edited-files.tsx` and `session-file-card.tsx` named files at the reading
size (14px, regular, `foreground/90`), so the card competed with the answer above it; a name is now
13px at 500 in `label` ink, with directory, subtitle and counts quieter. In `view.tsx`, the thinking
label, the plan label and a tool title outside the timeline go from 600 to 500, and the running tool
verb's `foreground/90` becomes `label`. The four-paths-then-expand structure and the no-pill rule in
`ai-gui/AGENTS.md` are unchanged.

**The file card.** `SessionFileCardLayout` was redesigned over three rendered rounds, because the
first pass (sizes and ink only) changed nothing a reader would see. Round one made it an object: a
sheet of paper in a tray inside a bordered card. It had three concentric outlines, against the rule
of depth without lines. Round two removed those lines, and was still wrong: tray, sheet, extension,
name, size and action were six things competing, so the card outweighed the answer it sits under.
The accepted design is one 44px line on `secondaryBackground`, no outline or shadow: the name is the
only text at full ink, a fixed-width mono tag carries the extension (fixed so names align down a
list), the size is `tertiaryLabel`, and the action chip rests at `secondaryLabel`, following the
existing comment that a dimmer rest read as disabled. A pill and a two-line tile were also rendered
and dropped (too small to be a deliverable; the tile only repeated the old structure). Colour per
file kind was rejected: colour is reserved for outcomes. A failed card tints toward `destructive`;
pending and expired dim the tag; a long status string takes width before the name does, because the
status is what a person needs then, and a hover title shows the rest. Two mocks were wrong and
redone: a CSS ordering mistake rendered the extension at 9px instead of the coded 11px, and the
chip's rest tone was `tertiaryLabel` before the existing comment was read. This revisits the
"one edge treatment" choice in the earlier [interface polish](../../implemented/feature/2026-10-16-interface-latin-font-first.md)
for the file card only; the edited-files card keeps the hairline and now differs. Public props of
`SessionFileCardLayout` are unchanged, so the pending-attachment row picks it up, and the
`secondaryAction` slot is styled by the exported `SESSION_FILE_CARD_ACTION_CLASS`.

_Round four (soft paper object)._ The file card was redesigned from zero at the request of the person
owning the work, who wanted it to feel like a crafted object in an agent app rather than a list row, and
chose the sheet direction from three options (a generated cover tile, a paper sheet, a softened strip).
It returns to the shape rounds one and two rejected, so the count is held instead: a tray on
`secondaryBackground` with no outline or shadow; a `raisedBackground` sheet that carries the only
shadow (`shadow.card`, `shadow.raised` while the card is hovered or focused); a narrow portrait sheet
(`session-file-sheet.tsx`) that prints nothing and carries faint tonal ink marks drawn per file kind
(lines, indented lines, braces, a grid, a zipper, a waveform, a picture, a picture with a play mark); a
two-line body (name at full ink, "TYPE · size" or the status under it, shared with the pending row through
`formatSessionFileMeta`); and the action chip. The sheet went through three contents in this round: the
extension (a narrow sheet cannot spell four letters), a kind glyph (it made the sheet read as a badge; the
glyph map, `getSessionFileIcon` and the layout's `icon` prop were deleted), and a bare page of five lines
(too empty), before the per-kind marks. The fold is the sheet's top-right corner left unpainted, so the tray shows through whatever
tint it has taken (hover, failed), with a flap in the remaining half; it is three background layers
rather than a `clip-path`, because a clip would cut the shadow. The sheet is sized in `captionSize`
units so it follows Appearance. The two-line body gives a long status ("Uploading from <machine>…",
"File expired · size") the room the one-line strip had to share with the name. Props of
`SessionFileCardLayout` and the exported action class are unchanged, so the pending-attachment row and
the HTML source-download button need no edits. Rejected for this round: a per-file generated cover
(unique tonal art seeded from the hash), which was the recommended option; the person chose the sheet.
It would also have been a colour per file in spirit, which the earlier rounds rule out.

Not verified for round four: this environment has no Node, so nothing was typechecked, formatted, run or
rendered. The risks are visual and specific: the cut corner leaves the sheet's 0.5px shadow ring drawn
around the missing triangle (the ring follows the box), the one-pixel overlap of the background layers may
show a seam at some Appearance sizes, the card is about 53px against 44px and may outweigh the answer in
a turn with several files, and the dark theme separates sheet and tray by only the step between
`raisedBackground` and `secondaryBackground`. Look at the `SessionFileCard` stories (including
`LongNameAndStatus`) and the pending attachment row in light and dark at all five sizes before merging.

**The composer info bar.** `sessions/info-bar-type.ts` exports two class strings over the footnote and body roles.
`info-chip.tsx`, `session-info-chips.tsx` and `session-info-bar.tsx` use them in place of
`text-xs`, `text-sm`, `leading-snug` and four `text-[11px]`. At the Default size the 12px text is
unchanged; the CI pill, diff totals and goal meta grow from 11px to 12px; the goal objective's
leading goes from about 19px to 20px; the uppercase goal label goes from 600 to 500. All of it now
follows Appearance. Colour, spacing, heights and behaviour are unchanged.

## Alternatives

- **Extend `interface-typography.md` instead of a new Spec.** That Spec is about scale and
  persistence; tiers are a separate, reviewable decision. It links both ways instead.
- **Pilot only on the chrome.** The first pass did this and changed almost nothing a reader
  would see; the turn is where the hierarchy lives, so the pilot now includes it.
- **Migrate every ink fraction.** Deferred. In the product palette `label`, `secondaryLabel` and
  `tertiaryLabel` are `foreground`, `muted-foreground` and `muted-foreground` mixed 30% toward the
  background, so `/70` text maps to `tertiaryLabel` closely (an earlier draft of this note said the
  mapping was not value-neutral; that was wrong). What stops a wholesale migration is that the 54
  uses mix text with icon and divider opacity that rule 3 should not touch.

## Premises not established

The tier table is my reading of the code, not a reviewed design. The audit counts class usage,
which shows inconsistency rather than a harder page to scan, and it over-counts the session page.
Three Specs already cover scale, rhythm and menu weight, so a reviewer may reasonably decide the
fixes are conformance and the mapping Spec is unneeded. Prose also guards nothing: extending
`tests/e2e/interface-typography.spec.ts` to assert computed chip, card and label sizes at the five
tiers would, and a source-grep test would not (the repository deletes those).

## Verification limits

Not run: this environment has only darwin binaries and no Node or pnpm, so there was no
`pnpm check`, `pnpm format`, test run, Storybook or `pnpm run docs` check. Oxfmt may reflow the
edited `className={cn(...)}` sites. Before merge: run `pnpm check` and `pnpm format`, run
`session-info-context-actions.test.tsx`, `assistant-edited-files.test.tsx` and
`session-file-card.test.tsx`, and look at the `SessionInfoBar`, `AssistantEditedFiles`,
`SessionFileCard` and `SessionConversationPage` stories in light and dark at the Smaller and Larger
sizes, with a long branch name and a long directory. Check two things by eye: the 12px info-bar
pill text is about 9% wider, and the edited-files "Show more" hover colour, because a Tailwind hover
class and a StyleX base colour share that element and the repository says Tailwind wins.
The file card was only rendered as a standalone mock reproducing its token values, never as the real
component; the StyleX `when.ancestor` hover and the fixed 40px tag at the five Appearance sizes are
unexercised. Check the `SessionFileCard` stories (including `IconsByExtension`, now with `Dockerfile` and
`analysis.ipynb`) and the pending attachment row in light and dark at all five sizes, with a long file
name and a long upload status, and tab to a card to see its focus ring. The light tint is faint by
design; if it vanishes on a real display, that is the first thing to revisit.
The Spec's audit counts come from `grep` over `sessions/`, `ai-gui/` and `chat/`, and `chat/`
includes landing and pairing screens that are not on the session page.
