# The composer's `@`, `/` and `$` menu on the v2 popup surface

Status: implemented
Translation: current

[中文版](2026-09-25-composer-mention-menu-v2.zh.md)

## Abstract

The menu that opens while typing `@`, `/` or `$` in the composer was the one
floating list the v2 migration had missed: a 1px border, shadcn's small shadow,
uppercase group headings, full file paths in a monospace face, and a detail pane
held open at a fixed 320px under a two-row list. It now stands on `@lody/ui`'s
popup surface — the raised fill, the popover shadow, 14px corners, 28px rows and
the 6% ink highlight — restated in StyleX from semantic tokens, on desktop and on
the docked mobile strip alike. Rows became one line that carries more: a file
reads as its name then its folder, a command as its name then its description,
and a first-level category shows the key that opens it directly (`$`, `/`). The
behaviour of the mention primitive (triggers, keyboard, insertion, ranges) is
unchanged.

## What changed

**Surface.** `src/ui/mention/mention-surface.ts` holds the surface, the row, the
highlight and the entrance. `@lody/ui` keeps its `popup` token group internal,
so the values are restated from the semantic tokens they resolve to, the way
`components/shared/composer-surface.ts` already does for the composer's other
lists. Desktop `MentionContent`, the mobile `MentionMobilePanel` and every row
read it; nothing in the menu is Tailwind any more. StyleX cannot select
`data-highlighted`, so `ui/mention.tsx` derives the highlight from the mention
context's `highlightedItem.value`. The entrance is the popup rise: 4px further
from the caret, into place over `duration.regular`. The direction comes from the
side floating-ui resolved (`--mention-rise`), because a composer near the bottom
of the window opens the menu above the caret.

**Rows.** A row is one line: glyph, `title`, then a quiet `hint` that gives way
first, then trailing metadata (`#3312`, a shortcut's scope). `MentionCandidate`
gained `hint`; `subtitle` is now only the second line that explains why a row
cannot be picked (a Role's availability). File candidates split their token into
`title` (the name, with `/` on a directory) and `hint` (the folder) — the thing a
person scans for comes first, and the folder tells two `index.ts` apart. The
committed text is still the whole `@path`. Commands and prompt shortcuts put
their description in `hint`, so a `/` list is one line per command instead of
two. Disabled rows mute their words rather than the whole row, because the
reason they carry must stay legible.

**Levels.** Group headings are sentence case at the caption step, like the
product menus in `ui/menu-styles.ts`. A second level names itself: reached
through `@`, the heading is a ghost `Button` reading "‹ Skills" and is the way
back; reached through its own trigger it is only a heading. The Sessions scope
switch is a `@lody/ui` `ToggleGroup`. Loading shows a `Spinner`; an error is in
the destructive colour. A first-level category row shows its `directTrigger`
as a trailing key, teaching the shortcut where it is used.

**Detail pane.** The pane sits beside the rows on the same surface behind the
separator colour, and takes the height its content needs up to the list's cap
instead of a fixed 320px. The menu is a size container and the pane is hidden
below 480px: in a narrow composer the old fixed 248px pane squeezed the list to
nothing, which the real floating story reproduced. The Agent Role pane is still
`AgentRoleDetailPane`, shared with the composer's Role submenu, and is left as
it was.

**Mobile.** The docked strip is the only scroller. The menu used to rely on a
global `.mention-mobile-panel .scrollbar-pro` override to flatten its own list;
it now receives `docked` and drops its scroller, and the CSS rule is gone.

## Second pass: rows that say more, motion that says where

Asked to make it better, the second pass added only what carries information:

- **Matched letters are lit.** While a term is typed, a title's matched letters
  take the ink at weight 650 and the rest step back to the secondary label, so
  each row answers "why is this here?". The positions come from the same VS Code
  `scoreFuzzy` the sources rank with (`matchedRuns`). A path term is matched by
  its last segment, because a file row's title is the name alone. A row whose
  title is not where the term matched (an issue found by its number, a file found
  by its folder) keeps its title whole rather than dimming with nothing lit.
- **Rows state what only they know.** A session shows when it was last active
  (`12m`, `3d`) from a new `activityAt`, formatted against the shared
  `useStableNow` clock so the registry stays free of `Date.now()`. A Role's
  `hint` is its agent and machine (`Codex · Studio`), which tells two same-named
  Roles apart without opening the pane. A folder carries a chevron, because
  selecting it opens it rather than inserting it.
- **Motion says which way you went.** Entering a category slides its level in
  from the trailing edge; going back brings the level above in from the leading
  edge. Retyping within a level never replays it (verified by reading
  `document.getAnimations()` in Chromium after Tab, Backspace and typing), and
  `prefers-reduced-motion` turns it off.

Rejected in this pass: counts on first-level categories (the owner has called
count pills cheap, and counting would activate lazy sources the first level must
not start); a sliding highlight (the popup rows deliberately take no transition,
so the fill never lags the keyboard); ghost text previewing the insertion in the
composer (it would touch the mirror and caret contract for a small gain).

## Design review round 2

A critique in the real desktop app, not Storybook, found what the stories hid.
This section supersedes the placement and detail-pane sizing described above.

- **Placement.** The menu took `MentionContent`'s defaults: anchored to the
  caret line, `side: 'bottom'`, and floating-ui's `flip` re-run on every resize.
  The two-row first level fit below the caret inside the composer, over its
  toolbar; the second level did not, so it flipped above the caret line, onto the
  chip row, starting at the caret's x and leaving a chip fragment beside it.
  `positionAnchor="composer"` anchors to the composer's `[data-mention-frame]`
  (chip row and box, marked in `ChatComposer`), left-aligned, 8px away. The side
  is chosen once per open (above unless there is no room) and never flips; the
  height is capped to that side's room instead, so a level change resizes the
  menu where it stands.
- **Proportions.** The list takes the narrow column (about 220px) and the detail
  the wide one (300px) in a 536px menu. The pane fills the height the list sets,
  down to a 168px floor, and scrolls inside it; the description is clamped to
  five lines at 12/18. The Role pane takes the same column.
- **Pane content.** The heading was missing in the app because the pane was a
  scrolling flex column and the heading, being `overflow: hidden`, shrank to
  nothing under a long description. Parts no longer shrink, and a pane without a
  title is headed by the row's. Scope and version are one quiet line, not
  badges; a path stays on one line and gives way in its middle.
- **Glyphs.** A row drops a glyph that only repeats its level's heading (the
  skill glyph under "Skills"). A file's type, a folder and a Role's emoji stay;
  rows without a mark keep an empty box only where a neighbour has one.
- **Filtering.** `@skill:sy` kept all six system skills because a skill matched
  its whole path, and `sy` is in `~/.codex/skills/.system`. A skill now matches
  its path only below its skills directory. A term that matches nothing shows
  "Nothing matches “sy”" at every level, never the unfiltered list.
- **`/` on the home composer stays silent.** `/` is registered only when
  commands or Prompt Shortcuts are available, as the
  [command-trigger draft](../../../../specs/command-mention-triggers.md) states,
  and the placeholder advertises `/` on the same rule. The E2E agent reports no
  commands and Prompt Shortcuts are a developer beta, so nothing opened. Showing
  an empty menu there would change that gate, which is the spec's call.
- **Verification.** `tests/mention-registry.test.ts` reproduces `@skill:sy` and
  `$sy` on the pure view; `tests/mention-two-level-menu.test.tsx` pins the
  locked side, the height cap and re-choosing on reopen, the no-match line, the
  dropped glyphs and the middle split. `FloatingInComposer`,
  `FloatingComposerAtTop`, `SkillCategorySystem` and `SkillNoMatch` stories
  cover the states; the E2E walk captured the home composer's `@`, second level,
  typed and `$` states in the packaged renderer, light and dark.

## Alternatives considered

- **Build the menu on `@lody/ui`'s `Combobox` or `Menu`.** Both own focus and
  open on a trigger; this menu is anchored to the caret of a textarea that keeps
  focus, and the mention primitive owns keyboard, insertion and ranges. Only the
  surface moved; the behaviour stayed where its contracts are documented.
- **The detail as a second floating card beside the list.** It would let each
  card take its own height, but the positioned element would have to be a
  transparent frame and the Role pane would need its own surface. One surface
  split by a line keeps the rung single and matches the ⌘K palette.
- **A keyboard-hint footer** like the ⌘K palette's. The menu is a transient
  list under the caret; a footer on every open is chrome, and the only
  non-obvious key (the direct trigger) is now shown on the row it applies to.

## Verification

- Storybook, light and dark, English and Chinese: every
  `Mentions/MentionTwoLevelMenu` state, and a new `FloatingAtCaret` story that
  mounts the real `MentionTwoLevelMenu` over a live textarea — typing `@`, `/`,
  `$` and `@role:` exercised placement above and below the caret, the highlight,
  the narrow-composer pane and the 390px docked mobile strip.
- `tests/mention-registry.test.ts` covers the name/folder split (nested, root
  and directory) and the command `hint`; `tests/mention-two-level-menu.test.tsx`
  asserts the detail pane is beside the rows rather than one of them;
  `tests/combined-mention-textarea-activation.test.tsx` finds file rows by the
  new name-then-folder text. The nine mention suites pass.
- The second pass adds `matchedRuns` unit tests, the session time and the
  folder chevron in `tests/mention-two-level-menu.test.tsx`, the session
  `activityAt` in `tests/mention-registry.test.ts`, and the Role `hint` in
  `tests/agent-role-mention-source.test.ts`.
- Not verified in the packaged Electron app or on a physical phone.
