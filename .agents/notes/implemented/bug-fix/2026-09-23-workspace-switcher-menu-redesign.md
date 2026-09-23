# Workspace switcher menu: one row system, no bespoke card

Status: implemented
Translation: current

[中文](2026-09-23-workspace-switcher-menu-redesign.zh.md)

## Abstract

The workspace-switcher dropdown stacked four unrelated geometries: menu
labels at `px-2`, action icons at `px-2`, radio rows' `ps-8` selection
indent pushing an embedded avatar plus name to a third column, and a
hand-padded current-workspace card that duplicated the checked radio row
with different metrics — so the popover read as misaligned and the card
read as foreign. The redesign deletes the card entirely: the menu is now
one uniform row system (email label, workspace radio list, action rows)
where every row shares a 20px leading box and one text column. The card's
unique information — plan and member count — moved onto the current
workspace's own radio row as trailing muted text, so the checked row is
also the most informative. `DropdownMenuRadioItem` gained an
`indicatorSide` option to move the check to the trailing edge when the
leading slot already carries an identity mark.

## Decision

`loro-sidebar.tsx`'s switcher menu:

- The `data-current-workspace` card and its separator are removed. The
  checked radio row already identified the current workspace; the card
  only added "Plus Plan · 3 members", which now renders as muted trailing
  text on that same row (`workspace.switcher.plan` / `.planAndMembers`
  i18n keys unchanged). Other rows keep their planTier badge.
- Radio rows keep the leading `WorkspaceAvatar` and switch to
  `gap-1.5 ps-2 pe-8` with `indicator="check" indicatorSide="end"`: the
  avatar aligns with the action rows' icon boxes, `pe-8` reserves the
  trailing check zone so badges/plan text never slide under it.
- `DropdownMenuRadioItem` (shared `ui/dropdown-menu.tsx`) accepts
  `indicatorSide?: 'start' | 'end'` — default `start`, so every other
  menu is untouched. This extends the primitive instead of a private
  override, per `src/ui/AGENTS.md`.
- Action rows wrap their glyph in a 20px `h-5 w-5` flex box with
  `gap-1.5`, giving radio and action rows an identical leading column at
  `px-2` and one text column.
- The "Switch workspace" group label stays: after removing the card it
  is the section anchor for the radio group.

Rejected alternatives: keeping the card but re-styling it (still a
second geometry for duplicated information); dropping avatars (implemented
first, rejected on review — avatar is the workspace identity); check
leading beside the avatar (recreates the three-column zigzag); aligning
text to the card's 56px column (pushes every row deeper).

### Reverted companion change

An "inner cohesion, outer separation" fix for the Updated session list
was implemented alongside this — a `separated` prop on
`SessionOpenedByTreeRow` adding `mt-1.5` at tree-group boundaries in
`sidebar-updated-session-list.tsx` and `session-list.tsx`. It was
reverted on review before landing: the list keeps its uniform `gap-px`
rhythm. The investigation stands — the perceived inconsistency there is
two-line parent rows vs one-line child rows at equal gaps, not unequal
spacing — but the spacing change was judged unnecessary.

## Verification

Storybook (`Components/LodySidebar`, dark) rendered before/after: the
menu is now uniform — avatars and action icons share one leading column,
all labels share one text column, and the current row shows
"Plus Plan · 3 members" with the check at the trailing edge. `tsgo
--noEmit`, `oxlint`, and `oxfmt` are clean on the touched files;
opened-by tree tests pass (the revert restores the original code path).
Not verified: radio select / context-menu / modifier-click interactions
run through unchanged handlers; multi-account (email label) and
free-plan variants were reasoned, not rendered.
