# Workspace visual hierarchy

Status: draft
Translation: stale

[中文](workspace-visual-hierarchy.zh.md)

## Abstract

[Interface typography](interface-typography.md) fixes the size roles and
[Conversation rhythm](conversation-rhythm.md) fixes the spacing; neither says which
content takes which role, ink and weight. On the session page, the busiest surface
in the product, that choice is made per component, and it has drifted. This draft
names five content tiers for a coding-agent workspace and five rules that bind
them. It adds no font, size scale or token family. The composer info bar is the
pilot; the rest of the page is measured but not migrated. Nothing here is approved.

## Scenario

A person returns to a session after the agent has worked for ten minutes. They need
the answer first, then what changed and whether it passed, then, only if something
looks wrong, what the agent did to get there. Hierarchy is the order in which the
page lets them find those things without reading all of it.

## Tiers

Each tier maps a kind of content to roles that already exist. A surface picks the
tier; it does not pick a size, a gray or a weight.

| Tier     | Content                                            | Role                                            | Ink                                | Weight           |
| -------- | -------------------------------------------------- | ----------------------------------------------- | ---------------------------------- | ---------------- |
| Reading  | User message, agent answer                         | body, reading leading                           | `reading`                          | 400              |
| Evidence | Edited files, plan, PR and CI verdict, diff totals | subheadline                                     | `label`; hue only for an outcome   | 500 for the name |
| Process  | Thinking, tool calls, progress                     | subheadline                                     | `secondaryLabel`                   | 400              |
| Metadata | Time, duration, model, author                      | caption in the conversation, footnote elsewhere | `secondaryLabel`                   | 400              |
| Chrome   | Tabs, info bar, composer controls                  | footnote or subheadline                         | `secondaryLabel`, `label` on hover | 500 for controls |

Only the Reading tier sits at full reading ink, which the dark theme already holds
above other text. Evidence is the one tier that may carry a hue, because a hue
there reports an outcome, not an action.

## Rules

1. **Every size is a role.** No Tailwind size utility and no fixed pixel value on
   product text. This is already the interface-typography rule; the audit below
   shows it is not yet true on this page.
2. **Neighbours differ twice.** Two roles one pixel apart may share a card or row
   only if their ink or weight also differs, as the sidebar's 13px rows and 12px
   group labels do. A caption (11) beside a footnote (12) differs by nothing else,
   so the sidebar dropped its caption and the info bar follows.
3. **Three inks.** `label`, `secondaryLabel`, `tertiaryLabel`, plus reading above
   them. A fraction of foreground (`/70`, `/85`) is not a fourth ink.
4. **Weight names the thing, not its state.** 400 for prose, process and menu
   labels; 500 for names, labels and controls; chrome never exceeds 500. State is
   shown by a glyph or the accent, as for a pinned conversation.
5. **Spend emphasis once per row.** A row marks its state by one of position, an
   ink step or the accent, not by stacking weight and hue.

## Pilot

Two zones of the session page, one at each end of the hierarchy.

**The turn's Evidence tier.** The edited-files card and the file card named their
files at the reading size (14px, regular, `foreground/90`), so the card competed
with the answer above it. A name is now the subheadline role at 500 in `label` ink;
a directory is `tertiaryLabel`; a subtitle, a count and the card's caption are
footnotes; the diff counts keep their hue. In the process tier, the thinking label,
the plan label and a tool title outside the timeline drop from 600 to 500, and the
running tool verb's `foreground/90` becomes `label`. These are the visible changes.

**The file card.** It was redesigned, not restyled, and the design has been through four rounds. The
first two were rejected: a sheet of paper in a tray inside a bordered card (three concentric outlines,
then, with the outlines removed, still six things competing for the eye), so the card outweighed the
answer above it. The third was one 44px line on a single tint with no outline or shadow. The current
card (a fourth round, requested as a softer, more crafted object) returns to a sheet, but holds the
count: one tinted tray with no outline or shadow, one paper sheet that carries the only shadow and a
folded corner and nothing printed on it, the name as the only line at full ink, the type and size or the status
beneath, and the action. Evidence still rests under the answer rather than standing up from the page;
the sheet is what makes it a deliverable rather than a row. Colour stays reserved for outcomes.

**The composer info bar.** It had 12px chips, 11px pills, a 14px prose popover and an
uppercase 11px semibold label. It now uses the footnote role throughout and the body
role only for a goal's objective. At the Default size its 12px text is unchanged; the
CI pill, diff totals and goal meta grow from 11px to 12px; and it follows Appearance.

Reading prose, spacing, heights, structure and behaviour are untouched.

## Premises not established

- **The tiers are inferred from code.** No one has reviewed the rendered page against
  them. The audit counts class usage, which shows inconsistency, not that a reader
  finds the page harder to scan.
- **The audit over-counts the page.** `chat/` includes the landing and pairing
  screens, and some of the 54 ink fractions are icon or divider opacity.
- **Existing Specs may already be enough.** The roles, the rhythm and the menu weight
  are specified. This draft earns its place only if reviewers want the content-to-role
  mapping written down; if not, the fixes stand alone as conformance with
  [Interface typography](interface-typography.md).
- **The file card's weight is untested.** The fourth round is taller (about 53px, up from 44) and adds a
  sheet, which is the direction the third round's rejection warned against. Whether it still sits under the
  answer, or competes with it in a turn with several files, has not been looked at; nothing was rendered.
  The edited-files card and the tool detail sheet have not been compared against it.
- **Prose is not a guard.** Nothing here stops the next `text-xs`. A browser check of
  computed sizes at the five tiers, extending the existing regression, would.

## Audit

Counted in `components/{sessions,ai-gui,chat}` before the pilot:

- 164 product-text sizes ignore Appearance: 116 `text-xs`, `text-sm` or `text-base`
  and 48 arbitrary values (27 `text-[11px]`, 11 `text-[10px]`).
- 54 ink fractions across 12 distinct values, against three inks.
- Weights: 79 `font-medium`, 14 `font-semibold`, 11 `font-normal`.

## Unresolved

- Which of the 54 ink fractions are text, and which are icon or divider opacity
  that rule 3 should leave alone. In the product palette `label`, `secondaryLabel`
  and `tertiaryLabel` are `foreground`, `muted-foreground` and `muted-foreground`
  mixed 30% toward the background, so `/70` text maps to `tertiaryLabel` closely.
- Whether `tertiaryLabel` is legible enough for a directory path; it is the old `/70`.
- Whether any chrome keeps 600; 14 uses and 6 `@lody/ui` declarations are unreviewed.
- Whether Evidence names should be `label` ink everywhere, including Markdown file links.
- Mobile: no mobile surface was audited.

## Evidence

- Intended: this document, on top of the two Specs above.
- Inspected: [evidence surface](../packages/components/src/components/ai-gui/surface.ts),
  [info bar type](../packages/components/src/components/sessions/info-bar-type.ts),
  [role tokens](../packages/ui/src/tokens/scales.stylex.ts),
  [sidebar precedent](../.agents/notes/implemented/feature/2026-10-16-interface-latin-font-first.md).
- Executed: nothing. The environment had no Node, so no typecheck, test or visual check ran.
- Decision: [workspace hierarchy note](../.agents/notes/proposed/architecture/2026-10-16-workspace-visual-hierarchy.md).
