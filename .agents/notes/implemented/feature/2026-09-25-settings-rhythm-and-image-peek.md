# Settings rhythm, the clipped card edge, and the composer image peek

Status: implemented
Translation: current

[中文版](2026-09-25-settings-rhythm-and-image-peek.zh.md)

## Abstract

The owner found desktop Settings cramped, messy and uncomfortable to read. Two
looser spacing passes were rejected as bloated; the real causes were type and
material. Settings text went as small as 9.8px at 1.25 leading, which closes up
Chinese; sizes compounded to 20.6px and 18px titles; weights 400/500/600 mixed
within a row; and every group was a white card on a white panel held apart only
by a shadow halo. Settings now has one type scale (a 12px floor, 1.45 leading,
two weights plus a semibold title) and a three-step material chosen from four
rendered variants: a nav, a neutral gray canvas, and white cards on it, split
by fill rather than lines. A fourth review found the real cause was content, not
material: one page frame, groups by meaning, fewer sentences, flat preferences
and boxed records. A card flush with the top of a scroller also lost its
top edge, which is fixed, and the composer's image lightbox became a popover
card that springs out of the thumbnail. Tooltips stopped inverting in the same
change; that reversal is recorded in the
[overlay primitives note](2026-09-12-ui-overlay-primitives.md).

## Settings type and material

**Why the type felt wrong.** The family is Inter (bundled) with the system CJK
face as fallback, or the person's chosen interface font; the family was not the
problem. Measured in Chromium at the default 14px: section and nav headings were
10.5px, helpers 11.2px, catalog meta 9.8px, labels and helpers at 1.25 leading.
The page title was 20.6px in the overlay (a `1.286em` inside the dialog's 16px
`h2`) and 18px on Projects. In one row a label was 14px, a button 13px and the
segmented control 12px. Weights mixed 400, 500 and 600, and Chinese falls back
to PingFang, whose Medium and Semibold are far heavier than Inter's, so a 600
heading read as a black block.

**The scale.** `settings/type.stylex.ts` computes every size from
`--ui-font-size` rather than `em`, so nothing compounds: `caption` (12px) is the
floor, `title` (18px) names a page, `leading` (1.45) sets anything that stacks.
Two weights: regular for labels, helpers and values, `headingWeight` (500) for a
section or group heading; `titleWeight` (600) only for a page's title. Controls
keep `@lody/ui`'s 13px/500, and the settings-local segmented control was moved
onto it. Row padding went from 10px to 8px where the leading grew.

**The material, chosen from four variants.** The owner asked for a zero-based
redesign learning from Notion. A flat document (headings on hairlines, ruled
rows, no cards) was built first and reviewed against three alternatives, each
rendered on four pages in both palettes: the flat document in the palette's cool
blue-gray; a gray canvas with white cards (macOS grouped settings); flat with
Notion's warm neutrals; and flat with a faint tray behind each group. The flat
versions read cold and too flat in light — white, a 97.5% blue-gray nav and
blue-gray hairlines are the only cues left — and they abandon the "slightly
physical" material the rest of `@lody/ui` is built on. The owner chose the gray
canvas with white cards. Three steps split the overlay by fill alone:
`surface.nav` (the page background mixed 6.5% toward black), `surface.canvas`
(the elevated fill mixed 3.5% toward black — a neutral gray in light) and
`surface.card` (the raised fill with the card rung's hairline and contact
shadow). Deriving the steps from tokens keeps them ordered in dark and in a
forced palette; the dark palette's `secondaryBackground` and
`elevatedBackground` are the same 8.6%, so the first flat version had no
nav/content split in dark at all. Row rules and the nav's hover and selected
rows are washes of ink, because the palette's `hoverFill` and `selectedFill` all
but vanish on the gray nav. The nav is 240px wide; at 208px it read cramped
beside the content. A later pass that made the nav the bare white panel, moved
the canvas under the page background and narrowed the column was rejected: it
changed fills nobody asked to change and broke the elevation ladder's order, so
it was reverted to the chosen steps.
A page's title uses `surface.pageTitle` in the same centred 760px column as its
content, and the Projects page dropped its 1152px column, a leftover of the old
two-pane layout.

The card rung's shadow (`shadow.card`) lost its lift. It was a hairline, a
contact shadow and `0 8px 24px -6px`; on a page of stacked settings cards the
wide blur drew a halo whose outline read as a second layer behind every block.
A card rests on the page, so it is now the hairline and a short contact shadow
only, in both palettes.

## The clipped card edge

A settings card has no border. Its edge is the first layer of `shadow.card`
(`0 0 0 0.5px`), and a scroller (`overflow: auto`) clips everything outside its
padding box. In the project window, `pageBody` scrolled with no top padding, so
a card that started the page lost its top edge. A local project hid the bug,
because its offline note came first; a GitHub project's first child is the card.
The scroller now has 4px of top padding, and the description above it gives up
the same amount. Before/after screenshots of the GitHub project window reproduce
and clear the defect.

## Composer image peek

Clicking a composer thumbnail opened a modal `Dialog` holding the image at up to
`max-w-3xl`, which covered the draft being written. `ComposerImagePeek`
(`components/chat/composer-image-peek.tsx`) replaces it with a `@lody/ui`
Popover anchored to the thumbnail. The card shows the image (at most 480×360,
bounded by the available space), the file name, and the natural size once it
has loaded. The size is the one thing the thumbnail cannot show.

It opens with a spring that grows the card from the thumbnail
(`--transform-origin`) with a small overshoot, and it closes with a plain 150ms
ease-out. The spring is the existing `springLinear` helper compiled to a CSS
`linear()` curve and passed through a custom property on the positioner. A CSS
transition keeps Base UI's close lifecycle working: Base UI waits on the
popup's running transitions before it unmounts. A Framer Motion spring would
have needed `keepMounted`, `AnimatePresence` and a raw Base UI popup outside
`@lody/ui`. `springLinear` samples 1.2s, so the open transition lasts 1.2s to
keep the curve's shape; the motion is visually settled after about 350ms.

## Second review: GitHub page, badges, sidebar menu, background tasks

**GitHub settings, redesigned from zero.** The page stacked gray boxes: a tinted
icon tile naming "GitHub App", a gray well inside a gray box holding only
`@login`, a book glyph on every repository, a scroll box inside the scrolling
page. It now answers its three questions on the surfaces that own them
(`github-settings-view.tsx`, a props-driven view with `Settings/GitHubSettings`
stories). The App row's helper is the installation's state ("3 of 5 repositories
enabled", "Not installed"), with Manage beside it. Switched on, the identity
row's helper names the account (avatar and `@login`) or turns to a warning with
Authorize beside the switch. Repositories are grouped by owner, one card each
with its own enabled count, and a row is the repository's name, a lock glyph
when private, and its switch. Search appears past five repositories. Empty,
loading and no-match states use the catalog's quiet region and card notes.
`GitHubPersonalIdentitySettingsCard` is now the mobile detail panel only.

**Badges.** The member role and machine sharing pills the owner asked about
were already `Badge`. The hand-rolled ones were elsewhere, in 18 places: the
sidebar's sync and mergeable pills, Worktree/Imported/Conflict/Draft chips, the
mobile member role, and several `Badge` callers that restyled it through
`className`. All are `Badge` now, with tones for state. A private repository is
a lock glyph rather than a badge, because a pill repeated on every row is noise.

**Sidebar view menu.** It had grown from about 196px to 254px tall. The
Popover's panel gap put 8px between every section, a group heading took a whole
28px row, and separators had 4px margins. The sidebar menu now overrides these
locally: no gap, 2px inset, a heading 6px above and 2px below its rows, and 2px
separator margins. That restores the measured 196px without changing other
popovers or `Menu.GroupLabel`.

**Background tasks.** The [flat material note](2026-09-23-ui-flat-material.md)
removed the group's card, and with it every state mark: finished rows had no
icon and sat a spinner's width left of running ones, and the header showed no
sign that the group was live. The owner reversed the flattening: tasks run
beside the turn rather than as one of its steps, and a reader waiting on them
needs one place to look. The group is a card again (a 1px separator edge over a
faint elevated fill, the pre-v2 look in `@lody/ui` tokens), its tasks are
full-width rows ruled apart and capped at 22rem with scrolling, and every line
leads with a 14px mark in one column: spinner, check, cross, or a dashed circle
for pending. The header shows a spinner while any task runs and its chevron once
all have settled. The time or state sits at the row's end. The peek popover
from the flat pass stays.

## Third review: focus rings and the command palette

**Focus rings follow keyboard navigation.** A dialog opened with the mouse and
closed with Escape handed focus back to its trigger, and Chromium matched
`:focus-visible` because the last input was a key — so a settings row lit up
with a 2px accent ring that nobody had navigated to. The owner called these rings
a visual obstacle when accessibility is not in use. `:focus-visible` cannot tell
navigation from action, so `@lody/ui` now tracks the modality itself
(`installFocusModality`, installed in `AppInitializer` and the Storybook
preview): Tab, and arrow keys outside text entry, mean `keyboard`; a pointer
press means `pointer`; Escape, Enter and Space do not change it. In pointer mode
it zeroes a new `focus.ringWidth` token, which every family's `ringWidth` and the
product's own StyleX rings now read, and publishes `data-focus-modality` on
`<html>` so the legacy Tailwind `focus-visible:ring-*` utilities and the shell's
fallback inset ring are gated too. Text entry keeps its ring. Rings that mark a
selected option rather than focus (a chosen onboarding row, a chosen share
swatch) keep a fixed width. Alternatives rejected: returning focus nowhere after
Escape loses a keyboard user's place; `focus({ focusVisible: false })` is not
implemented in Chromium. Verified in Chromium: without the tracker the button
handed focus after Escape draws `0 0 0 2px`; with it, `0px`; after Tab, 2px.

**Command palette.** The ⌘K palette was the legacy shadcn shell: a fixed
640px-tall panel mostly empty below a short list, the same ⌘ glyph in a gray tile
on every command, two gray key caps per row, and a footer of caps. Now it hangs
from a fixed top edge (so the input never moves) and takes the height of its
results. Each command's glyph names its action (`command-icons.ts`, keyed by id
because a built-in placeholder and the component registering the real command
share it); a command without one gets an empty column rather than a stand-in. A
conversation's glyph now distinguishes it from commands in a mixed search. With
no query the commands are grouped under their category; with one, the list stays
ordered by relevance. A shortcut is quiet trailing text like a menu's, and the
highlight is an ink wash driven by cmdk's controlled value so it can be StyleX.

## Fourth review: one frame, content first, flat preferences, boxed records

The owner found the page "all lines" and asked for the nav's mix toward black at
3.5% and for Linear's settings. At 3.5% the nav matches the old canvas, so the
content became the panel's own fill (`surface.canvas` is `elevatedBackground`);
the nav stays a step below it in both palettes.

**Material, three tries.** Linear's bordered trays with inset row rules were
rejected as not good-looking. Two flat variants followed (a rule above each
section only; and the same with inset rules between rows), and the owner picked
the first. On the GitHub page the owner then saw that some groups need a box and
some do not. The package rule already said so: "a list of records is one card
with ruled rows". So preferences (each row a question) are flat and records a
person manages (repositories, servers, roles, providers, projects, machines,
members, tokens, shares) keep a card. `settings/material.stylex.ts` holds a
group's drawing as variables whose defaults are the card; `settingsFlat` is the
theme the desktop pane and the project window apply, `settingsBoxed` puts a
records group back on its card (`CompactSection boxed`, `settingsRecordsCard`).
Mobile settings and settings dialogs are unchanged. A flat group's rows bleed
16px past the column so their copy meets the headings; the first section on a
page takes no rule, since the title opens it.

**Content was the real problem.** The owner asked whether the issue was density,
arrangement and needless description rather than boxes. Measured and read, it
was:

- Three page frames. Most pages had the pane's title; Projects, Agents and
  Machines drew their own (23px lower, a different inset, Agents 40px wider).
  Now the pane header names every page and holds its actions and one-line lead
  (`settings-page-header.tsx` portals `SettingsPageActions` / `SettingsPageLead`
  into it); no page draws its own title in the pane.
- Groups cut by component, not meaning: Preferences was 3 groups for 5 rows (7
  in the desktop app, with two one-row groups), Appearance 3 for 4. Preferences
  is now Conversations (queue behaviour, Open with, code-only line counts,
  notifications), This computer (local agent, daemon, launch at startup, hide
  window, prevent sleep), auto-archive, and Advanced (experimental, clear cache).
  Appearance is theme and language, Text (interface font, size, ligatures),
  Terminal, App icon.
- Helpers that repeated their label (launch at startup, hide window,
  experimental) are gone; long ones are one clause. Notifications speak only when
  something blocks them, instead of restating the switch. Prevent sleep gained
  the helper it lacked: it keeps the computer awake while Lody runs.
- About: version, channel, build date and commits are one row with the update
  check beside them; the two download rows are one row with two destinations.
- Catalogs (MCP, Agent Roles, Prompt Shortcuts): the add action moved into the
  page header, a section heading that repeated the page title went, the empty
  state no longer repeats the add button, and a private record is no longer
  badged on every row (only shared ones are).
- Projects: a machine or GitHub owner section is titled by its name with its
  state underneath; GitHub rows no longer repeat the owner. The project window
  dropped the Machine and Visibility rows its header already states, and the
  General, Worktree and Skills leads that restated their tabs; a pending removal
  is said on the Delete row.

Row padding, section gaps and the type scale are unchanged.

**A detour: the material came back, then went again.** After the owner said the
flat version had "killed the highlight material", cards on a 2% canvas were
rendered with full-width and inset row rules. The owner chose to keep the flat
preferences with boxed records after all.

**Agents, redesigned.** The desktop Agents tab used the providers' roomy mobile
density (`variant="list"`): 56px rows, a 32px icon tile, and the rate-limit
meters hidden, since only the compact row shows them. The pane now draws the
compact row (`MachineProvidersSection bare`): a 24px glyph, 8px block padding,
and the meters beside the name. Refresh and delete appear only under the pointer
or keyboard focus, laid over the row's end on its hover fill, so a list at rest
shows what is true of each provider and reaches the edge (kept in the flow while
hidden, they left an empty band the owner spotted). The machine pills became the page's tabs under its title
(`SettingsLineTabs`, the project window's sliding-line tabs made shared), shown
only when there is more than one machine; "Add provider" sits in the page header.
A header Select was tried first and rejected.
The "Agent Provider" heading that repeated the page is gone.

Compacted, a machine with two or three providers left the page mostly empty.
The space is now filled with facts the renderer already holds, not decoration.
A provider's second line names its default model (from the cached capabilities
the composer reads; a model the runtime calls "default" is left out), how many
open conversations on this machine use it and when one last moved (from the
session index in memory), and its environment variable count. A list of what the machine could still add
was tried under every list and rejected: the owner wants it only when the
machine has nothing. An empty machine's page is a quiet line, "No agents on {machine} yet",
over the onboarding's wall of agent marks as pills, each opening the add dialog
already on that agent (`listAddableProviders` in `agent-config-dialog.tsx`;
experimental runtimes, registry agents and custom commands stay behind the
dialog's rail). A bare heading read as hand-typed and an arc of raised discs as
cheap; of three rendered alternatives (a line icon over a two-column list, the
wall, the list alone) the owner chose the wall.

With many machines the tabs keep to one row: those that fit are tabs, the rest
sit behind a last "N more" tab whose menu gains a search field past eight, and
the current machine always holds a place in the row. Every tab is laid out once
out of sight to know how many fit, and the travelling line re-measures when a
tab's width changes after its font loads.

**A rule halfway between sections.** On About the space above a section rule was
the page gap plus the row's padding (32px) and below it 24px, so the two rules
sat off-centre. Inside `settingsFlat` the page gap is now 16px, a rule is followed
by 16px before a headless section's first row and by 24px before a heading, and a
records card stands 8px further off. Text sits about 24px from the rule on both
sides.

## Verification

- Storybook screenshots before and after, in Chinese, for the preferences
  overlay, the account page inside `data-settings-surface`, both project windows,
  the sidebar tooltip in both palettes, and the composer peek, including a frame
  captured partway through the spring.
- `tests/chat-composer-focus.test.tsx` covers the peek: clicking a thumbnail
  opens a non-modal card holding the image and its name, and Escape closes it.
- `Chat/ChatComposer` stories could not render on `main`: the add menu reads
  cloud queries, and the stories had no platform. They now use the settings
  story providers.
- `tests/github-settings-view.test.tsx` covers owner grouping, the summary, a
  toggle, search, and a member's read-only list.
- `packages/ui/test/focus-modality.test.tsx` covers the modality switches, and
  `tests/command-palette-view.test.tsx` covers group headings, arrow-key
  highlight, Enter, and the empty state.
- Fourth review: the settings overlay in both palettes, in Chinese, with the
  desktop-app sections forced on (Preferences, Appearance, MCP, Agent Roles,
  Keyboard Shortcuts, About), and Projects, Agents providers and Account rows from
  their data stories inside the pane frame. The title and first content now sit
  at the same place on every page (measured). The material study, outside
  `settingsFlat`, still draws cards.
- Not verified in the packaged Electron app. Storybook renders the same
  components, but outside the app shell.
